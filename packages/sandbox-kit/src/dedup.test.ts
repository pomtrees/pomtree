import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxOutcomeUnknownError, sandboxIdForKey } from "@pomtree/core";
import {
  type CreateFailure,
  type CreateRequest,
  DedupError,
  type DedupDeps,
  type DedupStrategy,
  type FindQuery,
  type FoundSandbox,
  createOnce,
  derivedName,
} from "./dedup.ts";
import { TagCodecError, encodeName } from "./tags.ts";

const KEY = "agent-1:1:start";
const ID = sandboxIdForKey(KEY);
const OWNER = { "pomtree.host": "host-a", "pomtree.generation": "3" };
const OTHER = { "pomtree.host": "host-b", "pomtree.generation": "3" };
const SCHEMA = { prefix: "pomtree", fields: ["sandbox"], limits: { maxLength: 63, pattern: /^[a-z0-9][a-z0-9.-]*$/ } } as const;
const LOOKUP = { "pomtree.sandbox": ID };

class Timeout extends Error {}
class BadRequest extends Error {}
class NameTaken extends Error {}

// A local provider model. `lose` makes create store the sandbox and then drop the reply (an unknown outcome after send).
class Provider {
  boxes: FoundSandbox[] = [];
  creates: CreateRequest[] = [];
  finds: FindQuery[] = [];
  sleeps: number[] = [];
  clock = 0;
  loseReplies = 0;
  hideFromFind = 0; // finds that answer empty before the box becomes visible
  tags: Record<string, string> = { ...OWNER, ...LOOKUP };
  tokens = new Map<string, string>();

  deps: DedupDeps = {
    create: async (req) => {
      this.creates.push(req);
      if (req.token !== undefined && this.tokens.has(req.token)) {
        if (this.loseReplies > 0) {
          this.loseReplies--;
          throw new Timeout("no reply");
        }
        return { id: this.tokens.get(req.token) as string };
      }
      if (req.name !== undefined && this.boxes.some((b) => b.name === req.name)) throw new NameTaken("name in use");
      const id = `sb-${this.boxes.length + 1}`;
      const box: FoundSandbox = { id, tags: this.tags };
      if (req.name !== undefined) box.name = req.name;
      this.boxes.push(box);
      if (req.token !== undefined) this.tokens.set(req.token, id);
      if (this.loseReplies > 0) {
        this.loseReplies--;
        throw new Timeout("no reply");
      }
      return { id };
    },
    find: async (q) => {
      this.finds.push(q);
      if (this.hideFromFind > 0) {
        this.hideFromFind--;
        return [];
      }
      return this.boxes.filter((b) => (q.name === undefined || b.name === q.name) && Object.entries(q.tags ?? {}).every(([k, v]) => b.tags[k] === v));
    },
    classify: (err): CreateFailure => (err instanceof NameTaken ? "name-in-use" : err instanceof Timeout ? "unknown" : "failed"),
    sleep: async (ms) => {
      this.sleeps.push(ms);
      this.clock += ms;
    },
    now: () => this.clock,
  };
}

const tagLookup = (): DedupStrategy => ({ mechanism: "tag-lookup", key: KEY, ownerTags: OWNER, lookupTags: LOOKUP });
const uniqueName = (): Extract<DedupStrategy, { mechanism: "unique-name" }> => ({
  mechanism: "unique-name",
  key: KEY,
  ownerTags: OWNER,
  names: { schema: SCHEMA, idChars: 32 },
});
const nativeToken = (): Extract<DedupStrategy, { mechanism: "native-token" }> => ({
  mechanism: "native-token",
  key: KEY,
  ownerTags: OWNER,
  token: "tok-1",
  lookupTags: LOOKUP,
  idempotencyWindowMs: 60_000,
});

