import assert from "node:assert/strict";
import test from "node:test";
import { type CdpSessionLike, createCdpRecorder, headerLines, mainDocument, type RecorderLimits } from "./cdp-recorder.ts";

// A scripted CDP session: events are emitted by the test, getResponseBody answers from `bodies` (missing = Chromium's error), and every
// call is recorded.
function fakeSession(bodies: Record<string, { body: string; base64Encoded: boolean }> = {}) {
  const listeners = new Map<string, ((p: unknown) => void)[]>();
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const session: CdpSessionLike = {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as (p: unknown) => void]);
    },
    async send(method, params) {
      calls.push({ method, ...(params && { params }) });
      if (method === "Network.getResponseBody") {
        const b = bodies[params?.requestId as string];
        if (!b) throw new Error("No resource with given identifier found");
        return b;
      }
      return {};
    },
  };
  const emit = (event: string, params: unknown) => {
    for (const l of listeners.get(event) ?? []) l(params);
  };
  return { session, emit, calls };
}
const LIMITS: RecorderLimits = { perBodyMaxBytes: 1024, perBodyAllocationMaxBytes: 4096, totalMaxBytes: 8192 };
const req = (requestId: string, url: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  loaderId: requestId,
  frameId: "F1",
  type: "Document",
  wallTime: 1_700_000_000.5,
  request: { url, method: "GET", headers: { "User-Agent": "UA" } },
  ...extra,
});
const resp = (url: string, status: number, headers: Record<string, string> = {}) => ({
  url,
  status,
  statusText: "",
  headers,
  mimeType: "text/html",
  protocol: "h2",
});
const text = (s: string) => ({ body: s, base64Encoded: false });

test("a cross-host 302 then 200 is one requestId with two hops; the redirect has no body and the final body is fetched", async () => {
  const { session, emit, calls } = fakeSession({ R1: text("<html>final</html>") });
  const rec = createCdpRecorder(session, LIMITS);
  await rec.start();
  assert.deepEqual(calls[0], { method: "Network.enable", params: { maxResourceBufferSize: 4096, maxTotalBufferSize: 8192 } });
  emit("Network.requestWillBeSent", req("R1", "http://a.test/start"));
  emit(
    "Network.requestWillBeSent",
    req("R1", "http://b.test/final", { redirectResponse: resp("http://a.test/start", 302, { Location: "http://b.test/final" }) }),
  );
  emit("Network.responseReceived", { requestId: "R1", type: "Document", response: resp("http://b.test/final", 200, { "Content-Type": "text/html" }) });
  emit("Network.loadingFinished", { requestId: "R1" });
  const [ex] = await rec.finish();
  assert.ok(ex);
  assert.equal(ex.state, "finished");
  assert.deepEqual(
    ex.hops.map((h) => [h.url, h.response?.status, h.body.state, h.body.omission]),
    [
      ["http://a.test/start", 302, "omitted", "redirect"],
      ["http://b.test/final", 200, "complete", undefined],
    ],
  );
  assert.equal(Buffer.from(ex.hops[1]!.body.bytes).toString(), "<html>final</html>");
  assert.deepEqual(ex.hops[0]!.response?.headers, [["Location", "http://b.test/final"]]);
  assert.equal(mainDocument([ex], "F1", "http://b.test/final"), ex);
});

test("a 301 chain records every hop in order, and raw ExtraInfo headers replace the filtered ones hop by hop", async () => {
  const { session, emit } = fakeSession({ R1: text("ok") });
  const rec = createCdpRecorder(session, LIMITS);
  await rec.start();
  // ExtraInfo for the first hop arrives before its requestWillBeSent, as Chromium may send it.
  emit("Network.requestWillBeSentExtraInfo", { requestId: "R1", headers: { ":authority": "a.test", "user-agent": "raw-UA", cookie: "a=1" } });
  emit("Network.requestWillBeSent", req("R1", "https://a.test/1"));
  emit("Network.responseReceivedExtraInfo", { requestId: "R1", statusCode: 301, headers: { location: "https://a.test/2", "set-cookie": "x=1\ny=2" } });
  emit("Network.requestWillBeSent", req("R1", "https://a.test/2", { redirectResponse: resp("https://a.test/1", 301, { Location: "https://a.test/2" }) }));
  emit("Network.requestWillBeSent", req("R1", "https://a.test/3", { redirectResponse: resp("https://a.test/2", 301, { Location: "https://a.test/3" }) }));
  emit("Network.responseReceived", { requestId: "R1", response: resp("https://a.test/3", 200) });
  emit("Network.loadingFinished", { requestId: "R1" });
  const [ex] = await rec.finish();
  assert.deepEqual(
    ex!.hops.map((h) => [h.url, h.response?.status]),
    [
      ["https://a.test/1", 301],
      ["https://a.test/2", 301],
      ["https://a.test/3", 200],
    ],
  );
  const first = ex!.hops[0]!;
  assert.equal(first.requestHeadersSource, "raw");
  // The pseudo-header is dropped and Host comes from the URL.
  assert.deepEqual(first.requestHeaders, [
    ["Host", "a.test"],
    ["user-agent", "raw-UA"],
    ["cookie", "a=1"],
  ]);
  assert.equal(first.response?.headersSource, "raw");
  // CDP's "\n"-joined repeated header is split back into one line each.
  assert.deepEqual(first.response?.headers, [
    ["location", "https://a.test/2"],
    ["set-cookie", "x=1"],
    ["set-cookie", "y=2"],
  ]);
  assert.equal(ex!.hops[1]!.requestHeadersSource, "filtered");
  assert.equal(ex!.hops[1]!.response?.headersSource, "filtered");
});

