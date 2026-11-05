// Leaf tree/accounting helpers of the Daemon: read-only over the registry,
// templates and gateway spend, plus the root-id cache.

import { budgetLedger, CODE_TEMPLATE, CODE_TEMPLATE_ID, templateDigest } from "@pomtree/core";
import type { AgentId, AgentRecord, LedgerNode, LedgerView, SpawnSpec, Template } from "@pomtree/core";
import { envManifestHashOf } from "../daemon-util.ts";
import { isDone } from "../lifecycle.ts";
import type { DaemonCtx } from "./ctx.ts";

export class Tree {
  private rootId: AgentId | null = null; // cache of a registry fact, not state

  private readonly ctx: DaemonCtx;

  constructor(ctx: DaemonCtx) {
    this.ctx = ctx;
  }

  async rootAgentId(): Promise<AgentId> {
    this.rootId ??= (await this.ctx.hub.root.root()).id;
    return this.rootId;
  }

  // The default SpawnSpec for an untemplated spawn: the daemon's base image, no env layer,
  // extensions, and only the manifest's registries plus the node relay. TODO(templates):
  // provider/model/systemPrompt/extensions resolve from a template once TemplateStore is wired.
  defaultSpec(): SpawnSpec {
    const d = this.ctx.deps;
    const code = this.codeTemplate();
    return {
      image: d.image,
      template: code.id,
      templateDigest: templateDigest(code),
      resume: code.resume ?? "session",
      envManifestHash: null,
      extensions: [],
      ...(d.provider !== undefined && { provider: d.provider }),
      ...(d.model !== undefined && { model: d.model }),
      systemPrompt: null,
      egress: { kind: d.untemplatedEgress ?? "none" },
    };
  }

  // The built-in `code` template with the daemon's image filled in: what an untemplated spawn runs as.
  private codeTemplate(): Template {
    return { ...CODE_TEMPLATE, image: this.ctx.deps.image };
  }

  // A named template: the store's entry wins; `code` falls back to the built-in one.
  async resolveTemplate(name: string): Promise<Template | null> {
    const stored = (await this.ctx.deps.templates?.resolve(name)) ?? null;
    if (stored) return stored;
    return name === CODE_TEMPLATE_ID ? this.codeTemplate() : null;
  }

  // Resolve a template overlay onto the default spec. Model precedence: per-spawn `pick` > template > `inherit` (the
  // parent's persisted spec, so children keep its model) > daemon default; every other field: template > daemon default.
  resolvedSpec(t: Template | null, inherit?: SpawnSpec, pick?: { provider: string; id: string }): SpawnSpec {
    const base = this.defaultSpec();
    let provider: string | undefined;
    let model: string | undefined;
    if (pick) ({ provider, model } = { provider: pick.provider, model: pick.id });
    else if (t?.model !== undefined) ({ provider, model } = { provider: t.provider ?? base.provider, model: t.model });
    else {
      const src = inherit?.model !== undefined ? inherit : base;
      ({ provider, model } = { provider: t?.provider ?? src.provider, model: src.model });
    }
    if (!t) return { ...base, ...(provider !== undefined && { provider }), ...(model !== undefined && { model }) };
    return {
      image: t.image ?? base.image,
      envManifestHash: t.env !== undefined ? envManifestHashOf(t.env) : base.envManifestHash,
      extensions: t.extensions ?? base.extensions,
      ...(provider !== undefined && { provider }),
      ...(model !== undefined && { model }),
      systemPrompt: t.systemPrompt ?? base.systemPrompt,
      egress: t.egress ?? base.egress,
      ...(t.memoryBytes !== undefined && { memoryBytes: t.memoryBytes }),
      ...(t.cpus !== undefined && { cpus: t.cpus }),
      ...(t.shmBytes !== undefined && { shmBytes: t.shmBytes }),
      ...(t.diskBytes !== undefined && { diskBytes: t.diskBytes }),
      template: t.id,
      templateDigest: templateDigest(t),
      resume: t.resume ?? "session",
      ...(t.browser !== undefined && {
        browser: { maxSteps: t.browser.maxSteps, maxMs: t.browser.maxMs, ...(t.browser.profile !== undefined && { profile: t.browser.profile }) },
      }),
      ...(t.allowlist !== undefined && { allowlist: t.allowlist }),
      ...(t.disposition !== undefined && { disposition: { ...t.disposition } }),
      ...(t.runtime !== undefined && { runtime: t.runtime }),
    };
  }