// The control: the retry a careless adapter writes. After a lost reply it creates again.
async function blindRetryCreate(deps: DedupDeps): Promise<void> {
  const req: CreateRequest = { key: KEY, derivedId: ID };
  try {
    await deps.create(req);
  } catch {
    await deps.create(req);
  }
}

test("dedup: a blind retry after a lost reply creates two sandboxes (the control the next test must beat)", async () => {
  const p = new Provider();
  p.loseReplies = 1;
  await blindRetryCreate(p.deps);
  assert.equal(p.boxes.length, 2);
});

test("dedup: tag-lookup after a lost reply adopts the first sandbox and never creates a second", async () => {
  const p = new Provider();
  p.loseReplies = 1;
  const r = await createOnce(tagLookup(), p.deps);
  assert.equal(p.boxes.length, 1);
  assert.equal(p.creates.length, 1);
  assert.deepEqual(r, { id: "sb-1", adopted: true });
});

test("dedup: tag-lookup probes again when the box is not yet listed, spaced by the policy", async () => {
  const p = new Provider();
  p.loseReplies = 1;
  p.hideFromFind = 2; // the pre-create find, then the first probe, are empty
  const r = await createOnce({ ...tagLookup(), probe: { probes: 3, intervalMs: 100 } }, p.deps);
  assert.equal(r.adopted, true);
  assert.deepEqual(p.sleeps, [100]);
  assert.equal(p.creates.length, 1);
});

test("dedup: tag-lookup that stays inconclusive raises SandboxOutcomeUnknownError with the derived id and creates nothing more", async () => {
  const p = new Provider();
  p.loseReplies = 1;
  p.hideFromFind = 99;
  await assert.rejects(createOnce({ ...tagLookup(), probe: { probes: 2, intervalMs: 5 } }, p.deps), (e: unknown) => {
    assert.ok(e instanceof SandboxOutcomeUnknownError);
    assert.equal(e.id, ID);
    assert.equal(e.idempotencyKey, KEY);
    assert.ok(e.cause instanceof Timeout);
    return true;
  });
  assert.equal(p.creates.length, 1);
  assert.equal(p.boxes.length, 1);
});

test("dedup: tag-lookup finds an earlier run's sandbox before creating", async () => {
  const p = new Provider();
  p.boxes.push({ id: "old", tags: p.tags });
  const r = await createOnce(tagLookup(), p.deps);
  assert.deepEqual(r, { id: "old", adopted: true });
  assert.equal(p.creates.length, 0);
});

test("dedup: a clean create is not adopted", async () => {
  const p = new Provider();
  assert.deepEqual(await createOnce(tagLookup(), p.deps), { id: "sb-1", adopted: false });
});

test("dedup: a definite failure is rethrown unchanged and not reconciled", async () => {
  const p = new Provider();
  p.deps.create = async () => {
    throw new BadRequest("422");
  };
  await assert.rejects(createOnce(tagLookup(), p.deps), BadRequest);
  assert.equal(p.finds.length, 1); // only the pre-create lookup
});

test("dedup: more than one match fails closed", async () => {
  const p = new Provider();
  p.boxes.push({ id: "a", tags: p.tags }, { id: "b", tags: p.tags });
  await assert.rejects(createOnce(tagLookup(), p.deps), (e: unknown) => e instanceof SandboxOutcomeUnknownError && e.id === ID);
});

test("dedup: adoption refuses a same-key sandbox of another owner (tag-lookup)", async () => {
  const p = new Provider();
  p.boxes.push({ id: "theirs", tags: { ...OTHER, ...LOOKUP } });
  await assert.rejects(createOnce(tagLookup(), p.deps), (e: unknown) => e instanceof DedupError && /owner tags differ/.test(e.message));
  assert.equal(p.creates.length, 0);
});

