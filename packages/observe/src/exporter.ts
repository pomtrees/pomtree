import type { AgentId, Journal, JournalEntry } from "@pomtree/core";
import { SpanTracker, type AttributeValue, type Span } from "./spans.ts";
import { toOtlpRequest } from "./otlp.ts";

// Thin shell around the pure span/OTLP mapping. The network is one injectable
// fetch-like call, so tests never leave the host.

export interface FetchResponseLike {
  ok: boolean;
  status: number;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface ExporterStats {
  exportedSpans: number; // spans acknowledged by the endpoint
  failedPosts: number; // individual POST attempts that threw or got a non-2xx
  droppedBatches: number; // batches abandoned after exhausting retries
}

export interface OtlpExporterOptions {
  endpoint: string; // collector base URL, e.g. "http://localhost:4318"; "/v1/traces" is appended
  fetch?: FetchLike; // defaults to globalThis.fetch
  headers?: Record<string, string>; // extra headers, e.g. auth
  sleep?: (ms: number) => Promise<void>; // backoff clock, injectable for tests
  maxRetries?: number; // attempts after the first; default 3
  timeoutMs?: number; // per POST attempt; a collector that never answers counts as a failed attempt; default 10000
  baseDelayMs?: number; // delay before retry i is baseDelayMs * 2^i; default 200
  batchSize?: number; // flush threshold while streaming; default 64
  resource?: Record<string, AttributeValue>; // OTLP resource attributes, e.g. service.name
  includeContent?: boolean; // prompt/tool text in spans; off by default (see spans.ts)
}

// Handle for a running export loop: it is the promise that settles when the loop has
// drained (so `await exporter.run(journal)` still waits for the whole stream), plus a
// `close()` that stops the journal subscription — the loop then flushes via its normal
// `finally` and settles. Close is idempotent; a daemon calls it on shutdown.
export interface RunHandle extends Promise<void> {
  close(): void;
}

// Failure policy: bounded retry with exponential backoff, then drop-with-counter.
// A failing endpoint never kills the journal subscription — each batch is retried
// up to maxRetries times and then dropped, counted in stats.droppedBatches, and
// the stream continues. Permanent client errors (4xx other than 408/429) are not retried.
const retryable = (status: number) => status < 400 || status >= 500 || status === 408 || status === 429;

// TODO(perf-observability): add performance telemetry. Current behavior: this exporter posts traces only, to /v1/traces.
// Its stats counters are read only inside this class; no code under packages uses perf_hooks or process.memoryUsage.
export class OtlpExporter {
  readonly stats: ExporterStats = { exportedSpans: 0, failedPosts: 0, droppedBatches: 0 };
  readonly #tracker: SpanTracker;
  readonly #opts: OtlpExporterOptions;
  #buffer: Span[] = [];

  constructor(opts: OtlpExporterOptions) {
    this.#opts = opts;
    this.#tracker = new SpanTracker({ includeContent: opts.includeContent });
  }

  // Hand out what a finished stream leaves open (running agents, interrupted tools) and post it.
  async finish(): Promise<void> {
    this.#buffer.push(...this.#tracker.drain());
    await this.flush();
  }

  // Fold one journal entry; spans it completes queue for the next flush.
  apply(e: JournalEntry): void {
    this.#buffer.push(...this.#tracker.apply(e));
  }

  get pending(): number {
    return this.#buffer.length;
  }

  run(journal: Journal, opts: { from?: number; agent?: AgentId } = {}): RunHandle {
    const sub = journal.subscribe({ from: opts.from ?? 0, agent: opts.agent });
    const loop = (async () => {
      try {
        for await (const e of sub) {
          this.apply(e);
          if (this.#buffer.length >= (this.#opts.batchSize ?? 64)) await this.flush();
        }
      } finally {
        sub.close();
        await this.finish();
      }
    })();
    return Object.assign(loop, { close: () => sub.close() });
  }

  // Post the queued spans. No-op when empty; never rejects — endpoint failures and batches
  // that cannot be encoded are counted in stats, not thrown, so a caller's stream loop survives.
  async flush(): Promise<void> {
    const batch = this.#buffer;
    if (batch.length === 0) return;
    this.#buffer = [];
    try {
      await this.#post(batch);
    } catch {
      this.stats.droppedBatches++;
    }
  }

  async #post(batch: Span[]): Promise<void> {
    const url = `${this.#opts.endpoint.replace(/\/+$/, "")}/v1/traces`;
    const headers: Record<string, string> = { "content-type": "application/json", ...this.#opts.headers };
    const body = JSON.stringify(toOtlpRequest(batch, this.#opts.resource ?? {}));
    const fetchFn: FetchLike = this.#opts.fetch ?? globalThis.fetch;
    const sleep = this.#opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const retries = this.#opts.maxRetries ?? 3;
    const timeoutMs = this.#opts.timeoutMs ?? 10_000;
    for (let attempt = 0; ; attempt++) {
      let again = true;
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Race as well as abort: an injected fetch may ignore the signal.
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctl.abort();
            reject(new Error(`export timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        const res = await Promise.race([fetchFn(url, { method: "POST", headers, body, signal: ctl.signal }), timeout]);
        if (res.ok) {
          this.stats.exportedSpans += batch.length;
          return;
        }
        this.stats.failedPosts++;
        again = retryable(res.status);
      } catch {
        this.stats.failedPosts++;
      } finally {
        clearTimeout(timer);
      }
      if (!again || attempt >= retries) break;
      await sleep((this.#opts.baseDelayMs ?? 200) * 2 ** attempt);
    }
    this.stats.droppedBatches++;
  }
}