  // The budget spine walks `parent` (see ownedChildren for reap/access).
  budgetOwner(a: AgentRecord): AgentId | null {
    return a.parent;
  }

  // Children by parentage.
  ownedChildren(a: AgentRecord): Promise<AgentRecord[]> {
    return this.ctx.deps.registry.list({ parent: a.id });
  }

  // The agents `caller` may address by default: itself, its parent, and its children.
  // TODO(authz-escalation): an opt-in policy widens this to siblings,
  // the root supervisor, or arbitrary ids.
  async addressable(caller: AgentId): Promise<AgentRecord[]> {
    const a = await this.ctx.deps.registry.get(caller);
    if (!a) return [];
    const out = new Map<AgentId, AgentRecord>();
    out.set(a.id, a);
    if (a.parent) {
      const p = await this.ctx.deps.registry.get(a.parent);
      if (p) out.set(p.id, p);
    }
    for (const c of await this.ownedChildren(a)) out.set(c.id, c);
    return [...out.values()];
  }

  async canAddress(from: AgentId, to: AgentId): Promise<boolean> {
    if (from === to) return true;
    const a = await this.ctx.deps.registry.get(from);
    if (!a) return false;
    if (a.parent === to) return true;
    return (await this.ownedChildren(a)).some((c) => c.id === to);
  }

  // The one rule for which agents `caller` may wait on, show or reap beyond itself: a child it parents, or an exited descendant it holds
  // in custody (its parent is gone). Shared by the API's target() and parkForWait, so a long wait admits exactly what a short one does.
  async canWaitOn(caller: AgentId, rec: AgentRecord): Promise<boolean> {
    if (rec.id === caller || rec.parent === caller) return true;
    return rec.state === "exited" && (await this.custodian(rec)).id === caller;
  }

  async depth(a: AgentRecord): Promise<number> {
    let n = 0;
    for (let cur: AgentRecord | null = a; cur; ) {
      const o = this.budgetOwner(cur);
      if (!o) break;
      n++;
      cur = await this.ctx.deps.registry.get(o);
    }
    return n;
  }

  // A deterministic agent has no model spend of its own (and no gateway read): its budget is only its children's.
  // The root supervisor never runs a model, so it has no key and no spend (and reading one would be a gateway call for nothing).
  async spentOf(a: AgentRecord): Promise<number> {
    if (a.executor === "deterministic" || a.parent === null) return 0;
    return (await this.ctx.deps.gateway.spend(a.id)).spentMicros;
  }

  // What the agent has committed in the one hierarchical ledger (core budget-ledger.ts): own spend plus what each child holds,
  // max(carve, consumed) while unreaped and its consumed once reaped (an overage stays booked; see overage-book). The spend
  // authority answers when it can (gateway.ledger -> the debit store, which also counts in-flight reservations); otherwise
  // the same arithmetic runs here over the registry subtree and the gateway's settled spend.
  async consumed(a: AgentRecord): Promise<number> {
    const g = this.ctx.deps.gateway;
    if (g.ledger) return (await g.ledger(a.id)).committedMicros;
    return (await this.subtreeLedger(a)).committed(a.id);
  }

  // Remaining budget after own spend and each child's hold, floored at zero so the API never reports a negative balance
  // during a child's overrun (the signed figure is the ledger's remainingMicros).
  async remainingMicros(a: AgentRecord): Promise<number> {
    return Math.max(0, a.budgetMicros - (await this.consumed(a)));
  }

