import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analystToolViolation,
  browserToolViolation,
  declaredToolNames,
  dispatchBrowserWorkerTool,
  type ModelStub,
  type StubReply,
  type StubRequest,
  startModelStub,
} from "./content-live-stub.mts";

type Chunk = {
  id: string;
  object: string;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string; tool_calls?: { index: number; id?: string; function: { name?: string; arguments?: string } }[] };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

async function withStub<T>(respond: (req: StubRequest, index: number) => StubReply, fn: (stub: ModelStub) => Promise<T>): Promise<T> {
  const stub = await startModelStub({ respond });
  try {
    return await fn(stub);
  } finally {
    await stub.close();
  }
}

function completionBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: "test/model", messages: [{ role: "user", content: "hi" }], ...extra });
}

async function post(stub: ModelStub, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${stub.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

// Parses an SSE body into its JSON data chunks; asserts it ends with [DONE].
async function sseChunks(res: Response): Promise<Chunk[]> {
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const events = (await res.text()).split("\n\n").filter((e) => e.length > 0);
  assert.equal(events.at(-1), "data: [DONE]");
  return events.slice(0, -1).map((e) => {
    assert.ok(e.startsWith("data: "), `unexpected SSE event: ${e}`);
    return JSON.parse(e.slice("data: ".length)) as Chunk;
  });
}

type AnthropicFrame = {
  type: string;
  index?: number;
  message?: { content: unknown[]; usage: { input_tokens: number; output_tokens: number } };
  content_block?: { type: string; id?: string; name?: string; text?: string; input?: unknown };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; stop_sequence?: null };
  usage?: { output_tokens: number };
};

function messagesBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "test/model",
    system: "be brief",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ name: "fetch_article", description: "fetch", input_schema: { type: "object" } }],
    max_tokens: 1024,
    ...extra,
  });
}

async function postMessages(url: string, body: string): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
}

// Parses an Anthropic SSE body into [event name, data] frames; each frame is exactly `event:` line then `data:` line.
async function anthropicEvents(res: Response): Promise<{ event: string; data: AnthropicFrame }[]> {
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const frames = (await res.text()).split("\n\n").filter((f) => f.length > 0);
  return frames.map((frame) => {
    const lines = frame.split("\n");
    assert.equal(lines.length, 2, `unexpected SSE frame: ${frame}`);
    const [eventLine = "", dataLine = ""] = lines;
    assert.ok(eventLine.startsWith("event: ") && dataLine.startsWith("data: "), `unexpected SSE frame: ${frame}`);
    const event = eventLine.slice("event: ".length);
    const data = JSON.parse(dataLine.slice("data: ".length)) as AnthropicFrame;
    assert.equal(data.type, event);
    return { event, data };
  });
}

