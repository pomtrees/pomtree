import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Server, createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SandboxQuotaError, SandboxUnavailableError } from "@pomtree/core";
import { createRequest } from "@pomtree/sandbox-kit";
import type { KubeAuth, KubeCredentials } from "./auth.ts";
import { type KubeClientOptions, KubeApiError, KubeForbiddenError, KubeInvalidError, KubeUnknownOutcomeError, createKubeClient } from "./api.ts";

// ---- throwaway certificates, generated per run (copied from the kit's ws-client test; no external tool, nothing checked in) ----

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [a * 40 + b];
  for (let v of rest) {
    const chunk = [v & 0x7f];
    for (v >>= 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
const utc = (d: Date): Buffer => der(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`));
const name = (cn: string): Buffer => der(0x30, der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from(cn)))));

function selfSigned(cn: string, dnsName = "localhost"): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sigAlg = der(0x30, oid("1.2.840.10045.4.3.2"));
  const san = der(0x30, der(0x82, Buffer.from(dnsName)), ...(dnsName === "localhost" ? [der(0x87, Buffer.from([127, 0, 0, 1]))] : []));
  const ext = (id: string, value: Buffer, critical = false) => der(0x30, oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    sigAlg,
    name(cn),
    der(0x30, utc(new Date(Date.now() - 3_600_000)), utc(new Date(Date.now() + 86_400_000))),
    name(cn),
    Buffer.from(publicKey.export({ type: "spki", format: "der" })),
    der(0xa3, der(0x30, ext("2.5.29.17", san), ext("2.5.29.19", der(0x30, der(0x01, Buffer.from([0xff]))), true))),
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = der(0x30, tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

const serverId = selfSigned("kube-api");
const otherId = selfSigned("other-ca");
const clientId = selfSigned("pomtree-client");
const wrongNameId = selfSigned("kube-api", "other.example");

// ---- a scripted https loopback API server ----

interface Seen {
  method: string;
  path: string;
  headerNames: string[];
  auth: string | undefined;
  userAgent: string | undefined;
  body: string;
  clientCN: string | undefined;
}
type Handler = (seen: Seen, res: ServerResponse, n: number) => void;

interface Api {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

async function serve(handler: Handler, opts: { requestCert?: boolean; identity?: { cert: string; key: string } } = {}): Promise<Api> {
  const seen: Seen[] = [];
  const server: Server = createServer(
    {
      cert: (opts.identity ?? serverId).cert,
      key: (opts.identity ?? serverId).key,
      ...(opts.requestCert ? { requestCert: true, rejectUnauthorized: true, ca: [clientId.cert] } : {}),
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        const peer = (req.socket as unknown as { getPeerCertificate?: () => { subject?: { CN?: string } } }).getPeerCertificate?.();
        const s: Seen = {
          method: req.method ?? "",
          path: req.url ?? "",
          headerNames: Object.keys(req.headers).sort(),
          auth: req.headers.authorization,
          userAgent: req.headers["user-agent"],
          body: Buffer.concat(parts).toString("utf8"),
          clientCN: peer?.subject?.CN,
        };
        seen.push(s);
        handler(s, res, seen.length);
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `https://localhost:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
};
const status = (code: number, reason: string, message: string) => ({ kind: "Status", apiVersion: "v1", status: "Failure", code, reason, message });

const TOKEN = "tok-PLANTED-0123456789abcdef";

// A scripted auth source: `creds()` is consulted on every read.
function authOf(creds: () => Partial<KubeCredentials>, url: string): KubeAuth & { reads: number } {
  const a = {
    reads: 0,
    describe: "/etc/pomtree/kubeconfig",
    reissueHint: "issue a new token with kubectl create token pomtreed -n pomtree-sandboxes --duration=24h",
    read(): KubeCredentials {
      a.reads++;
      return { baseUrl: url, ca: serverId.cert, ...creds() };
    },
  };
  return a;
}

async function withApi(
  handler: Handler,
  creds: () => Partial<KubeCredentials>,
  body: (
    api: Api,
    make: (extra?: Partial<KubeClientOptions>) => ReturnType<typeof createKubeClient>,
    logs: string[],
    auth: ReturnType<typeof authOf>,
  ) => Promise<void>,
  opts: { requestCert?: boolean; identity?: { cert: string; key: string } } = {},
): Promise<void> {
  const api = await serve(handler, opts);
  const logs: string[] = [];
  const auth = authOf(creds, api.url);
  const make = (extra: Partial<KubeClientOptions> = {}) =>
    createKubeClient({
      auth,
      request: createRequest({}),
      namespace: "pomtree-sandboxes",
      log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
      retry: { maxAttempts: 1, sleep: async () => {} },
      ...extra,
    });
  try {
    await body(api, make, logs, auth);
  } finally {
    await api.close();
  }
}

const PODS = "/api/v1/namespaces/pomtree-sandboxes/pods";

// ---- tests ----

test("api: a GET over TLS carries the bearer token, the fetch user-agent and parses JSON; the CA comes from the credential", async () => {
  await withApi(
    (_s, res) => json(res, 200, { kind: "PodList", items: [] }),
    () => ({ token: TOKEN }),
    async (api, make) => {
      const got = await make().call({ method: "GET", path: PODS, query: { labelSelector: "a=b,!c" } });
      assert.deepEqual(got, { kind: "ok", status: 200, body: { kind: "PodList", items: [] } });
      assert.equal(api.seen[0]?.auth, `Bearer ${TOKEN}`);
      assert.equal(api.seen[0]?.userAgent, "pomtree");
      assert.equal(api.seen[0]?.path, `${PODS}?labelSelector=a%3Db%2C%21c`);
    },
  );
});

test("api: a server whose certificate is not signed by the configured CA is rejected, naming the cause and the action", async () => {
  await withApi(
    (_s, res) => json(res, 200, {}),
    () => ({ token: TOKEN, ca: otherId.cert }),
    async (api, make) => {
      await assert.rejects(make().call({ method: "GET", path: PODS }), (e: Error) => {
        assert.match(e.message, /failed:/);
        assert.match(e.message, /self.signed|unable to verify|certificate/i, "the cause");
        assert.match(e.message, /Check the endpoint address, network reachability and TLS settings/, "the action");
        assert.ok(!e.message.includes(TOKEN));
        return true;
      });
      assert.equal(api.seen.length, 0, "no request reached the server, so the token was never sent to an unverified peer");
    },
  );
});

test("api: the client certificate is presented when configured, and a server that requires one rejects a client without it", async () => {
  await withApi(
    (_s, res) => json(res, 200, { ok: true }),
    () => ({ cert: clientId.cert, key: clientId.key }),
    async (api, make) => {
      const got = await make().call({ method: "GET", path: "/version" });
      assert.equal(got.kind, "ok");
      assert.equal(api.seen[0]?.clientCN, "pomtree-client");
      assert.equal(api.seen[0]?.auth, undefined, "no token configured, no Authorization header");
    },
    { requestCert: true },
  );
  await withApi(
    (_s, res) => json(res, 200, { ok: true }),
    () => ({ token: TOKEN }),
    async (api, make) => {
      await assert.rejects(make().call({ method: "GET", path: "/version" }), /failed/);
      assert.equal(api.seen.length, 0);
    },
    { requestCert: true },
  );
});

test("api: after a 401 the credential is re-read once and the retried request carries the new token", async () => {
  let token = "tok-OLD-aaaaaaaaaaaaaaaa";
  await withApi(
    (s, res) => (s.auth === "Bearer tok-NEW-bbbbbbbbbbbbbbbb" ? json(res, 200, { ok: true }) : json(res, 401, status(401, "Unauthorized", "Unauthorized"))),
    () => ({ token }),
    async (api, make, logs, auth) => {
      const c = make();
      // The file is rewritten between the first read and the 401 answer.
      const first = auth.read.bind(auth);
      let rewrote = false;
      auth.read = () => {
        const r = first();
        if (!rewrote) {
          rewrote = true;
          token = "tok-NEW-bbbbbbbbbbbbbbbb";
        }
        return r;
      };
      const got = await c.call({ method: "GET", path: PODS });
      assert.equal(got.kind, "ok");
      assert.deepEqual(
        api.seen.map((s) => s.auth),
        ["Bearer tok-OLD-aaaaaaaaaaaaaaaa", "Bearer tok-NEW-bbbbbbbbbbbbbbbb"],
      );
      assert.ok(logs.some((l) => l.startsWith("kubernetes.auth-reread")));
    },
  );
});

test("api: a 401 with an unchanged credential makes no second request; a rotated token that is also refused stops after one retry; both name the file and the reissue command", async () => {
  const deny: Handler = (_s, res) => json(res, 401, status(401, "Unauthorized", `bad ${TOKEN}`));
  await withApi(
    deny,
    () => ({ token: TOKEN }),
    async (api, make, logs) => {
      await assert.rejects(make().call({ method: "GET", path: PODS }), (e) => {
        assert.ok(!logs.join("\n").includes(TOKEN), "the token echoed in the 401 body is not logged");
        assert.ok(e instanceof SandboxUnavailableError);
        assert.equal(e.reason, "auth");
        assert.match(e.message, /\/etc\/pomtree\/kubeconfig/);
        assert.match(e.message, /kubectl create token pomtreed/);
        assert.ok(!e.message.includes(TOKEN));
        return true;
      });
      assert.equal(api.seen.length, 1, "NEG: nothing new to try, so no retry");
    },
  );
  let n = 0;
  await withApi(
    deny,
    () => ({ token: `tok-ROT${n++}-cccccccccccccccc` }),
    async (api, make) => {
      await assert.rejects(make().call({ method: "GET", path: PODS }), SandboxUnavailableError);
      assert.equal(api.seen.length, 2, "one retry, no loop");
    },
  );
});

test("api: the Authorization value is never in a thrown message, an error property or a log line, even when the server echoes it", async () => {
  const cases: [number, string][] = [
    [403, "Forbidden"],
    [422, "Invalid"],
    [400, "BadRequest"],
    [500, "InternalError"],
    [401, "Unauthorized"],
  ];
  for (const [code, reason] of cases) {
    await withApi(
      (_s, res) => json(res, code, status(code, reason, `user presented Bearer ${TOKEN} and token=${TOKEN}`)),
      () => ({ token: TOKEN }),
      async (api, make, logs) => {
        let thrown: unknown;
        try {
          await make().call({ method: "POST", path: PODS, body: { metadata: { name: "p" } } });
        } catch (e) {
          thrown = e;
        }
        assert.ok(thrown instanceof Error, `${code} throws`);
        const everything = [thrown.message, JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)), ...logs].join("\n");
        assert.ok(!everything.includes(TOKEN), `${code}: no token in message, properties or logs`);
        assert.ok(!/bearer\s+tok/i.test(everything), `${code}: no bearer value`);
        assert.ok(api.seen[0]?.headerNames.includes("authorization"), "the header was sent; only its value is kept out of the record");
      },
    );
  }
});

