// Shell snippets for the RLY-4 scripted parent (cli-operator.test.ts), kept apart so rly4-spawn.test.ts can run them under `sh` against a fake `pomtree`.
// On a loaded runner `pomtree spawn` can hit the CLI's response timeout (exit 6) although the daemon created the child, and then prints no id.
// The snippet retries such a call with the same --key, which the daemon resolves to the existing child. Exit 5 (the intended refusal) is never retried.
export const SPAWN_ATTEMPTS = 3;
export const EXIT_REFUSED = 5;
export const EXIT_TRANSPORT = 6;

export function spawnKidCmd(n: number, o: { budget: number; model: string; dir?: string }): string {
  const dir = o.dir ?? "/tmp";
  const kid = `${dir}/kid${n}`;
  const spawn = `pomtree spawn --task '[[scn:rly4kid]] finish at once ${n}' --name kid${n} --budget ${o.budget} --model ${o.model} --key rly4-kid${n} > ${kid} 2> ${dir}/err${n}`;
  const again = `[ $rc -eq ${EXIT_TRANSPORT} ] || { [ $rc -eq 0 ] && [ ! -s ${kid} ]; }`;
  return `for a in ${Array.from({ length: SPAWN_ATTEMPTS }, (_, i) => i + 1).join(" ")}; do ${spawn}; rc=$?; ${again} || break; done; echo SPAWN${n}=$rc; echo ERR${n}=$(cat ${dir}/err${n})`;
}

// A failed capture is loud: REAPED<n> names the missing id instead of running `pomtree wait` with no argument.
export function waitReapCmd(n: number, dir = "/tmp"): string {
  const kid = `${dir}/kid${n}`;
  return `if [ -s ${kid} ]; then for i in 1 2 3 4 5 6 7 8; do pomtree wait $(cat ${kid}) --timeout 15000 && break; done; pomtree reap $(cat ${kid}) > /dev/null; echo REAPED${n}=$?; else echo REAPED${n}=missing-id-kid${n}; fi`;
}