describe("startModelStub", () => {
  it("answers a non-streaming text completion", async () => {
    await withStub(
      () => ({ kind: "text", text: "hello there" }),
      async (stub) => {
        const res = await post(stub, completionBody());
        assert.equal(res.status, 200);
        const json = (await res.json()) as {
          object: string;
          model: string;
          choices: { message: { role: string; content: string }; finish_reason: string }[];
          usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        };
        assert.equal(json.object, "chat.completion");
        assert.equal(json.model, "test/model");
        assert.equal(json.choices[0]?.message.role, "assistant");
        assert.equal(json.choices[0]?.message.content, "hello there");
        assert.equal(json.choices[0]?.finish_reason, "stop");
        assert.deepEqual(json.usage, { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
      },
    );
  });

  it("answers a non-streaming tool call whose arguments parse back to the args", async () => {
    const args = { url: "https://example.com/a", depth: 2 };
    await withStub(
      () => ({ kind: "tool", name: "fetch_article", args }),
      async (stub) => {
        const res = await post(stub, completionBody());
        const json = (await res.json()) as {
          choices: {
            message: { content: null; tool_calls: { type: string; function: { name: string; arguments: string } }[] };
            finish_reason: string;
          }[];
        };
        const choice = json.choices[0];
        assert.equal(choice?.finish_reason, "tool_calls");
        assert.equal(choice?.message.content, null);
        const call = choice?.message.tool_calls[0];
        assert.equal(call?.type, "function");
        assert.equal(call?.function.name, "fetch_article");
        assert.deepEqual(JSON.parse(call?.function.arguments ?? "null"), args);
      },
    );
  });

  it("streams a text completion as SSE that reassembles to the text", async () => {
    const text = "streamed answer";
    await withStub(
      () => ({ kind: "text", text }),
      async (stub) => {
        const chunks = await sseChunks(await post(stub, completionBody({ stream: true })));
        assert.ok(chunks.every((c) => c.object === "chat.completion.chunk"));
        assert.deepEqual(chunks[0]?.choices[0]?.delta, { role: "assistant" });

        const pieces = chunks.map((c) => c.choices[0]?.delta.content).filter((p): p is string => p !== undefined);
        assert.ok(pieces.length >= 2, "text must arrive in at least two content pieces");
        assert.equal(pieces.join(""), text);

        const finish = chunks.find((c) => c.choices[0]?.finish_reason !== null);
        assert.equal(finish?.choices[0]?.finish_reason, "stop");

        const last = chunks.at(-1);
        assert.deepEqual(last?.choices, []);
        assert.deepEqual(last?.usage, { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
      },
    );
  });

  it("streams a tool call whose argument pieces reassemble to the JSON of the args", async () => {
    const args = { url: "https://example.com/some/long/path?q=1", tags: ["a", "b"] };
    await withStub(
      () => ({ kind: "tool", name: "fetch_article", args }),
      async (stub) => {
        const chunks = await sseChunks(await post(stub, completionBody({ stream: true })));
        const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
        assert.ok(calls.length >= 2, "arguments must arrive in at least two pieces");
        assert.equal(calls[0]?.id, "call_stub_0");
        assert.equal(calls[0]?.function.name, "fetch_article");
        assert.ok(
          calls.slice(1).every((c) => c.function.name === undefined),
          "name appears only in the first piece",
        );
        assert.equal(calls.map((c) => c.function.arguments ?? "").join(""), JSON.stringify(args));

        const finish = chunks.find((c) => c.choices[0]?.finish_reason !== null);
        assert.equal(finish?.choices[0]?.finish_reason, "tool_calls");
        assert.deepEqual(chunks.at(-1)?.usage, { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
      },
    );
  });

  it("with servePaths, serves only those exact paths: the doubled /v1/v1 path and suffix matches 404 and are still recorded", async () => {
    const stub = await startModelStub({ respond: () => ({ kind: "text", text: "ok" }), servePaths: ["/api/v1/messages"] });
    try {
      const origin = stub.baseUrl.replace(/\/api\/v1$/, "");
      const send = (path: string) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: completionBody() });
      assert.equal((await send("/api/v1/messages?beta=true")).status, 200);
      assert.equal((await send("/api/v1/v1/messages?beta=true")).status, 404);
      assert.equal((await send("/v1/messages")).status, 404);
      assert.equal((await send("/api/v1/chat/completions")).status, 404);
      assert.equal(stub.requests.length, 4);
    } finally {
      await stub.close();
    }
  });

  it("answers any other path or method with 404 JSON and still records it", async () => {
    await withStub(
      () => {
        throw new Error("respond must not run for non-completion requests");
      },
      async (stub) => {
        const models = await fetch(`${stub.baseUrl}/models`);
        assert.equal(models.status, 404);
        assert.equal(models.headers.get("content-type"), "application/json");
        assert.ok(typeof ((await models.json()) as { error?: { message?: unknown } }).error?.message === "string");

        const get = await fetch(`${stub.baseUrl}/chat/completions`);
        assert.equal(get.status, 404);

        const wrongPath = await fetch(`${stub.baseUrl}/models`, { method: "POST", body: "not json" });
        assert.equal(wrongPath.status, 404);

        assert.deepEqual(
          stub.requests.map((r) => [r.method, r.url]),
          [
            ["GET", "/api/v1/models"],
            ["GET", "/api/v1/chat/completions"],
            ["POST", "/api/v1/models"],
          ],
        );
        assert.equal(stub.requests[2]?.body, "not json", "non-JSON bodies are kept as the raw string");
      },
    );
  });

  it("records the headers the client sent", async () => {
    await withStub(
      () => ({ kind: "text", text: "ok" }),
      async (stub) => {
        await post(stub, completionBody(), { authorization: "Bearer test-key-123" });
        assert.equal(stub.requests.length, 1);
        assert.equal(stub.requests[0]?.headers.authorization, "Bearer test-key-123");
        assert.equal(stub.requests[0]?.method, "POST");
        assert.deepEqual((stub.requests[0]?.body as { model?: unknown } | undefined)?.model, "test/model");
      },
    );
  });

  it("passes an increasing 0-based completion index to respond", async () => {
    const seen: number[] = [];
    await withStub(
      (_req, index) => {
        seen.push(index);
        return { kind: "text", text: `reply ${index}` };
      },
      async (stub) => {
        for (let i = 0; i < 3; i++) {
          const json = (await (await post(stub, completionBody())).json()) as {
            choices: { message: { content: string } }[];
          };
          assert.equal(json.choices[0]?.message.content, `reply ${i}`);
        }
        await fetch(`${stub.baseUrl}/models`);
        assert.deepEqual(seen, [0, 1, 2]);
      },
    );
  });

  it("answers 500 JSON when respond throws and records only that request", async () => {
    await withStub(
      () => {
        throw new Error("scripted failure");
      },
      async (stub) => {
        const res = await post(stub, completionBody({ stream: true }));
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: { message: "scripted failure" } });
        assert.equal(stub.requests.length, 1);
      },
    );
  });

  it("answers a non-streaming Anthropic Messages text reply", async () => {
    await withStub(
      () => ({ kind: "text", text: "hello there" }),
      async (stub) => {
        const res = await postMessages(`${stub.baseUrl}/messages`, messagesBody());
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {
          id: "msg_stub_0",
          type: "message",
          role: "assistant",
          model: "test/model",
          content: [{ type: "text", text: "hello there" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 40 },
        });
        assert.equal((stub.requests[0]?.body as { system?: unknown } | undefined)?.system, "be brief");
      },
    );
  });

  it("answers a non-streaming Anthropic tool_use whose input equals the args", async () => {
    const args = { url: "https://example.com/a", depth: 2 };
    await withStub(
      () => ({ kind: "tool", name: "fetch_article", args }),
      async (stub) => {
        const json = (await (await postMessages(`${stub.baseUrl}/messages`, messagesBody())).json()) as {
          content: { type: string; id: string; name: string; input: unknown }[];
          stop_reason: string;
        };
        assert.equal(json.stop_reason, "tool_use");
        assert.deepEqual(json.content, [{ type: "tool_use", id: "toolu_stub_0", name: "fetch_article", input: args }]);
      },
    );
  });

  it("streams an Anthropic text reply as the message_start ... message_stop sequence", async () => {
    const text = "streamed answer";
    await withStub(
      () => ({ kind: "text", text }),
      async (stub) => {
        const events = await anthropicEvents(await postMessages(`${stub.baseUrl}/messages`, messagesBody({ stream: true })));
        const names = events.map((e) => e.event);
        assert.equal(names[0], "message_start");
        assert.equal(names[1], "content_block_start");
        const deltas = names.slice(2, -3);
        assert.ok(deltas.length >= 2 && deltas.every((n) => n === "content_block_delta"), `deltas: ${deltas.join(",")}`);
        assert.deepEqual(names.slice(-3), ["content_block_stop", "message_delta", "message_stop"]);

        const start = events[0]?.data;
        assert.deepEqual(start?.message?.content, []);
        assert.deepEqual(start?.message?.usage, { input_tokens: 120, output_tokens: 1 });
        assert.deepEqual(events[1]?.data.content_block, { type: "text", text: "" });

        const pieces = events.flatMap((e) => (e.data.delta?.type === "text_delta" ? [e.data.delta.text ?? ""] : []));
        assert.equal(pieces.length, deltas.length);
        assert.equal(pieces.join(""), text);

        const end = events.at(-2)?.data;
        assert.deepEqual(end?.delta, { stop_reason: "end_turn", stop_sequence: null });
        assert.deepEqual(end?.usage, { input_tokens: 120, output_tokens: 40 });
      },
    );
  });

  it("streams an Anthropic tool_use whose partial_json pieces reassemble to the args", async () => {
    const args = { url: "https://example.com/some/long/path?q=1", tags: ["a", "b"] };
    await withStub(
      () => ({ kind: "tool", name: "fetch_article", args }),
      async (stub) => {
        const events = await anthropicEvents(await postMessages(`${stub.baseUrl}/messages`, messagesBody({ stream: true })));
        const block = events.find((e) => e.event === "content_block_start")?.data.content_block;
        assert.deepEqual(block, { type: "tool_use", id: "toolu_stub_0", name: "fetch_article", input: {} });

        const partials = events.flatMap((e) => (e.data.delta?.type === "input_json_delta" ? [e.data.delta.partial_json ?? ""] : []));
        assert.ok(partials.length >= 2, "arguments must arrive in at least two pieces");
        assert.deepEqual(JSON.parse(partials.join("")), args);

        const end = events.at(-2)?.data;
        assert.equal(end?.delta?.stop_reason, "tool_use");
        assert.deepEqual(end?.usage, { input_tokens: 120, output_tokens: 40 });
      },
    );
  });

  it("answers and records a Messages path with a query string", async () => {
    const seen: number[] = [];
    await withStub(
      (_req, index) => {
        seen.push(index);
        return { kind: "text", text: "queried" };
      },
      async (stub) => {
        const res = await postMessages(`${stub.baseUrl}/v1/messages?beta=true`, messagesBody());
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as { content: { text: string }[] }).content[0]?.text, "queried");
        assert.deepEqual(
          stub.requests.map((r) => [r.method, r.url]),
          [["POST", "/api/v1/v1/messages?beta=true"]],
        );
        assert.equal((stub.requests[0]?.body as { model?: unknown } | undefined)?.model, "test/model");
        assert.deepEqual(seen, [0]);
      },
    );
  });

  it("shares one completion index between the OpenAI and Anthropic routes", async () => {
    await withStub(
      (_req, index) => ({ kind: "text", text: `reply ${index}` }),
      async (stub) => {
        const openai = (await (await post(stub, completionBody())).json()) as { id: string };
        const anthropic = (await (await postMessages(`${stub.baseUrl}/messages`, messagesBody())).json()) as { id: string };
        assert.equal(openai.id, "chatcmpl-stub-0");
        assert.equal(anthropic.id, "msg_stub_1");
      },
    );
  });
});