test("api: 429 with Retry-After becomes SandboxQuotaError through withRetry (scope and wait preserved); a short wait is retried", async () => {
  await withApi(
    (_s, res) => json(res, 429, status(429, "TooManyRequests", "slow down"), { "retry-after": "120" }),
    () => ({ token: TOKEN }),
    async (api, make) => {
      await assert.rejects(make().call({ method: "GET", path: PODS }), (e) => {
        assert.ok(e instanceof SandboxQuotaError);
        assert.equal(e.backend, "kubernetes");
        assert.equal(e.scope, "rate");
        assert.equal(e.retryAfterMs, 120_000);
        return true;
      });
      assert.equal(api.seen.length, 1, "a wait longer than the cap is not slept");
    },
  );
  const slept: number[] = [];
  await withApi(
    (_s, res, n) => (n === 1 ? json(res, 429, status(429, "TooManyRequests", "x"), { "retry-after": "2" }) : json(res, 200, { ok: true })),
    () => ({ token: TOKEN }),
    async (api, make) => {
      const got = await make({ retry: { maxAttempts: 3, sleep: async (ms) => void slept.push(ms) } }).call({ method: "GET", path: PODS });
      assert.equal(got.kind, "ok");
      assert.deepEqual(slept, [2000]);
      assert.equal(api.seen.length, 2);
    },
  );
});

