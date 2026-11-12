import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KubeAuthError, type KubeFs, fileAuth, inClusterAuth, nodeKubeFs } from "./auth.ts";

const TOKEN = "tok-PLANTED-0123456789abcdef";
const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const PEM = (name: string) => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----\n`;
const KEYPEM = "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n";
const b64 = (s: string) => Buffer.from(s).toString("base64");

// An in-memory filesystem: path -> content and mode. A missing path throws ENOENT like the real one.
function memFs(files: Record<string, { content: string; mode?: number }>): KubeFs & { files: typeof files } {
  return {
    files,
    read(path) {
      const f = files[path];
      if (f === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
      return { content: f.content, mode: f.mode ?? 0o100600 };
    },
  };
}

const kubeconfig = (over: { cluster?: object; user?: object; context?: object; top?: object } = {}) =>
  JSON.stringify({
    "current-context": "c",
    contexts: [{ name: "c", context: { cluster: "k", user: "u", namespace: "ctx-ns", ...over.context } }],
    clusters: [{ name: "k", cluster: { server: "https://10.0.0.1:6443", "certificate-authority-data": b64(PEM("ca")), ...over.cluster } }],
    users: [{ name: "u", user: { token: TOKEN, ...over.user } }],
    ...over.top,
  });

const KC = "/etc/pomtree/kubeconfig";
const fileOf = (text: string, fs = memFs({ [KC]: { content: text } })) => fileAuth({ path: KC, fs });

function refused(fn: () => unknown, ...needles: RegExp[]) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof KubeAuthError, String(e));
    for (const n of needles) assert.match(e.message, n);
    assert.ok(!e.message.includes(TOKEN), "a token never appears in a message");
    return true;
  });
}

// ---- in-cluster ----

const ENV = { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" };
const saFs = (token = `${TOKEN}\n`, mode = 0o100400) =>
  memFs({
    [`${SA}/token`]: { content: token, mode },
    [`${SA}/ca.crt`]: { content: PEM("cluster"), mode: 0o100644 },
    [`${SA}/namespace`]: { content: "pomtree-sandboxes\n", mode: 0o100644 },
  });

test("in-cluster: reads the standard service account paths through the injected fs", () => {
  const fs = saFs();
  const auth = inClusterAuth({ env: ENV, fs });
  assert.deepEqual(auth.read(), { baseUrl: "https://10.96.0.1:443", ca: PEM("cluster"), token: TOKEN, namespace: "pomtree-sandboxes" });
  assert.equal(auth.describe, `${SA}/token`);
});

test("in-cluster: the token is re-read on every call, so a rotated projected token is picked up", () => {
  const fs = saFs();
  const auth = inClusterAuth({ env: ENV, fs });
  assert.equal(auth.read().token, TOKEN);
  fs.files[`${SA}/token`] = { content: "tok-ROTATED-fedcba9876543210", mode: 0o100400 };
  assert.equal(auth.read().token, "tok-ROTATED-fedcba9876543210");
});

test("in-cluster: the kubelet's default 0644 and the fsGroup 0440 token are accepted, a non-regular file is refused, and an explicit tokenFile at 0644 is still refused", () => {
  for (const mode of [0o100644, 0o100640, 0o100440, 0o100400])
    assert.equal(inClusterAuth({ env: ENV, fs: saFs(TOKEN, mode) }).read().token, TOKEN, mode.toString(8));
  refused(() => inClusterAuth({ env: ENV, fs: saFs(TOKEN, 0o040755) }).read(), /not a regular file/);
  const fs = memFs({ [KC]: { content: kubeconfig({ user: { token: undefined, tokenFile: "/run/t" } }) }, "/run/t": { content: TOKEN, mode: 0o100644 } });
  refused(() => fileOf("", fs).read(), /readable by group\/other/, /chmod 600/);
});

test("in-cluster: outside a pod, an empty or multi-line token and a missing file each name the cause and the action", () => {
  refused(() => inClusterAuth({ env: {}, fs: saFs() }), /KUBERNETES_SERVICE_HOST is not set/, /kubeconfig/);
  refused(() => inClusterAuth({ env: ENV, fs: saFs("\n") }).read(), /is empty/, /write/);
  refused(() => inClusterAuth({ env: ENV, fs: saFs("a b\nc") }).read(), /more than one line/);
  refused(() => inClusterAuth({ env: ENV, fs: memFs({}) }).read(), /cannot read service account token/, /check the path/);
  refused(() => inClusterAuth({ env: { ...ENV, KUBERNETES_SERVICE_PORT: "x" }, fs: saFs() }), /KUBERNETES_SERVICE_PORT/);
  for (const host of ["evil.example/path", "a b", "h@x", "h?x", "[::1"])
    refused(() => inClusterAuth({ env: { KUBERNETES_SERVICE_HOST: host }, fs: saFs() }), /not a host name or IP address/);
});

test("in-cluster: an IPv6 service host is bracketed and the port defaults to 443", () => {
  const auth = inClusterAuth({ env: { KUBERNETES_SERVICE_HOST: "fd00::1" }, fs: saFs() });
  assert.equal(auth.read().baseUrl, "https://[fd00::1]:443");
});

// ---- kubeconfig ----

test("kubeconfig: token, inline CA, server and context namespace", () => {
  const got = fileOf(kubeconfig()).read();
  assert.deepEqual(got, { baseUrl: "https://10.0.0.1:6443", ca: PEM("ca"), token: TOKEN, namespace: "ctx-ns" });
});

test("kubeconfig: a client certificate and key (inline data, and paths resolved against the kubeconfig directory)", () => {
  const inline = fileOf(kubeconfig({ user: { token: undefined, "client-certificate-data": b64(PEM("cc")), "client-key-data": b64(KEYPEM) } })).read();
  assert.equal(inline.cert, PEM("cc"));
  assert.equal(inline.key, KEYPEM);
  assert.equal(inline.token, undefined);
  const fs = memFs({
    [KC]: {
      content: kubeconfig({
        cluster: { "certificate-authority-data": undefined, "certificate-authority": "ca.pem" },
        user: { token: undefined, "client-certificate": "tls/c.pem", "client-key": "/keys/k.pem" },
      }),
    },
    "/etc/pomtree/ca.pem": { content: PEM("ca-file"), mode: 0o100644 },
    "/etc/pomtree/tls/c.pem": { content: PEM("cert-file"), mode: 0o100644 },
    "/keys/k.pem": { content: "KEYFILE", mode: 0o100600 },
  });
  const got = fileOf("", fs).read();
  assert.equal(got.ca, PEM("ca-file"));
  assert.equal(got.cert, PEM("cert-file"));
  assert.equal(got.key, "KEYFILE");
  for (const mode of [0o100644, 0o100640, 0o100604]) {
    fs.files["/keys/k.pem"] = { content: "KEYFILE", mode };
    refused(() => fileOf("", fs).read(), /client key: \/keys\/k\.pem is readable by group\/other/);
  }
});

test("kubeconfig: tokenFile is read with the mode check and re-read each time; the kubeconfig itself must be owner-only", () => {
  const fs = memFs({ [KC]: { content: kubeconfig({ user: { token: undefined, tokenFile: "/run/t" } }) }, "/run/t": { content: `${TOKEN}\n`, mode: 0o100600 } });
  const auth = fileOf("", fs);
  assert.equal(auth.read().token, TOKEN);
  fs.files["/run/t"] = { content: "tok-NEW-0123456789abcdefgh\n", mode: 0o100600 };
  assert.equal(auth.read().token, "tok-NEW-0123456789abcdefgh");
  fs.files["/run/t"] = { content: TOKEN, mode: 0o100644 };
  refused(() => auth.read(), /token file: \/run\/t is readable by group\/other/);
  fs.files["/run/t"] = { content: TOKEN, mode: 0o100600 };
  fs.files[KC] = { content: kubeconfig(), mode: 0o100644 };
  refused(() => auth.read(), /kubeconfig: \/etc\/pomtree\/kubeconfig is readable by group\/other/, /chmod 600/);
});

test("kubeconfig: exec plugins, auth providers, basic auth, insecure TLS, plain http and proxies are refused with cause and action", () => {
  refused(
    () => fileOf(kubeconfig({ user: { exec: { command: "gke-gcloud-auth-plugin" } } })).read(),
    /exec plugin.*never runs/,
    /kubectl create token pomtreed/,
  );
  refused(() => fileOf(kubeconfig({ user: { "auth-provider": { name: "gcp" } } })).read(), /auth provider or basic auth/, /service account token/);
  refused(() => fileOf(kubeconfig({ user: { username: "a", password: "b" } })).read(), /basic auth/);
  refused(() => fileOf(kubeconfig({ cluster: { "insecure-skip-tls-verify": true } })).read(), /insecure-skip-tls-verify/, /supply the cluster CA/);
  refused(() => fileOf(kubeconfig({ cluster: { server: "http://10.0.0.1:8080" } })).read(), /http:.*unencrypted/, /https/);
  refused(() => fileOf(kubeconfig({ cluster: { "proxy-url": "http://p" } })).read(), /proxy-url/);
  refused(
    () => fileOf(kubeconfig({ cluster: { server: "https://h/k8s/clusters/c-x" } })).read(),
    /path prefix \(\/k8s\/clusters\/c-x\).*silently dropped/,
    /API server's own address/,
  );
  refused(() => fileOf(kubeconfig({ cluster: { server: "https://u:p@10.0.0.1:6443" } })).read(), /carries credentials/, /remove the user:password/);
  refused(() => fileOf(kubeconfig({ cluster: { "tls-server-name": "other" } })).read(), /tls-server-name/);
  for (const k of ["as", "as-groups", "as-user-extra"]) refused(() => fileOf(kubeconfig({ user: { [k]: "x" } })).read(), /impersonation/, /own token/);
  assert.ok(fileOf(kubeconfig({ cluster: { server: "https://10.0.0.1:6443/" } })).read(), "NEG: a bare trailing slash is not a prefix");
});

test("kubeconfig: malformed files each name the cause and the action", () => {
  refused(() => fileOf("apiVersion: v1\nkind: Config\n").read(), /not JSON/, /kubectl config view --raw --minify --flatten -o json/);
  refused(() => fileOf("[]").read(), /not a JSON object/);
  refused(() => fileOf(kubeconfig({ top: { "current-context": undefined } })).read(), /no current-context/, /use-context/);
  refused(() => fileOf(kubeconfig({ top: { users: [] } })).read(), /defines none/);
  refused(() => fileOf(kubeconfig({ cluster: { server: undefined } })).read(), /no server/);
  refused(() => fileOf(kubeconfig({ user: { token: undefined } })).read(), /neither a token nor a client certificate/, /kubectl create token/);
  refused(() => fileOf(kubeconfig({ user: { "client-certificate-data": b64(PEM("c")) } })).read(), /only one of client-certificate and client-key/);
  refused(
    () => fileOf(kubeconfig({ cluster: { "certificate-authority-data": b64("not pem") } })).read(),
    /certificate-authority-data is not base64-encoded PEM/,
  );
  refused(
    () => fileOf(kubeconfig({ user: { token: undefined, "client-certificate-data": b64(PEM("c")), "client-key-data": b64("x") } })).read(),
    /client-key-data is not base64-encoded PEM/,
  );
  refused(() => fileAuth({ path: "relative", fs: memFs({}) }), /must be absolute/);
  refused(() => fileAuth({ path: KC, fs: memFs({}) }).read(), /cannot read kubeconfig/, /check the path/);
});

test("nodeKubeFs: reports the mode of the file it read (real file under os.tmpdir)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kube-auth-"));
  try {
    const f = join(dir, "t");
    writeFileSync(f, "abc");
    chmodSync(f, 0o644);
    assert.deepEqual({ content: nodeKubeFs.read(f).content, groupOther: nodeKubeFs.read(f).mode & 0o077 }, { content: "abc", groupOther: 0o044 });
    chmodSync(f, 0o600);
    assert.equal(nodeKubeFs.read(f).mode & 0o077, 0);
    assert.throws(() => nodeKubeFs.read(join(dir, "missing")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
