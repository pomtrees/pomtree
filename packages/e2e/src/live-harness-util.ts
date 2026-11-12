// Process and polling helpers shared by the live crash-recovery harnesses (crash-recovery-live.ts, crash-recovery-live-multi.ts):
// a deadline and a fatal error type, a bounded `until` poll, a promise-wrapped execFile, a free loopback port and a unix-socket GET.
import { execFile } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { until as pollUntil } from "@pomtree/testing";

export class Deadline extends Error {}
export class Fatal extends Error {} // thrown inside an `until` probe: stops the polling at once instead of being retried
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function sh(cmd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 60_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { env, timeout, maxBuffer: 16 * 1024 ** 2 }, (e, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err) }),
    ),
  );
}
export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}
export function getSock(sock: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ socketPath: sock, path }, (r) => {
      r.resume();
      resolve(r.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}
export async function until<T>(what: string, ms: number, f: () => Promise<T | undefined> | T | undefined): Promise<T> {
  let found: T | undefined;
  const probe = async () => {
    found = await Promise.resolve()
      .then(f)
      .catch((e) => {
        if (e instanceof Deadline || e instanceof Fatal) throw e;
        return undefined;
      });
    return found !== undefined;
  };
  try {
    await pollUntil(probe, ms, { what, intervalMs: 500 });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("timed out waiting for ")) throw e; // an invalid scale or ms is not a timeout
    throw new Deadline(`timeout waiting for ${what}`, { cause: e }); // the shared error (budget, scale, elapsed) rides on `cause`
  }
  return found as T;
}