test("api: 409 is returned as a typed conflict carrying the existing object for a named create, and null otherwise", async () => {
  const live = { kind: "Pod", metadata: { name: "pomtree-abc", annotations: { "pomtree.spec-hash": "h1" } } };
  await withApi(
    (s, res) => (s.method === "POST" ? json(res, 409, status(409, "AlreadyExists", 'pods "pomtree-abc" already exists')) : json(res, 200, live)),
    () => ({ token: TOKEN }),
    async (api, make) => {
      const got = await make().call({ method: "POST", path: PODS, body: { metadata: { name: "pomtree-abc" } } });
      assert.deepEqual(got, { kind: "conflict", status: 409, message: 'pods "pomtree-abc" already exists', reason: "AlreadyExists", existing: live });
      assert.deepEqual(
        api.seen.map((s) => `${s.method} ${s.path}`),
        [`POST ${PODS}`, `GET ${PODS}/pomtree-abc`],
      );
    },
  );
  await withApi(
    (_s, res) => json(res, 409, status(409, "Conflict", "the object has been modified")),
    () => ({ token: TOKEN }),
    async (_api, make) => {
      const got = await make().call({ method: "PUT", path: `${PODS}/p`, body: { metadata: { name: "p" } } });
      assert.equal(got.kind, "conflict");
      assert.equal(got.kind === "conflict" ? got.existing : "x", null, "NEG: only a create reads the existing object");
    },
  );
});