test("dedup: unique-name derives a name inside the limits and a name-in-use answer adopts the owner's sandbox", async () => {
  const p = new Provider();
  const name = derivedName(uniqueName(), ID);
  assert.equal(name, `pomtree-${ID.slice(0, 32)}`);
  p.boxes.push({ id: "mine", name, tags: p.tags });
  const r = await createOnce(uniqueName(), p.deps);
  assert.deepEqual(r, { id: "mine", adopted: true });
  assert.equal(p.boxes.length, 1);
});

test("dedup: unique-name creates under the derived name when free", async () => {
  const p = new Provider();
  const r = await createOnce(uniqueName(), p.deps);
  assert.equal(r.adopted, false);
  assert.equal(p.creates[0]?.name, `pomtree-${ID.slice(0, 32)}`);
});

test("dedup: unique-name refuses to adopt a same-named sandbox of ANOTHER owner", async () => {
  const p = new Provider();
  const name = `pomtree-${ID.slice(0, 32)}`;
  p.boxes.push({ id: "theirs", name, tags: { ...OTHER } });
  await assert.rejects(createOnce(uniqueName(), p.deps), (e: unknown) => e instanceof DedupError && /owner tags differ/.test(e.message));
  assert.equal(p.boxes.length, 1);
});

test("dedup: unique-name refuses a name-holder with a foreign prefix even with matching tags", async () => {
  const p = new Provider();
  p.deps.create = async () => {
    throw new NameTaken("name in use");
  };
  p.boxes.push({ id: "odd", name: `other-${ID.slice(0, 32)}`, tags: p.tags });
  p.deps.find = async () => p.boxes;
  await assert.rejects(createOnce(uniqueName(), p.deps), (e: unknown) => e instanceof DedupError && /foreign or damaged/.test(e.message));
});

test("dedup: unique-name refuses a name that encodes a different key", async () => {
  const p = new Provider();
  p.deps.create = async () => {
    throw new NameTaken("name in use");
  };
  p.boxes.push({ id: "odd", name: `pomtree-${sandboxIdForKey("other-key").slice(0, 32)}`, tags: p.tags });
  p.deps.find = async () => p.boxes;
  await assert.rejects(createOnce(uniqueName(), p.deps), (e: unknown) => e instanceof DedupError && /different key/.test(e.message));
});

test("dedup: name-in-use with nothing listed is an error naming cause and action", async () => {
  const p = new Provider();
  p.deps.create = async () => {
    throw new NameTaken("name in use");
  };
  await assert.rejects(
    createOnce(uniqueName(), p.deps),
    (e: unknown) => e instanceof SandboxOutcomeUnknownError && e.cause instanceof DedupError && /remove it or change the name prefix/.test(e.cause.message),
  );
});

test("dedup: an over-length derived name is rejected before any provider call", async () => {
  const p = new Provider();
  const s: DedupStrategy = {
    ...uniqueName(),
    names: { schema: { ...SCHEMA, limits: { ...SCHEMA.limits, maxLength: 40 } }, idChars: 40 },
  };
  await assert.rejects(createOnce(s, p.deps), TagCodecError);
  assert.equal(p.creates.length + p.finds.length, 0);
  // the codec accepts the same schema at a fitting length (the check can pass)
  assert.equal(encodeName({ ...SCHEMA, limits: { ...SCHEMA.limits, maxLength: 40 } }, { sandbox: ID.slice(0, 32) }).length, 40);
});

test("dedup: unique-name after a lost reply reconciles by name instead of creating again", async () => {
  const p = new Provider();
  p.loseReplies = 1;
  const r = await createOnce(uniqueName(), p.deps);
  assert.deepEqual(r, { id: "sb-1", adopted: true });
  assert.equal(p.creates.length, 1);
});

test("dedup: native-token replays the same token after a lost reply and gets the same sandbox", async () => {
  const p = new Provider();
  p.loseReplies = 1;
  const r = await createOnce(nativeToken(), p.deps);
  assert.deepEqual(r, { id: "sb-1", adopted: false });
  assert.equal(p.boxes.length, 1);
  assert.deepEqual(
    p.creates.map((c) => c.token),
    ["tok-1", "tok-1"],
  );
});

