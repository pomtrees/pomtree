import { randomBytes } from "node:crypto";
import { decodeGatewayCredential, encodeGatewayCredential, POMTREED_KINDS, verifyGatewayCredential } from "@pomtree/core";
import type { AgentId, AgentLedger, CredentialCheck, DurableModelDebitStore, GatewayCredential, Journal, ModelGateway, Registry } from "@pomtree/core";
import { chargeMicros } from "./model-proxy/rates.ts";
import type { RatesSource } from "./model-proxy/rates.ts";

export { decodeGatewayCredential, encodeGatewayCredential, verifyGatewayCredential } from "@pomtree/core";
export type { CredentialCheck, GatewayCredential } from "@pomtree/core";

export interface ProxyCredentialGatewayOptions {
  journal: Journal;
  registry: Registry;
  // Controller-only signing secret. The upstream provider credential never enters a issued token.
  secret: string;
  proxyBaseUrl: string;
  tokenTtlMs: number;
  // The longest session (session.maxMs). The key is issued once per container start and never refreshed, so its lifetime is
  // max(tokenTtlMs, sessionMaxMs + MODEL_KEY_TTL_SLACK_MS): a session may not outlive its model credential. Absent = tokenTtlMs.
  sessionMaxMs?: number;
  now?: () => number;
  // Price (micros per million tokens) for usage events that report zero cost with nonzero tokens, applied
  // to the unpriced token sums in the no-debit-store journal fallback below. Unset = such events add 0.
  rates?: { inputMicrosPerMTok: number; outputMicrosPerMTok: number };
  // Pi catalog rates (production wiring): prices zero-cost usage events per model for the informational
  // journal path (`priceUsage`). The proxy debit store stays the fail-closed spend authority.
  catalog?: { provider: string; source: RatesSource };
  // The durable single-owner debit/revocation store the proxy forwards through. When present,
  // authorize/revoke back onto it (the proxy's reserve checks the same revocation) and `spend` reads its
  // settled charges. Without it the gateway revokes process-locally and meters the journal (unit tests).
  debits?: DurableModelDebitStore;
}

// Headroom past the session deadline for the wrap-up and the final model calls of a session that runs its full length.
export const MODEL_KEY_TTL_SLACK_MS = 15 * 60_000;

// The lifetime of a issued model-proxy key; see ProxyCredentialGatewayOptions.sessionMaxMs.
export const modelKeyTtlMs = (tokenTtlMs: number, sessionMaxMs?: number): number =>
  sessionMaxMs === undefined ? tokenTtlMs : Math.max(tokenTtlMs, sessionMaxMs + MODEL_KEY_TTL_SLACK_MS);

// The ModelGateway: it only emits a scoped bearer credential and the controller-side proxy URL; it never
// returns the configured provider key. With the durable debit store wired, `spend` reads its settled
// charges — the one ledger behind both the per-credential hard cap and the daemon's stop/resume check;
// the journaled `usage` totals are the informational fallback when no store is wired (unit tests).
export class ProxyCredentialGateway implements ModelGateway {
  private readonly proxy: ProxyCredentialGatewayOptions;
  private readonly issued = new Map<string, { key: string; expiresAt: number }>();
  // credential id -> its expiresAt; an expired credential fails decode anyway, so the entry can go then.
  private readonly revoked = new Map<string, number>();
  // agent -> when this gateway last revoked it. Only the no-store fallback reads it (a key issued afterwards is stamped
  // strictly later); with a debit store, the store's atomic `issue` owns the stamp and this map is not authority.
  private readonly revokedAt = new Map<AgentId, number>();

  // The hierarchical ledger from the debit store, the spend authority (absent without one: the daemon's Tree computes the
  // same arithmetic from the registry and `spend`).
  readonly ledger?: (agent: AgentId) => Promise<AgentLedger>;
  // usage-join: the debit store's settled call by provider response id (absent without a store).
  readonly settledCall?: (agent: AgentId, responseId: string) => Promise<{ requestId: string; chargedMicros: number } | null>;

  constructor(o: ProxyCredentialGatewayOptions) {
    if (!Number.isSafeInteger(o.tokenTtlMs) || o.tokenTtlMs <= 0) throw new Error("tokenTtlMs must be a positive integer");
    if (!o.proxyBaseUrl) throw new Error("proxyBaseUrl is required");
    this.proxy = o;
    const ledgerFor = o.debits?.ledgerFor?.bind(o.debits);
    if (ledgerFor) this.ledger = async (agent) => ledgerFor(agent);
    const settledCall = o.debits?.settledCall?.bind(o.debits);
    if (settledCall) this.settledCall = async (agent, responseId) => settledCall(agent, responseId);
  }

