// Authentication sources for the Kubernetes API: the in-cluster service account files, and a JSON
// kubeconfig (`kubectl config view --raw --minify --flatten -o json`). The repository has no YAML parser and adds none.
//
// Rules. Bearer tokens come from FILES only (never an env value or an inline config string). Every explicit file (the kubeconfig,
// a `tokenFile`, a client key file) gets the shared owner-only mode check. The one exception is the in-cluster source: the
// kubelet projects the service account token at 0644 by default, `defaultMode: 0400` would make it root-owned and unreadable by a
// non-root daemon, and `fsGroup` adds a group-read bit, so the strict rule would fail the standard path closed. That volume is a
// kubelet-owned tmpfs private to the pod, so any other reader is in the same trust domain; there only a regular file is required.
// Exec plugins, auth providers, basic auth, impersonation, `tls-server-name`, `insecure-skip-tls-verify`, plain-http servers and
// server URLs with credentials or a path prefix are refused with the cause and the fix.
// `read()` re-reads every file on each call, so a rotated token or certificate is picked up without a restart. Files are read
// through an injected `KubeFs`, so tests touch no real fs; the default reads a descriptor and stats that same descriptor.

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { secretFileModeReason } from "@pomtree/core";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export class KubeAuthError extends Error {
  override name = "KubeAuthError";
}

export interface KubeFileRead {
  content: string;
  mode: number;
}

// The mode must come from the descriptor the content was read from, never from a second stat of the path.
export interface KubeFs {
  read(path: string): KubeFileRead;
}

export const nodeKubeFs: KubeFs = {
  read(path) {
    const fd = openSync(path, "r");
    try {
      return { mode: fstatSync(fd).mode, content: readFileSync(fd, "utf8") };
    } finally {
      closeSync(fd);
    }
  },
};

// What one request needs. Fresh on every `read()`.
export interface KubeCredentials {
  // `https://host:port`, no trailing slash.
  baseUrl: string;
  // PEM text; absent means the platform's trust store.
  ca?: string;
  // Client certificate and key, PEM text, both or neither.
  cert?: string;
  key?: string;
  token?: string;
  // The namespace the source names (service account file or kubeconfig context); the adapter's configured namespace wins.
  namespace?: string;
}