test("an ExtraInfo whose status disagrees with the hop is not attributed to it", async () => {
  const { session, emit } = fakeSession({ R1: text("ok") });
  const rec = createCdpRecorder(session, LIMITS);
  await rec.start();
  emit("Network.requestWillBeSent", req("R1", "https://a.test/"));
  emit("Network.responseReceivedExtraInfo", { requestId: "R1", statusCode: 500, headers: { "x-wrong": "1" } });
  emit("Network.responseReceived", { requestId: "R1", response: resp("https://a.test/", 200, { A: "b" }) });
  emit("Network.loadingFinished", { requestId: "R1" });
  const [ex] = await rec.finish();
  assert.equal(ex!.hops[0]!.response?.headersSource, "filtered");
  assert.deepEqual(ex!.hops[0]!.response?.headers, [["A", "b"]]);
});

test("a failed subresource is recorded as failed with no body and no body fetch; interleaved request ids stay apart", async () => {
  const { session, emit, calls } = fakeSession({ D: text("doc"), S2: { body: Buffer.from([1, 2, 3]).toString("base64"), base64Encoded: true } });
  const rec = createCdpRecorder(session, LIMITS);
  await rec.start();
  emit("Network.requestWillBeSent", req("D", "https://a.test/"));
  emit("Network.requestWillBeSent", { ...req("S1", "https://cdn.test/x.js"), loaderId: "D", type: "Script" });
  emit("Network.requestWillBeSent", { ...req("S2", "https://cdn.test/y.png"), loaderId: "D", type: "Image" });
  emit("Network.responseReceived", { requestId: "S2", response: resp("https://cdn.test/y.png", 200) });
  emit("Network.responseReceived", { requestId: "D", response: resp("https://a.test/", 200) });
  emit("Network.loadingFailed", { requestId: "S1", errorText: "net::ERR_TUNNEL_CONNECTION_FAILED", canceled: false });
  emit("Network.loadingFinished", { requestId: "S2" });
  emit("Network.loadingFinished", { requestId: "D" });
  const exs = await rec.finish();
  const by = Object.fromEntries(exs.map((e) => [e.requestId, e]));
  assert.equal(by.S1!.state, "failed");
  assert.deepEqual(by.S1!.failure, { canceled: false, blocked: false });
  assert.equal(by.S1!.hops[0]!.response, null);
  assert.equal(by.S1!.navigation, false);
  assert.deepEqual([...by.S2!.hops[0]!.body.bytes], [1, 2, 3]);
  assert.equal(Buffer.from(by.D!.hops[0]!.body.bytes).toString(), "doc");
  assert.ok(!calls.some((c) => c.params?.requestId === "S1"));
  assert.equal(mainDocument(exs, "F1", "https://a.test/#frag"), by.D);
});