test("dedup: native-token past its window lists instead of replaying, and adopts the owner's sandbox", async () => {
  const p = new Provider();
  p.loseReplies = 1;
  const base = p.deps.create;
  p.deps.create = async (req) => {
    p.clock += 61_000; // the failed attempt burned the whole window
    return base(req);
  };
  const r = await createOnce(nativeToken(), p.deps);
  assert.deepEqual(r, { id: "sb-1", adopted: true });
  assert.equal(p.creates.length, 1);
});

test("dedup: native-token that cannot be resolved raises unknown with the derived id; two matches fail closed", async () => {
  const p = new Provider();
  p.deps.create = async () => {
    throw new Timeout("no reply");
  };
  await assert.rejects(
    createOnce({ ...nativeToken(), maxAttempts: 2, probe: { probes: 1, intervalMs: 1 } }, p.deps),
    (e: unknown) => e instanceof SandboxOutcomeUnknownError && e.id === ID,
  );
  p.boxes.push({ id: "a", tags: p.tags }, { id: "b", tags: p.tags });
  await assert.rejects(createOnce({ ...nativeToken(), probe: { probes: 1, intervalMs: 1 } }, p.deps), (e: unknown) => e instanceof SandboxOutcomeUnknownError);
});

test("dedup: native-token adoption also verifies the owner tags", async () => {
  const p = new Provider();
  p.deps.create = async () => {
    throw new Timeout("no reply");
  };
  p.boxes.push({ id: "theirs", tags: { ...OTHER, ...LOOKUP } });
  await assert.rejects(createOnce({ ...nativeToken(), maxAttempts: 1 }, p.deps), (e: unknown) => e instanceof DedupError);
});

test("dedup: native-token looks up by the lookup tags before creating, so a restart past the token window adopts", async () => {
  const p = new Provider();
  p.boxes.push({ id: "old", tags: p.tags });
  const r = await createOnce(nativeToken(), p.deps);
  assert.deepEqual(r, { id: "old", adopted: true });
  assert.equal(p.creates.length, 0);
});

test("dedup: after name-in-use a lagging listing is probed before the name is called foreign", async () => {
  const p = new Provider();
  const name = `pomtree-${ID.slice(0, 32)}`;
  p.boxes.push({ id: "mine", name, tags: p.tags });
  p.hideFromFind = 2;
  const r = await createOnce({ ...uniqueName(), probe: { probes: 3, intervalMs: 50 } }, p.deps);
  assert.deepEqual(r, { id: "mine", adopted: true });
  assert.deepEqual(p.sleeps, [50, 50]);
});

test("dedup: name-in-use that stays unlisted raises SandboxOutcomeUnknownError with the derived id and the cause", async () => {
  const p = new Provider();
  p.deps.create = async () => {
    throw new NameTaken("name in use");
  };
  await assert.rejects(createOnce({ ...uniqueName(), probe: { probes: 2, intervalMs: 1 } }, p.deps), (e: unknown) => {
    assert.ok(e instanceof SandboxOutcomeUnknownError);
    assert.equal(e.id, ID);
    assert.ok(e.cause instanceof DedupError && /is in use but listing finds no such sandbox after 2 lookups/.test(e.cause.message));
    return true;
  });
  assert.equal(p.finds.length, 2);
});

test("dedup: a find that throws while reconciling an unknown create becomes SandboxOutcomeUnknownError with the find error as cause", async () => {
  const p = new Provider();
  class ListDown extends Error {}
  p.deps.create = async () => {
    throw new Timeout("no reply");
  };
  p.deps.find = async (q) => {
    p.finds.push(q);
    if (p.finds.length > 1) throw new ListDown("list 503"); // the pre-create lookup succeeds (empty), the probe fails
    return [];
  };
  await assert.rejects(createOnce(tagLookup(), p.deps), (e: unknown) => {
    assert.ok(e instanceof SandboxOutcomeUnknownError);
    assert.equal(e.id, ID);
    assert.ok(e.cause instanceof ListDown);
    return true;
  });
});

