// Explicit local-Docker gate only. No transport, provider call, credential read or model spend.
// Uses the pinned Pi API, never loaded by the normal manifest or browser profile.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// biome-ignore lint/suspicious/noExplicitAny: these host stream types are resolved by the pinned Pi runtime
function stream(model: any, context: any, options: any) {
  const out = createAssistantMessageEventStream();
  const turn = context.messages.filter((m: { role: string }) => m.role === "toolResult").length;
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
  queueMicrotask(() => {
    out.push({ type: "start", partial: message });
    if (options?.signal?.aborted) {
      out.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "offline fixture cancelled" } });
      out.end();
      return;
    }
    if (turn === 0) {
      const toolCall = {
        type: "toolCall",
        id: "offline-capture",
        name: "browser_capture",
        arguments: { url: process.env.PTREE_TEST_CAPTURE_URL, maxBytes: 65536, deadlineMs: 20000 },
      };
      message.content.push(toolCall);
      message.stopReason = "toolUse";
      out.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      out.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      out.push({ type: "done", reason: "toolUse", message });
    } else {
      message.content.push({ type: "text", text: "offline capture complete" });
      out.push({ type: "text_start", contentIndex: 0, partial: message });
      out.push({ type: "text_end", contentIndex: 0, content: "offline capture complete", partial: message });
      out.push({ type: "done", reason: "stop", message });
    }
    out.end();
  });
  return out;
}
export default function (pi: ExtensionAPI) {
  pi.registerProvider("pomtree-offline-capture", {
    baseUrl: "http://unused.invalid",
    apiKey: "offline-fixture-no-credential",
    api: "pomtree-offline-capture",
    models: [
      {
        id: "scripted",
        name: "Local capture gate",
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
