// This fixed program runs in the container, never against its clone on the host. Its output is
// one bounded JSON header followed by optional raw bundle bytes; stderr carries errors only. Its byte cap is opts.maxBytes (the
// resolved push.maxBytes), which it refuses unless a safe integer of at least 1. Git's stdout buffer is the cap but never below
// 1 MiB, so a small cap still lets the metadata commands (rev-parse, status) through and refuses only the collected work.
export const RESULT_WORK_SCRIPT = String.raw`
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {createHash} = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const opts = JSON.parse(process.argv[1]);
if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1) {
  process.stderr.write('maxBytes must be a safe integer of at least 1\n');
  process.exit(1);
}
const cap = opts.maxBytes;
const buffer = Math.max(cap, 1024 * 1024);
const deadline = Date.now() + 120000;
// safe.directory is scoped to this one path (the working directory, /work in the container) and passed on the command line, the only
// place besides system and global config that git honours it; never '*'. It is needed because the bind-mounted workspace is owned by the
// host uid, which can differ from the container user, and git refuses a repository it does not own. This does not weaken the invariant
// that git never runs on unsanitised agent-written repo config: that invariant protects the host's git, and this git runs only inside
// the agent's own sandbox on that agent's own clone, where the agent could already run any command. The hooks, fsmonitor and signing
// overrides below stay on.
const config = ['-c','safe.directory='+process.cwd(),'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false'];
function git(args) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('workspace collection timed out');
  const r = spawnSync('git', [...config,...args], {timeout:remaining,maxBuffer:buffer});
  if (r.error || r.status !== 0) throw new Error('workspace git '+args[0]+' failed: '+(r.error?.message || r.stderr.toString().slice(0,2000)));
  return r.stdout;
}
(async () => {
  let dir;
  try {
    const status = git(['status','--porcelain=v1','-z','--untracked-files=all']);
    const dirty = status.length > 0;
    const hash = createHash('sha256').update(git(['rev-parse','HEAD'])).update(status).update(git(['diff','HEAD','--binary','--no-ext-diff','--no-textconv'])).update(git(['diff','--cached','--binary','--no-ext-diff','--no-textconv']));
    let bytes = 0;
    for (const entry of status.toString().split('\0')) {
      if (!entry.startsWith('?? ')) continue;
      const path = entry.slice(3);
      const st = fs.lstatSync(path);
      bytes += st.size;
      if (bytes > cap) throw new Error('uncommitted work exceeds collection limit');
      hash.update(path).update('\0').update(st.isSymbolicLink() ? fs.readlinkSync(path) : fs.readFileSync(path));
    }
    const fingerprint = hash.digest('hex');
    if (!opts.save || opts.expectedFingerprint !== fingerprint) {
      process.stdout.write(JSON.stringify({dirty,fingerprint})+'\n');
      return;
    }
    if (dirty) {
      git(['add','-A','--','.']);
      git(['commit','-m','Save remaining work before reporting result']);
    }
    const base = process.env.POMTREE_BASE_COMMIT;
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base || '')) throw new Error('POMTREE_BASE_COMMIT is missing or invalid');
    const branch = git(['symbolic-ref','--short','-q','HEAD']).toString().trim();
    dir = fs.mkdtempSync(join(tmpdir(),'pomtree-result-'));
    const file = join(dir,'result.bundle');
    git(['bundle','create',file,'refs/heads/'+branch,'^'+base]);
    if (fs.statSync(file).size > cap) throw new Error('result bundle exceeds collection limit');
    process.stdout.write(JSON.stringify({dirty:false,fingerprint,bundle:true})+'\n');
    await pipeline(fs.createReadStream(file),process.stdout);
  } finally {
    if (dir) fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(e => { process.stderr.write(e.message+'\n'); process.exitCode=1; });
`;