test("api: a 5xx after send on a mutating call is a typed unknown-outcome error; a read says applied no", async () => {
  await withApi(
    (_s, res) => json(res, 500, status(500, "InternalError", "etcd timeout")),
    () => ({ token: TOKEN }),
    async (_api, make) => {
      await assert.rejects(make().call({ method: "POST", path: PODS, body: { metadata: { name: "p" } } }), (e) => {
        assert.ok(e instanceof KubeUnknownOutcomeError);
        assert.equal(e.applied, "unknown");
        assert.equal(e.status, 500);
        assert.match(e.message, /etcd timeout/);
        assert.match(e.message, /read the object by name before repeating/, "the action");
        return true;
      });
      await assert.rejects(make().call({ method: "GET", path: PODS }), (e) => e instanceof KubeUnknownOutcomeError && e.applied === "no");
    },
  );
  await withApi(
    (_s, res) => json(res, 503, status(503, "ServiceUnavailable", "down")),
    () => ({ token: TOKEN }),
    async (api, make) => {
      await assert.rejects(
        make({ retry: { maxAttempts: 3, sleep: async () => {} } }).call({ method: "POST", path: PODS, body: {} }),
        (e) => e instanceof KubeUnknownOutcomeError && e.applied === "unknown",
      );
      assert.equal(api.seen.length, 1, "a POST without an idempotency key is never repeated by the retry wrapper");
    },
  );
});

test("api: 403, 404, 422 and other 4xx map to their typed outcomes, each with the cause and the action", async () => {
  const run = async (code: number, reason: string, message: string, method: "GET" | "POST" = "GET") =>
    new Promise<unknown>((resolve) => {
      void withApi(
        (_s, res) => json(res, code, status(code, reason, message)),
        () => ({ token: TOKEN }),
        async (_api, make) => {
          try {
            resolve(await make().call({ method, path: PODS, ...(method === "POST" ? { body: {} } : {}) }));
          } catch (e) {
            resolve(e);
          }
        },
      );
    });
  const nf = await run(404, "NotFound", "pods not found");
  assert.deepEqual(nf, { kind: "not-found", status: 404, message: "pods not found" });
  const fb = await run(403, "Forbidden", 'pods is forbidden: User "system:serviceaccount:ns:pomtreed" cannot list');
  assert.ok(fb instanceof KubeForbiddenError);
  assert.match(fb.message, /cannot list.*grant the pomtreed service account that verb on the resource in its Role/);
  const inv = await run(422, "Invalid", "spec.containers: Required value", "POST");
  assert.ok(inv instanceof KubeInvalidError);
  assert.match(inv.message, /Required value.*adapter bug/);
  const other = await run(400, "BadRequest", "bad selector");
  assert.ok(other instanceof KubeApiError && !(other instanceof KubeInvalidError));
  assert.equal(other.status, 400);
});

test("api: a non-JSON 2xx body is an error naming the cause, an empty 2xx body is undefined", async () => {
  await withApi(
    (_s, res) => res.writeHead(200).end("<html>proxy</html>"),
    () => ({ token: TOKEN }),
    async (_api, make) => {
      await assert.rejects(make().call({ method: "GET", path: "/version" }), /not JSON.*check that the address is the Kubernetes API server/s);
    },
  );
  await withApi(
    (_s, res) => res.writeHead(200).end(),
    () => ({ token: TOKEN }),
    async (_api, make) => {
      assert.deepEqual(await make().call({ method: "DELETE", path: `${PODS}/p` }), { kind: "ok", status: 200, body: undefined });
    },
  );
});