test("dedup: a find that throws during name-in-use reconciliation is wrapped the same way", async () => {
  const p = new Provider();
  class ListDown extends Error {}
  p.deps.create = async () => {
    throw new NameTaken("name in use");
  };
  p.deps.find = async () => {
    throw new ListDown("list 503");
  };
  await assert.rejects(createOnce(uniqueName(), p.deps), (e: unknown) => e instanceof SandboxOutcomeUnknownError && e.cause instanceof ListDown && e.id === ID);
});

test("dedup: a failing pre-create lookup propagates unchanged (nothing was sent)", async () => {
  const p = new Provider();
  class ListDown extends Error {}
  p.deps.find = async () => {
    throw new ListDown("list 503");
  };
  await assert.rejects(createOnce(tagLookup(), p.deps), ListDown);
  assert.equal(p.creates.length, 0);
});

test("dedup: a generation mismatch and a host mismatch are told apart in the refusal", async () => {
  const gen = new Provider();
  gen.boxes.push({ id: "old-gen", tags: { ...OWNER, "pomtree.generation": "2", ...LOOKUP } });
  await assert.rejects(createOnce(tagLookup(), gen.deps), (e: unknown) => e instanceof DedupError && /differing tags: pomtree\.generation\)/.test(e.message));
  const host = new Provider();
  host.boxes.push({ id: "other-host", tags: { ...OWNER, "pomtree.host": "host-z", ...LOOKUP } });
  await assert.rejects(createOnce(tagLookup(), host.deps), (e: unknown) => e instanceof DedupError && /differing tags: pomtree\.host\)/.test(e.message));
});

test("dedup: a sandbox that does not carry the lookup tags is not adopted, even with matching owner tags", async () => {
  const p = new Provider();
  p.deps.find = async () => [{ id: "stranger", tags: { ...OWNER } }]; // a sloppy selector returns it anyway
  await assert.rejects(
    createOnce(tagLookup(), p.deps),
    (e: unknown) => e instanceof DedupError && /does not carry the lookup tags.*pomtree\.sandbox/.test(e.message),
  );
  await assert.rejects(createOnce(nativeToken(), p.deps), DedupError);
});

test("dedup: the multiple-match failure says so and is not worded as a lost reply", async () => {
  const p = new Provider();
  p.boxes.push({ id: "a", tags: p.tags }, { id: "b", tags: p.tags });
  await assert.rejects(createOnce(tagLookup(), p.deps), (e: unknown) => {
    assert.ok(e instanceof SandboxOutcomeUnknownError);
    assert.match(e.message, /2 sandboxes match idempotency key .*\(a, b\).*stop the extra sandboxes by hand/);
    assert.doesNotMatch(e.message, /no reply/);
    return true;
  });
});

test("dedup: a probe policy with no lookups or a bad interval is rejected before any provider call", async () => {
  const p = new Provider();
  for (const probe of [
    { probes: 0, intervalMs: 1 },
    { probes: 1.5, intervalMs: 1 },
    { probes: Number.NaN, intervalMs: 1 },
  ]) {
    await assert.rejects(createOnce({ ...tagLookup(), probe }, p.deps), /probes is .* but must be an integer of at least 1.*set at least one lookup/);
  }
  await assert.rejects(createOnce({ ...tagLookup(), probe: { probes: 1, intervalMs: -1 } }, p.deps), /intervalMs is -1 but must be a finite number/);
  assert.equal(p.creates.length + p.finds.length, 0);
  assert.equal((await createOnce({ ...tagLookup(), probe: { probes: 1, intervalMs: 0 } }, p.deps)).adopted, false);
});