  async issueKey(agent: AgentId, budgetMicros: number, idempotencyKey?: string) {
    if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 0) throw new Error("budgetMicros must be a non-negative safe integer");
    // Validated before any side effect (budget, cache, issuance): an unsafe wall clock or expiry sum refuses the issue
    // rather than returning a key whose expiresAt cannot be represented or decoded.
    const clock = (this.proxy.now ?? Date.now)();
    const expiresAt = clock + modelKeyTtlMs(this.proxy.tokenTtlMs, this.proxy.sessionMaxMs);
    if (!Number.isSafeInteger(clock) || !Number.isSafeInteger(expiresAt)) throw new Error("credential expiry is not a safe integer; no key issued");
    // A terminal agent never gets a usable credential (its revocation also persists).
    const rec = await this.proxy.registry.get(agent);
    const state = rec?.state;
    if (state === "exited" || state === "reaped") throw new Error(`agent ${agent} is ${state}; no model credential is issued`);
    // The model allowlist signed into the key: the agent's resolved spec model (validated against the catalog at spawn), and
    // nothing else. An unregistered agent is refused loudly here rather than surfacing later as the proxy's model_not_allowed.
    if (!rec)
      throw new Error(`agent ${agent} is not registered; no model credential is issued: register the agent with a spec.model before issuing a credential`);
    // A deterministic agent makes no model calls: the daemon never issues for one (it starts no container), so a issue for it is a
    // caller bug and is refused rather than issuing a key that allows nothing.
    if (rec.executor === "deterministic") throw new Error(`agent ${agent} is a deterministic agent and makes no model calls; no model credential is issued`);
    // A container agent with no resolved model would get a key that allows no model, refused only later per call as
    // model_not_allowed; refuse the issue instead, naming the cause and the fix.
    const model = rec.spec.model;
    if (model === undefined)
      throw new Error(
        `agent ${agent} has no model resolved (no model catalog is wired, or its spec names no model); no model credential is issued: spawn it with a model (--model PROVIDER/ID), a template or daemon default model, or wire a model catalog`,
      );
    const models = [model];
    // `budgetMicros` is the agent's TOTAL cap: it raises (or lowers) the durable bucket so a resume after
    // a budget raise can spend; old tokens stay dead by issue time, independent of the cap.
    this.proxy.debits?.setBudget(agent, budgetMicros);
    const cacheKey = idempotencyKey ? `${agent}:${idempotencyKey}` : undefined;
    for (const [k, v] of this.issued) if (v.expiresAt <= clock) this.issued.delete(k);
    for (const [id, revokedUntil] of this.revoked) if (revokedUntil <= clock) this.revoked.delete(id);
    const old = cacheKey ? this.issued.get(cacheKey) : undefined;
    if (old) return { key: old.key, baseUrl: this.proxy.proxyBaseUrl };
    // The stamp is atomic with the store's revocation record (`issue`), so it is strictly after any revoke and never
    // below an earlier stamp even when the clock steps back. Expiry stays a wall-clock TTL from this issue.
    const issuedAt = this.proxy.debits ? this.proxy.debits.issue(agent, clock) : Math.max(clock, (this.revokedAt.get(agent) ?? -Infinity) + 1);
    const credential: GatewayCredential = { agent, budgetMicros, expiresAt, issuedAt, id: randomBytes(16).toString("hex"), models };
    const key = encodeGatewayCredential(this.proxy.secret, credential);
    if (cacheKey) this.issued.set(cacheKey, { key, expiresAt: credential.expiresAt });
    return { key, baseUrl: this.proxy.proxyBaseUrl };
  }

  // Intended for the controller-side proxy request path. With a durable debit store the same
  // revocation record the proxy's reserve checks is consulted; without one it falls back to the
  // process-local revocation set.
  authorize(key: string): GatewayCredential | null {
    if (this.proxy.debits) return this.proxy.debits.authorize(key);
    const credential = decodeGatewayCredential(this.proxy.secret, key, (this.proxy.now ?? Date.now)());
    return credential && !this.revoked.has(credential.id) ? credential : null;
  }

  // `authorize` with the refusal reason: the durable store's when wired, else verifyGatewayCredential plus the process-local
  // revocation set (expiry is judged first, so an expired and revoked key reads `expired`, as in the store).
  checkCredential(key: string): CredentialCheck {
    if (this.proxy.debits) return this.proxy.debits.checkCredential(key);
    const r = verifyGatewayCredential(this.proxy.secret, key, (this.proxy.now ?? Date.now)());
    return r.ok && this.revoked.has(r.credential.id) ? { ok: false, reason: "revoked" } : r;
  }

  async spend(agent: AgentId) {
    const rec = await this.proxy.registry.get(agent);
    // The proxy debit store is the single spend authority: the daemon's over-budget stop and resume check
    // read the same settled-charge ledger the per-credential hard cap enforces (provider-reported cost,
    // catalog fallback for unpriced usage). An agent that never reached the proxy has no bucket: 0.
    if (this.proxy.debits) return { spentMicros: this.proxy.debits.spentFor(agent), budgetMicros: rec?.budgetMicros ?? 0 };
    // No durable store (unit tests): the informational journal meter stands in. Incremental totals survive
    // journal pruning; the unpriced tokens (model-less or catalog-unknown events) go at the flat rate table.
    const t = await this.proxy.journal.spendFor(agent);
    const r = this.proxy.rates;
    const extra = r ? Math.ceil((t.unpricedInputTokens * r.inputMicrosPerMTok + t.unpricedOutputTokens * r.outputMicrosPerMTok) / 1_000_000) : 0;
    return { spentMicros: t.costMicros + extra, budgetMicros: rec?.budgetMicros ?? 0 };
  }

  // Informational catalog price for a usage event the provider reported at zero cost (Pi priced the model
  // at 0, or the event lost its cost). Null when no catalog is wired, the event names no model, or the
  // model is unknown — the caller then journals the event unpriced. Never authoritative.
  async priceUsage(usage: { model?: string; inputTokens: number; outputTokens: number }): Promise<number | null> {
    const c = this.proxy.catalog;
    if (!c || !usage.model) return null;
    const rates = c.source.lookup(c.provider, usage.model);
    if (!rates) return null;
    return chargeMicros(rates, { input: usage.inputTokens, output: usage.outputTokens, cacheRead: 0, cacheWrite: 0 });
  }

  async revoke(agent: AgentId) {
    if (this.proxy.debits) this.proxy.debits.revoke(agent);
    this.revokedAt.set(agent, (this.proxy.now ?? Date.now)());
    for (const { key } of this.issued.values()) {
      const credential = decodeGatewayCredential(this.proxy.secret, key, (this.proxy.now ?? Date.now)());
      if (credential?.agent === agent) this.revoked.set(credential.id, credential.expiresAt);
    }
    const l = this.proxy.debits?.ledgerFor?.(agent);
    if (l) {
      await this.bookOverage(agent, l);
      return { unusedMicros: Math.max(0, l.remainingMicros) };
    }
    const s = await this.spend(agent);
    return { unusedMicros: Math.max(0, s.budgetMicros - s.spentMicros) };
  }

  // overage-book: once a child is reaped, the ledger books its consumed (max(carve, consumed)) against the parent; a consumed
  // past the carve is journaled on the parent as an explicit write-off, once per child. Two guards: the idempotency key by child id
  // (concurrent and in-window replays) and a paginated scan of the parent's journal for this child's row, because the journal's
  // idempotency rows are pruned and a later revoke of the same reaped child (boot replay) would otherwise book it again.
  // budget_overage is not a prunable journal kind, so the scan is reliable. Cost: one paginated parent-journal read per revoke
  // of a reaped child with overage > 0.
  private async bookOverage(agent: AgentId, l: AgentLedger): Promise<void> {
    if (l.overageMicros <= 0) return;
    const rec = await this.proxy.registry.get(agent);
    if (rec?.state !== "reaped" || rec.parent === null) return;
    const parent = await this.proxy.registry.get(rec.parent);
    if (!parent) return;
    if (await this.overageBooked(parent.id, agent)) return;
    await this.proxy.journal.append({
      agent: parent.id,
      host: parent.host,
      generation: parent.generation,
      idempotencyKey: `budget-overage:${agent}`,
      payload: { kind: POMTREED_KINDS.budgetOverage, child: agent, carve: l.budgetMicros, consumed: l.committedMicros, overage: l.overageMicros },
    });
  }

  private async overageBooked(parent: AgentId, child: AgentId): Promise<boolean> {
    const limit = 500;
    for (let from = 0; ; ) {
      const page = await this.proxy.journal.read({ agent: parent, from, limit });
      for (const e of page) {
        const p = e.payload as { kind?: unknown; child?: unknown };
        if (p.kind === POMTREED_KINDS.budgetOverage && p.child === child) return true;
      }
      if (page.length < limit) return false;
      from = (page.at(-1)?.seq ?? from) + 1;
    }
  }
}

// Charges (fail closed) model-proxy reservations stranded by a crash/hang: anything unsettled and untouched for twice the
// upstream timeout. The proxy touches a reservation as response bytes arrive and its upstream timeout is an idle deadline, so
// the age is idleness: a long healthy stream is never reclaimed mid-flight.
export function reclaimStaleReservations(store: Pick<DurableModelDebitStore, "expireReservations">, upstreamTimeoutMs: number): number {
  return store.expireReservations(2 * upstreamTimeoutMs);
}