test("a body over the per-body cap is truncated and recorded; one over the allocation bound is not fetched; the total budget is enforced", async () => {
  const big = "x".repeat(3000);
  const { session, emit, calls } = fakeSession({ A: text(big), B: text("y".repeat(5000)), C: text("z".repeat(100)), D: text("w") });
  const rec = createCdpRecorder(session, { perBodyMaxBytes: 1024, perBodyAllocationMaxBytes: 4096, totalMaxBytes: 1100 });
  await rec.start();
  for (const id of ["A", "B", "C"]) {
    emit("Network.requestWillBeSent", { ...req(id, `https://a.test/${id}`), type: "Other" });
    emit("Network.responseReceived", { requestId: id, response: resp(`https://a.test/${id}`, 200) });
  }
  emit("Network.dataReceived", { requestId: "B", dataLength: 5000 });
  emit("Network.loadingFinished", { requestId: "A" });
  emit("Network.loadingFinished", { requestId: "B" });
  const after = await rec.finish();
  const by = Object.fromEntries(after.map((e) => [e.requestId, e]));
  assert.equal(by.A!.hops[0]!.body.state, "truncated");
  assert.equal(by.A!.hops[0]!.body.bytes.byteLength, 1024);
  assert.equal(by.A!.hops[0]!.body.fullBytes, 3000);
  assert.equal(by.B!.hops[0]!.body.omission, "over_allocation_bound");
  assert.ok(!calls.some((c) => c.params?.requestId === "B"), "an over-allocation body is never fetched");
  assert.equal(by.C!.state, "unfinished");
  assert.equal(by.C!.hops[0]!.body.omission, "no_body");
  // Events after finish are ignored.
  emit("Network.loadingFinished", { requestId: "C" });
  assert.equal(by.C!.state, "unfinished");

  const second = fakeSession({ A: text("a".repeat(1000)), C: text("c".repeat(500)), D: text("d") });
  const rec2 = createCdpRecorder(second.session, { perBodyMaxBytes: 1024, perBodyAllocationMaxBytes: 4096, totalMaxBytes: 1100 });
  await rec2.start();
  for (const id of ["A", "C", "D"]) {
    second.emit("Network.requestWillBeSent", { ...req(id, `https://a.test/${id}`), type: "Other" });
    second.emit("Network.responseReceived", { requestId: id, response: resp(`https://a.test/${id}`, 200) });
  }
  second.emit("Network.loadingFinished", { requestId: "A" });
  await new Promise((r) => setImmediate(r));
  second.emit("Network.loadingFinished", { requestId: "C" });
  await new Promise((r) => setImmediate(r));
  second.emit("Network.loadingFinished", { requestId: "D" });
  const b2 = Object.fromEntries((await rec2.finish()).map((e) => [e.requestId, e]));
  assert.equal(b2.A!.hops[0]!.body.state, "complete");
  assert.equal(b2.C!.hops[0]!.body.state, "truncated");
  assert.equal(b2.C!.hops[0]!.body.bytes.byteLength, 100);
  assert.equal(b2.D!.hops[0]!.body.omission, "over_total_bound");
});

test("an unavailable body is not_retained; HEAD, 204 and 304 have no body and are not fetched; non-http(s) requests are not recorded", async () => {
  const { session, emit, calls } = fakeSession({});
  const rec = createCdpRecorder(session, LIMITS);
  await rec.start();
  emit("Network.requestWillBeSent", { ...req("G", "https://a.test/g"), type: "Image" });
  emit("Network.responseReceived", { requestId: "G", response: resp("https://a.test/g", 200) });
  emit("Network.loadingFinished", { requestId: "G" });
  emit("Network.requestWillBeSent", { ...req("N", "https://a.test/n"), type: "Fetch" });
  emit("Network.responseReceived", { requestId: "N", response: resp("https://a.test/n", 304) });
  emit("Network.loadingFinished", { requestId: "N" });
  emit("Network.requestWillBeSent", { ...req("U", "data:text/plain,hi"), type: "Other" });
  emit("Network.requestWillBeSent", "not an object");
  const exs = await rec.finish();
  assert.deepEqual(
    exs.map((e) => [e.requestId, e.hops[0]!.body.omission]),
    [
      ["G", "not_retained"],
      ["N", "no_body"],
    ],
  );
  assert.deepEqual(
    calls.filter((c) => c.method === "Network.getResponseBody").map((c) => c.params?.requestId),
    ["G"],
  );
});

test("mainDocument picks the main-frame navigation that reached the final URL, never an iframe or a subresource", () => {
  const ex = (requestId: string, frameId: string, navigation: boolean, url: string) => ({
    requestId,
    frameId,
    resourceType: "Document",
    navigation,
    state: "finished" as const,
    hops: [
      {
        url,
        method: "GET",
        requestHeaders: [],
        requestHeadersSource: "filtered" as const,
        postData: null,
        wallTimeMs: null,
        response: { url, status: 200, statusText: "", protocol: null, mimeType: null, headers: [], headersSource: "filtered" as const },
        body: { state: "omitted" as const, bytes: new Uint8Array(), omission: "no_body" as const },
      },
    ],
  });
  const iframe = ex("I", "F2", true, "https://a.test/final");
  const sub = ex("S", "F1", false, "https://a.test/final");
  const first = ex("D1", "F1", true, "https://a.test/first");
  const second = ex("D2", "F1", true, "https://a.test/final");
  assert.equal(mainDocument([iframe, sub, first, second], "F1", "https://a.test/final"), second);
  assert.equal(mainDocument([iframe, sub, first], "F1", "https://a.test/final"), first);
  assert.equal(mainDocument([iframe, sub], "F1", "https://a.test/final"), undefined);
});

test("headerLines splits CDP's joined values and drops HTTP/2 pseudo-headers", () => {
  assert.deepEqual(headerLines({ ":path": "/", a: "1\n2", b: "3" }), [
    ["a", "1"],
    ["a", "2"],
    ["b", "3"],
  ]);
});

test("limits must be positive integers", () => {
  const { session } = fakeSession();
  assert.throws(() => createCdpRecorder(session, { ...LIMITS, totalMaxBytes: 0 }), /positive integers/);
  assert.throws(() => createCdpRecorder(session, { ...LIMITS, perBodyMaxBytes: Number.NaN }), /positive integers/);
});