describe("browser worker tool set", () => {
  const anthropic = (...names: string[]) => ({ tools: names.map((name) => ({ name })) });
  const openai = (...names: string[]) => ({ tools: names.map((name) => ({ type: "function", function: { name } })) });

  it("accepts exactly browser_capture and capture_finish in either wire format", () => {
    assert.equal(browserToolViolation(anthropic("capture_finish", "browser_capture")), null);
    assert.equal(browserToolViolation(openai("browser_capture", "capture_finish")), null);
    assert.deepEqual(declaredToolNames(openai("a")), ["a"]);
  });

  it("rejects a bash tool, a missing tool, a duplicate and an undeclared set", () => {
    assert.match(browserToolViolation(anthropic("browser_capture", "capture_finish", "bash")) ?? "", /bash/);
    assert.match(browserToolViolation(anthropic("browser_capture")) ?? "", /differ/);
    assert.match(browserToolViolation(anthropic("browser_capture", "browser_capture")) ?? "", /differ/);
    assert.match(browserToolViolation({ messages: [] }) ?? "", /no tools/);
  });

  it("dispatches only the allowlisted tools; bash is tool-not-found", () => {
    assert.deepEqual(dispatchBrowserWorkerTool("capture_finish"), { ok: true, text: "ok" });
    assert.deepEqual(dispatchBrowserWorkerTool("bash"), { ok: false, text: "Tool bash not found" });
  });
});

describe("analyst tool set", () => {
  const anthropic = (...names: string[]) => ({ tools: names.map((name) => ({ name })) });

  it("accepts exactly article_page and analysis_result, in either order", () => {
    assert.equal(analystToolViolation(anthropic("article_page", "analysis_result")), null);
    assert.equal(analystToolViolation(anthropic("analysis_result", "article_page")), null);
  });

  it("rejects a shell, file, web or browser tool, a missing tool, a duplicate and an undeclared set", () => {
    for (const extra of ["bash", "read", "write", "edit", "web_fetch", "web_search", "browser_capture", "capture_finish"])
      assert.match(analystToolViolation(anthropic("article_page", "analysis_result", extra)) ?? "", new RegExp(extra), extra);
    assert.match(analystToolViolation(anthropic("article_page")) ?? "", /differ/);
    assert.match(analystToolViolation(anthropic("article_page", "article_page")) ?? "", /differ/);
    assert.match(analystToolViolation(anthropic("bash", "read", "write", "edit")) ?? "", /differ/);
    assert.match(analystToolViolation({ messages: [] }) ?? "", /no tools/);
  });
});
