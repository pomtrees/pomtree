import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeProbeRunner } from "./probe-fake.ts";

test("FakeProbeRunner returns the scripted result for an exact command line and records each call", async () => {
  const r = new FakeProbeRunner({ "git --version": { code: 0, stdout: "git version 2.43.0\n", stderr: "" } });
  assert.deepEqual(await r.run("git", ["--version"]), { code: 0, stdout: "git version 2.43.0\n", stderr: "" });
  assert.deepEqual(r.calls, [{ command: "git", args: ["--version"] }]);
});

test("FakeProbeRunner treats an unscripted or inexact command as not on PATH (negative control)", async () => {
  const r = new FakeProbeRunner({ "git --version": { code: 0, stdout: "x", stderr: "" } });
  assert.equal((await r.run("git", ["--versions"])).code, null);
  assert.equal((await r.run("docker", ["--version"])).code, null);
  assert.equal(r.calls.length, 2);
});

test("FakeProbeRunner records the timeout, cwd and env a command was given, and only those given", async () => {
  const r = new FakeProbeRunner();
  await r.run("a", []);
  await r.run("b", ["x"], { timeoutMs: 30_000 });
  await r.run("c", [], { cwd: "/co", env: { K: "v" } });
  assert.deepEqual(r.calls, [
    { command: "a", args: [] },
    { command: "b", args: ["x"], timeoutMs: 30_000 },
    { command: "c", args: [], cwd: "/co", env: { K: "v" } },
  ]);
});