  // What a budget grant really costs the payer (overage-book): every agent from the asker up to (not including) the payer is
  // raised by `amount`, and the payer's committed grows by how much its child's hold grows. A grant that only covers an
  // overage the ledger already booked (consumed past the carve) costs the payer that much less, never the full amount twice.
  async grantCostMicros(askerId: AgentId, payer: AgentRecord, amount: number): Promise<number> {
    const path = new Set<AgentId>();
    for (let cur = await this.ctx.deps.registry.get(askerId); cur && cur.id !== payer.id && path.size < 64; ) {
      path.add(cur.id);
      cur = cur.parent ? await this.ctx.deps.registry.get(cur.parent) : null;
    }
    const before = await this.subtreeLedger(payer);
    const after = await this.subtreeLedger(payer, (n) => (path.has(n.id) ? { ...n, budgetMicros: n.budgetMicros + amount } : n));
    return Math.max(0, after.committed(payer.id) - before.committed(payer.id));
  }

  // The ledger over `a` and its descendants, from the registry and per-agent settled spend (no debit store wired). `over`
  // rewrites a node (a what-if, as grantCostMicros does).
  private async subtreeLedger(a: AgentRecord, over: (n: LedgerNode) => LedgerNode = (n) => n): Promise<LedgerView> {
    const nodes: LedgerNode[] = [];
    const queue: AgentRecord[] = [a];
    const seen = new Set<AgentId>();
    for (let cur = queue.shift(); cur; cur = queue.shift()) {
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      nodes.push(
        over({
          id: cur.id,
          parent: cur.id === a.id ? null : cur.parent,
          budgetMicros: cur.budgetMicros,
          live: cur.state !== "reaped",
          usedMicros: await this.spentOf(cur),
        }),
      );
      queue.push(...(await this.ctx.deps.registry.list({ parent: cur.id })));
    }
    return budgetLedger(nodes);
  }

  // The agent's ancestors nearest first, root excluded (a top-level agent's chain is empty). Parent is immutable, so
  // the chain is recomputed from the registry at every hop.
  async ancestorChain(a: AgentRecord): Promise<AgentId[]> {
    const rootId = await this.rootAgentId();
    const out: AgentId[] = [];
    for (let cur = a.parent ? await this.ctx.deps.registry.get(a.parent) : null; cur && cur.id !== rootId && out.length < 64; ) {
      out.push(cur.id);
      cur = cur.parent ? await this.ctx.deps.registry.get(cur.parent) : null;
    }
    return out;
  }

  // Who holds `a`'s result when its parent is gone: the nearest ancestor that is not done (exited or reaped); the root supervisor
  // counts as live. Parent is immutable, so custody is derived at each call, never stored. A broken link or an over-long chain
  // falls back to the root, so a result is never left with nobody.
  async custodian(a: AgentRecord): Promise<AgentRecord> {
    const rootId = await this.rootAgentId();
    const seen = new Set<AgentId>([a.id]);
    for (let cur = a, hops = 0; cur.parent && hops < 64; hops++) {
      const next = await this.ctx.deps.registry.get(cur.parent);
      if (!next || seen.has(next.id)) break;
      if (next.id === rootId || !isDone(next)) return next;
      seen.add(next.id);
      cur = next;
    }
    return this.ctx.hub.root.root();
  }

  // Whether `id` descends from `ancestor` through parent links (never a sibling, never an ancestor).
  async isDescendant(ancestor: AgentId, id: AgentId): Promise<boolean> {
    const seen = new Set<AgentId>();
    for (let hop: AgentRecord | null = await this.ctx.deps.registry.get(id); hop && !seen.has(hop.id); ) {
      seen.add(hop.id);
      if (hop.parent === ancestor) return true;
      hop = hop.parent ? await this.ctx.deps.registry.get(hop.parent) : null;
    }
    return false;
  }

  // Scoped `--from-commit`: the full id of `commit` when it is reachable from the ingested heads of `agent` or one of its
  // descendants (never another agent's work), else null. Needs the merge engine's repo view.
  async scopedCommit(agent: AgentId, commit: string): Promise<string | null> {
    const repos = this.ctx.deps.repos;
    if (!repos) return null;
    const subtree = [agent];
    for (const a of await this.ctx.deps.registry.list()) if (a.id !== agent && (await this.isDescendant(agent, a.id))) subtree.push(a.id);
    return repos.commitInSubtree(commit, subtree);
  }

  // A top-level agent is one the operator's root supervisor parents (its merge target is the default branch, under approval).
  async isTopLevel(a: AgentRecord): Promise<boolean> {
    return !a.parent || a.parent === (await this.rootAgentId());
  }
}
