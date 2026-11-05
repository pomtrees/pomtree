// Explicit local-Docker gate only. No provider call, credential read or model spend. The scripted "model" runs two probes from inside
// the browser worker and reports both in its one text reply: Pi's own call to the relay authority (through HTTP_PROXY, the relay-granting
// listener) and a Chromium page whose script requests the same authority (through Chromium's --proxy-server, the browser listener).
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CDP = "http://127.0.0.1:9222";
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function piRelayStatus(relay: string): Promise<string> {
  try {
    return String((await fetch(`${relay}/pi-relay-ok`)).status);
  } catch (error) {
    return `error:${(error as Error).name}`;
  }
}

// The page is a data: document, so it loads without any network; its script then asks for the relay authority over plain HTTP and
// TLS (CONNECT), and for Chromium's own loopback DevTools port. Its title reports that the script ran to completion.
async function pageScriptTitle(relay: string): Promise<string> {
  const page = `<!doctype html><title>pending</title><script>
const r = ${JSON.stringify(relay)};
Promise.allSettled([
  fetch(r + "/page-probe", { mode: "no-cors" }),
  fetch(r.replace("http:", "https:") + "/page-probe-tls", { mode: "no-cors" }),
  fetch("http://127.0.0.1:9222/json/version", { mode: "no-cors" }),
]).then((x) => { document.title = "done:" + x.map((y) => y.status).join(","); });
</script>`;
  await fetch(`${CDP}/json/new?data:text/html,${encodeURIComponent(page)}`, { method: "PUT" });
  for (let i = 0; i < 100; i++) {
    const targets = (await (await fetch(`${CDP}/json/list`)).json()) as { title: string }[];
    const done = targets.find((t) => t.title.startsWith("done:"));
    if (done) return done.title;
    await settle(100);
  }
  return "timeout";
}

// biome-ignore lint/suspicious/noExplicitAny: these host stream types are resolved by the pinned Pi runtime
function stream(model: any) {
  const out = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [] as unknown[],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  void (async () => {
    out.push({ type: "start", partial: message });
    const relay = process.env.PTREE_TEST_RELAY_URL ?? "";
    const text = `probe pi=${await piRelayStatus(relay)} page=${await pageScriptTitle(relay).catch((e) => `error:${(e as Error).name}`)}`;
    message.content.push({ type: "text", text });
    out.push({ type: "text_start", contentIndex: 0, partial: message });
    out.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    out.push({ type: "done", reason: "stop", message });
    out.end();
  })();
  return out;
}
export default function (pi: ExtensionAPI) {
  pi.registerProvider("pomtree-offline-relay-probe", {
    baseUrl: "http://unused.invalid",
    apiKey: "offline-fixture-no-credential",
    api: "pomtree-offline-relay-probe",
    models: [
      {
        id: "scripted",
        name: "Local relay-reach gate",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
    streamSimple: stream,
  });
}