test("api: a request that gets no reply times out (a lost mutating call is unknown-outcome) and an abort after send is unknown-outcome too", async () => {
  const hang: Handler = () => {};
  await withApi(
    hang,
    () => ({ token: TOKEN }),
    async (_api, make) => {
      await assert.rejects(make().call({ method: "GET", path: PODS, timeoutMs: 50 }), /no complete response within 50 ms/);
      await assert.rejects(make().call({ method: "POST", path: PODS, body: {}, timeoutMs: 50 }), (e) => {
        assert.ok(e instanceof KubeUnknownOutcomeError);
        assert.equal(e.applied, "unknown");
        assert.match(e.message, /lost its reply.*read the object by name/s);
        return true;
      });
      const ac = new AbortController();
      const p = make().call({ method: "POST", path: PODS, body: {}, signal: ac.signal });
      setTimeout(() => ac.abort(new Error("caller cancelled")), 30);
      await assert.rejects(p, (e) => e instanceof KubeUnknownOutcomeError && e.applied === "unknown" && /read the object by name/.test(e.message));
      const pre = new AbortController();
      pre.abort(new Error("already cancelled"));
      const before = _api.seen.length;
      await assert.rejects(
        make().call({ method: "POST", path: PODS, body: {}, signal: pre.signal }),
        (e) => !(e instanceof KubeUnknownOutcomeError) && /already cancelled/.test(String(e)),
      );
      assert.equal(_api.seen.length, before, "NEG: aborted before sending, nothing was sent and the outcome is not unknown");
    },
  );
});

test("api: nsPath builds namespaced paths and refuses names that could escape the path", async () => {
  const c = createKubeClient({ auth: authOf(() => ({}), "https://x"), request: createRequest({}), namespace: "pomtree-sandboxes" });
  assert.equal(c.nsPath("pods"), PODS);
  assert.equal(c.nsPath("pods", "pomtree-ab"), `${PODS}/pomtree-ab`);
  assert.equal(c.nsPath("networkpolicies", "d", "apis/networking.k8s.io/v1"), "/apis/networking.k8s.io/v1/namespaces/pomtree-sandboxes/networkpolicies/d");
  for (const bad of ["../x", "a/b", "A", "", "a?b"]) assert.throws(() => c.nsPath("pods", bad), /not a valid Kubernetes name.*fix/);
  assert.throws(() => createKubeClient({ auth: authOf(() => ({}), "https://x"), request: createRequest({}), namespace: "bad/ns" }), /namespace/);
});

test("api: an oversize reply to a mutating call is unknown-outcome (applied unknown); the same on a read is rethrown", async () => {
  await withApi(
    (_s, res) => json(res, 201, { pad: "x".repeat(500) }),
    () => ({ token: TOKEN }),
    async (_api, make) => {
      const small = { request: createRequest({ maxBytes: 100 }) };
      await assert.rejects(
        make(small).call({ method: "POST", path: PODS, body: {} }),
        (e) => e instanceof KubeUnknownOutcomeError && e.applied === "unknown" && /exceeded 100 bytes/.test(e.message),
      );
      await assert.rejects(
        make(small).call({ method: "GET", path: PODS }),
        (e) => !(e instanceof KubeUnknownOutcomeError) && /exceeded 100 bytes/.test(String(e)),
      );
    },
  );
});

test("api: a certificate valid for a different host name is rejected, and the matching one is accepted (control)", async () => {
  await withApi(
    (_s, res) => json(res, 200, {}),
    () => ({ token: TOKEN, ca: wrongNameId.cert }),
    async (api, make) => {
      await assert.rejects(make().call({ method: "GET", path: PODS }), (e: Error) => {
        assert.match(e.message, /Hostname\/IP does not match|altnames|other\.example/i, "the cause");
        assert.match(e.message, /TLS settings/, "the action");
        return true;
      });
      assert.equal(api.seen.length, 0, "the token was not sent to a peer whose name did not verify");
    },
    { identity: wrongNameId },
  );
  await withApi(
    (_s, res) => json(res, 200, {}),
    () => ({ token: TOKEN }),
    async (_api, make) => assert.equal((await make().call({ method: "GET", path: PODS })).kind, "ok"),
  );
});

test("api: a redirect is not followed, so the token never reaches the redirect target", async () => {
  const target = await serve((_s, res) => json(res, 200, { leaked: true }));
  try {
    await withApi(
      (_s, res) => res.writeHead(302, { location: `${target.url}/steal` }).end(),
      () => ({ token: TOKEN }),
      async (api, make) => {
        await assert.rejects(make().call({ method: "GET", path: PODS }), (e) => e instanceof KubeApiError && e.status === 302);
        assert.equal(api.seen.length, 1);
        assert.equal(target.seen.length, 0, "the redirect target received no request");
      },
    );
  } finally {
    await target.close();
  }
});
