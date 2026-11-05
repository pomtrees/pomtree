import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { envLine, envValue, nestedConfigJson, parseEnvText, renderService } from "./render.ts";

const unit = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "deploy", "pomtreed.service"), "utf8");
const paths = { checkout: "/opt/p", node: "/usr/bin/node", envFile: "/home/u/.config/pomtreed/pomtreed.env", stateDir: "/var/lib/p", repoDir: "/srv/r" };

test("envLine quotes only when needed and parseEnvText inverts it", () => {
  const text = [envLine("A", "plain/x:1"), envLine("B", '{"a": 1}'), envLine("C", "")].join("\n");
  assert.equal(text, `A=plain/x:1\nB='{"a": 1}'\nC=`);
  assert.deepEqual(parseEnvText(`# c\n\n${text}\n`), { A: "plain/x:1", B: '{"a": 1}', C: "" });
});

test("envLine refuses a quote or newline, naming the key and the action", () => {
  assert.throws(() => envLine("K", "it's"), /K: .*json/);
  assert.throws(() => envLine("K", "a\nb"), /K: /);
});

test("envValue renders lists, structures and scalars", () => {
  assert.equal(envValue(["a", "b"]), "a,b");
  assert.equal(envValue({ x: 1 }), '{"x":1}');
  assert.equal(envValue(false), "false");
});

test("nestedConfigJson nests by path segment with a trailing newline", () => {
  assert.equal(
    nestedConfigJson({ "model.baseUrl": "u", "model.x": 1, "pi.provider": "p" }),
    `${JSON.stringify({ model: { baseUrl: "u", x: 1 }, pi: { provider: "p" } }, null, 2)}\n`,
  );
});

test("renderService replaces every host line of the real deploy/pomtreed.service and leaves the rest", () => {
  const out = renderService(unit, paths);
  for (const want of [
    "ExecStart=/usr/bin/node /opt/p/packages/pomtreed/src/main.ts",
    "WorkingDirectory=/opt/p",
    "EnvironmentFile=/home/u/.config/pomtreed/pomtreed.env",
    "Environment=POMTREED_STATE_DIR=/var/lib/p",
    "Environment=POMTREED_REPO_DIR=/srv/r",
    "ReadWritePaths=/var/lib/p /srv/r",
    "NoNewPrivileges=yes",
  ])
    assert.ok(out.split("\n").includes(want), want);
  assert.ok(!out.includes("/srv/pomtree") && !out.includes("/etc/pomtreed/env"));
});

test("renderService throws naming a missing template line, and refuses unsafe paths", () => {
  assert.throws(() => renderService(unit.replace(/^WorkingDirectory=.*\n/m, ""), paths), /no WorkingDirectory= line/);
  assert.throws(() => renderService(unit, { ...paths, repoDir: "/a b" }), /repoDir.*whitespace/);
});