export interface KubeAuth {
  // Where the credential comes from, safe to print (a file path, never a value).
  readonly describe: string;
  // The command that issues a replacement, for the 401 message.
  readonly reissueHint: string;
  read(): KubeCredentials;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

// `strict` applies the shared owner-only mode rule; otherwise only a regular file is required (in-cluster source, see below).
function readFileChecked(fs: KubeFs, path: string, label: string, hint: string, strict = true): string {
  let read: KubeFileRead;
  try {
    read = fs.read(path);
  } catch (e) {
    throw new KubeAuthError(
      `cannot read ${label} ${path}: ${e instanceof Error ? e.message : String(e)}; check the path and that the daemon can read it${hint}`,
    );
  }
  if ((read.mode & S_IFMT) !== S_IFREG) throw new KubeAuthError(`${label} ${path} is not a regular file; mount the credential as a plain file`);
  const refusal = strict ? secretFileModeReason(path, { mode: read.mode }) : null;
  if (refusal !== null) throw new KubeAuthError(`${label}: ${refusal}${hint}`);
  return read.content;
}

function readPlain(fs: KubeFs, path: string, label: string): string {
  try {
    return fs.read(path).content;
  } catch (e) {
    throw new KubeAuthError(`cannot read ${label} ${path}: ${e instanceof Error ? e.message : String(e)}; check the path and that the daemon can read it`);
  }
}

const trimToken = (raw: string, path: string): string => {
  const t = raw.replace(/\r?\n$/, "");
  if (t === "") throw new KubeAuthError(`token file ${path} is empty; write the service account token into it`);
  if (/\s/.test(t)) throw new KubeAuthError(`token file ${path} holds more than one line or contains whitespace; it must hold the bare token only`);
  return t;
};

export interface InClusterOptions {
  // `process.env` in production; only the two service variables are read.
  env: Readonly<Record<string, string | undefined>>;
  fs: KubeFs;
  // Defaults to the standard service account mount.
  dir?: string;
}

// The pod's own service account: API address from the environment, token, CA and namespace from the projected files.
export function inClusterAuth(o: InClusterOptions): KubeAuth {
  const host = o.env.KUBERNETES_SERVICE_HOST;
  if (host === undefined || host === "")
    throw new KubeAuthError(
      "auth is in-cluster but KUBERNETES_SERVICE_HOST is not set, so this process is not inside a pod; run the daemon in the cluster, or set sandbox.kubernetes.auth to kubeconfig",
    );
  if (!/^(\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:.]+|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$/.test(host))
    throw new KubeAuthError("KUBERNETES_SERVICE_HOST is not a host name or IP address; fix the pod environment");
  const port = o.env.KUBERNETES_SERVICE_PORT === undefined || o.env.KUBERNETES_SERVICE_PORT === "" ? "443" : o.env.KUBERNETES_SERVICE_PORT;
  if (!/^\d+$/.test(port)) throw new KubeAuthError("KUBERNETES_SERVICE_PORT is not a port number; fix the pod environment");
  const dir = o.dir ?? SERVICE_ACCOUNT_DIR;
  const baseUrl = `https://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
  return {
    describe: `${dir}/token`,
    reissueHint: "restart the pod so the kubelet projects a fresh token",
    read() {
      const token = trimToken(readFileChecked(o.fs, `${dir}/token`, "service account token", "", false), `${dir}/token`);
      const ca = readPlain(o.fs, `${dir}/ca.crt`, "cluster CA bundle");
      let namespace: string | undefined;
      try {
        namespace = o.fs.read(`${dir}/namespace`).content.trim() || undefined;
      } catch {
        namespace = undefined;
      }
      return { baseUrl, ca, token, ...(namespace === undefined ? {} : { namespace }) };
    },
  };
}

// Decodes an inline base64 `*-data` field and requires PEM text, naming the field when it is not.
function pemData(b64: string, field: string, bad: (what: string, fix: string) => KubeAuthError): string {
  const text = Buffer.from(b64, "base64").toString("utf8");
  if (!text.includes("-----BEGIN "))
    throw bad(`${field} is not base64-encoded PEM`, `regenerate the kubeconfig with kubectl config view --raw --minify --flatten -o json`);
  return text;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function named(list: unknown, name: string, kind: string, path: string): Record<string, unknown> {
  const hit = Array.isArray(list) ? list.find((e) => isObj(e) && e.name === name) : undefined;
  if (!isObj(hit))
    throw new KubeAuthError(
      `kubeconfig ${path} names ${kind} ${JSON.stringify(name)} but defines none; regenerate it with kubectl config view --raw --minify --flatten -o json`,
    );
  const inner = hit[kind];
  if (!isObj(inner))
    throw new KubeAuthError(
      `kubeconfig ${path}: ${kind} ${JSON.stringify(name)} has no ${kind} object; regenerate it with kubectl config view --raw --minify --flatten -o json`,
    );
  return inner;
}

export interface FileAuthOptions {
  // Absolute path of the JSON kubeconfig (mode 0600).
  path: string;
  fs: KubeFs;
}

// A JSON kubeconfig: the current context's cluster and user. Inline `*-data` fields are base64 PEM; path fields resolve against
// the kubeconfig's own directory.
export function fileAuth(o: FileAuthOptions): KubeAuth {
  if (!isAbsolute(o.path)) throw new KubeAuthError("the kubeconfig path must be absolute; set the kubeconfig credential file variable to an absolute path");
  const base = dirname(o.path);
  const at = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  const bad = (what: string, fix: string) => new KubeAuthError(`kubeconfig ${o.path}: ${what}; ${fix}`);
  return {
    describe: o.path,
    reissueHint: "issue a new token with kubectl create token pomtreed -n <namespace> --duration=<d> and write it into the kubeconfig",
    read() {
      const text = readFileChecked(o.fs, o.path, "kubeconfig", "");
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw bad(
          "it is not JSON (YAML kubeconfigs are not supported)",
          "convert it with kubectl config view --raw --minify --flatten -o json > <file> and chmod 600 it",
        );
      }
      if (!isObj(doc)) throw bad("it is not a JSON object", "regenerate it with kubectl config view --raw --minify --flatten -o json");
      const ctxName = str(doc["current-context"]);
      if (ctxName === undefined) throw bad("it has no current-context", "run kubectl config use-context <name> or regenerate it with --minify");
      const ctx = named(doc.contexts, ctxName, "context", o.path);
      const cluster = named(doc.clusters, str(ctx.cluster) ?? "", "cluster", o.path);
      const user = named(doc.users, str(ctx.user) ?? "", "user", o.path);

      const server = str(cluster.server);
      if (server === undefined) throw bad("the cluster has no server", "add the API server address");
      let url: URL;
      try {
        url = new URL(server);
      } catch {
        throw bad("the cluster server is not a URL", "write it as https://host:port");
      }
      if (url.username !== "" || url.password !== "")
        throw bad("the cluster server URL carries credentials", "remove the user:password part and use a token or client certificate");
      if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
        throw bad(
          `the cluster server URL has a path prefix (${url.pathname}), which this client does not support (it would be silently dropped)`,
          "use the API server's own address (https://host:port) instead of a proxy such as a Rancher-style /k8s/clusters/<id> URL",
        );
      if (url.protocol !== "https:")
        throw bad(`the cluster server uses ${url.protocol}, which would send credentials unencrypted`, "use an https: server address");
      if (cluster["insecure-skip-tls-verify"] === true)
        throw bad("insecure-skip-tls-verify is set, which disables server verification", "remove it and supply the cluster CA");
      if (str(cluster["tls-server-name"]) !== undefined)
        throw bad(
          "tls-server-name is not supported (it changes which name the certificate is verified against)",
          "remove it and use an address the certificate covers",
        );
      if (str(cluster["proxy-url"]) !== undefined) throw bad("proxy-url is not supported", "remove it and make the API server reachable directly");
      if (user.exec !== undefined) {
        throw bad(
          "the user logs in through an exec plugin, which this daemon never runs",
          "issue a service account token with kubectl create token pomtreed -n <namespace> --duration=<d> and put it in the kubeconfig as the user's token",
        );
      }
      if (user.as !== undefined || user["as-groups"] !== undefined || user["as-user-extra"] !== undefined)
        throw bad(
          "the user sets impersonation (as, as-groups or as-user-extra), which would silently change the acting identity",
          "remove it and use the service account's own token",
        );
      if (user["auth-provider"] !== undefined || str(user.username) !== undefined || str(user.password) !== undefined)
        throw bad("the user uses an auth provider or basic auth, which is not supported", "use a service account token or a client certificate");

      const out: KubeCredentials = { baseUrl: `https://${url.host}` };
      const caData = str(cluster["certificate-authority-data"]);
      const caFile = str(cluster["certificate-authority"]);
      if (caData !== undefined) out.ca = pemData(caData, "certificate-authority-data", bad);
      else if (caFile !== undefined) out.ca = readPlain(o.fs, at(caFile), "cluster CA bundle");

      const tokenFile = str(user.tokenFile);
      const token = str(user.token);
      if (tokenFile !== undefined) out.token = trimToken(readFileChecked(o.fs, at(tokenFile), "token file", ""), at(tokenFile));
      else if (token !== undefined) out.token = token;

      const certData = str(user["client-certificate-data"]);
      const certFile = str(user["client-certificate"]);
      const keyData = str(user["client-key-data"]);
      const keyFile = str(user["client-key"]);
      const hasCert = certData !== undefined || certFile !== undefined;
      const hasKey = keyData !== undefined || keyFile !== undefined;
      if (hasCert !== hasKey) throw bad("the user has only one of client-certificate and client-key", "supply both or use a token");
      if (hasCert) {
        out.cert = certData !== undefined ? pemData(certData, "client-certificate-data", bad) : readPlain(o.fs, at(certFile as string), "client certificate");
        out.key = keyData !== undefined ? pemData(keyData, "client-key-data", bad) : readFileChecked(o.fs, at(keyFile as string), "client key", "");
      }
      if (out.token === undefined && out.cert === undefined)
        throw bad(
          "the user has neither a token nor a client certificate",
          "add a service account token (kubectl create token) or a client certificate and key",
        );
      const ns = str(ctx.namespace);
      if (ns !== undefined) out.namespace = ns;
      return out;
    },
  };
}
