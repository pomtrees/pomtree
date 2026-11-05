import { decodeGatewayCredential, validDebitMicros, validDebitRequestId, verifyGatewayCredential } from "@pomtree/core";
import type { AgentId, CredentialCheck, GatewayCredential, RequestReservation, ReserveResult, SettleResult } from "@pomtree/core";

export type { RequestReservation, ReserveResult, SettleResult } from "@pomtree/core";

// The request path reserves a conservative upper bound before contacting a provider. This is
// deliberately in-memory: a production proxy must put the same state in its durable, single-owner
// debit store before it can enforce the cap across a restart or several proxy processes.

export interface RequestBudgetOptions {
  secret: string;
  now?: () => number;
}

interface RequestState {
  credentialId: string;
  maximumMicros: number;
  status: "reserved" | "settled" | "cancelled" | "expired-charged";
  chargedMicros?: number;
  createdAt: number;
  // Last `touch` while in flight; reclaim ages a reservation from the later of the two.
  touchedAt?: number;
}

interface AgentState {
  // A credential never changes an established bucket (no multiplying authority across token refreshes);
  // only setBudget does.
  budgetMicros: number;
  spentMicros: number;
  reservedMicros: number;
  requests: Map<string, RequestState>;
}

// Controller-side hard-cap primitive. It verifies the signed credential on each reservation and
// accounts by agent, rather than token id, so refreshing or concurrently using credentials cannot
// create additional spend authority. `maximumMicros` must be a conservative upper bound for the
// upstream request. The proxy must calculate the settlement from trusted, priced usage; settlement
// that exceeds the reservation is recorded in full (the provider billed it), which can drive the
// agent's remaining budget negative so every later reservation is refused.
export class RequestBudget {
  private readonly secret: string;
  private readonly now: () => number;
  private readonly agents = new Map<AgentId, AgentState>();

  constructor(options: RequestBudgetOptions) {
    if (!options.secret) throw new Error("secret is required");
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
  }

  authorize(key: string): GatewayCredential | null {
    return decodeGatewayCredential(this.secret, key, this.now());
  }

  // `authorize` with the refusal reason (invalid or expired); this in-memory primitive keeps no revocations.
  checkCredential(key: string): CredentialCheck {
    return verifyGatewayCredential(this.secret, key, this.now());
  }

  reserve(key: string, requestId: string, maximumMicros: number): ReserveResult {
    const credential = this.authorize(key);
    if (!credential) return { ok: false, reason: "invalid-credential" };
    if (!validDebitRequestId(requestId) || !validDebitMicros(maximumMicros)) return { ok: false, reason: "invalid-request" };

    const state = this.agentState(credential);
    const existing = state.requests.get(requestId);
    // A request id is single-use: replaying a reserved (in-flight) or settled id must not authorize a
    // second upstream call, because settlement is idempotent and would charge nothing for it.
    if (existing) return { ok: false, reason: "idempotency-conflict" };
    if (maximumMicros > state.budgetMicros - state.spentMicros - state.reservedMicros) return { ok: false, reason: "budget-exhausted" };

    state.requests.set(requestId, { credentialId: credential.id, maximumMicros, status: "reserved", createdAt: this.now() });
    state.reservedMicros += maximumMicros;
    return { ok: true, reservation: this.reservation(credential, requestId), remainingMicros: state.budgetMicros - state.spentMicros - state.reservedMicros };
  }

  settle(reservation: RequestReservation, chargedMicros: number): SettleResult {
    if (!validDebitMicros(chargedMicros)) return { ok: false, reason: "invalid-charge" };
    const state = this.agents.get(reservation.agent);
    const request = state?.requests.get(reservation.requestId);
    if (!state || !request || request.credentialId !== reservation.credentialId) return { ok: false, reason: "unknown-reservation" };
    if (request.status === "settled")
      return { ok: true, chargedMicros: request.chargedMicros!, remainingMicros: state.budgetMicros - state.spentMicros - state.reservedMicros };
    if (request.status === "expired-charged") {
      // Expiry already charged the whole reservation (the upstream call may have completed and been billed), so a
      // late settle never charges it again; only usage above the reserved amount is topped up.
      // Cumulative like the durable store: the status stays "expired-charged", so a later, larger late settle tops up again.
      const overage = Math.max(0, chargedMicros - request.chargedMicros!);
      state.spentMicros += overage;
      request.chargedMicros! += overage;
      return {
        ok: true,
        chargedMicros: request.chargedMicros!,
        remainingMicros: state.budgetMicros - state.spentMicros - state.reservedMicros,
        expiredCharged: true,
      };
    }
    if (request.status !== "reserved") return { ok: false, reason: "unknown-reservation" };

    // The true overage is recorded, never clamped: the provider bills real usage, so the agent's
    // remaining budget goes negative and later reservations fail with budget-exhausted.
    state.reservedMicros -= request.maximumMicros;
    state.spentMicros += chargedMicros;
    request.status = "settled";
    request.chargedMicros = chargedMicros;
    return { ok: true, chargedMicros, remainingMicros: state.budgetMicros - state.spentMicros - state.reservedMicros };
  }

  // Sets the agent's cumulative cap to `micros` (the total, spend untouched); creates the bucket if absent.
  setBudget(agent: AgentId, micros: number): void {
    if (!validDebitMicros(micros)) throw new Error("budget micros must be a non-negative safe integer");
    const state = this.agents.get(agent);
    if (state) state.budgetMicros = micros;
    else this.agents.set(agent, { budgetMicros: micros, spentMicros: 0, reservedMicros: 0, requests: new Map() });
  }

  // Marks an in-flight reservation as alive (the proxy calls it as response bytes arrive); false when it is not in flight.
  touch(reservation: RequestReservation): boolean {
    const request = this.agents.get(reservation.agent)?.requests.get(reservation.requestId);
    if (!request || request.credentialId !== reservation.credentialId || request.status !== "reserved") return false;
    request.touchedAt = this.now();
    return true;
  }

  // Charges (fail closed) reservations unsettled and untouched for `olderThanMs`: a request that never reported may have
  // been billed. The id stays non-reusable. Returns how many were expired.
  expireReservations(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    let released = 0;
    for (const state of this.agents.values())
      for (const request of state.requests.values())
        if (request.status === "reserved" && Math.max(request.createdAt, request.touchedAt ?? request.createdAt) <= cutoff) {
          request.status = "expired-charged";
          request.chargedMicros = request.maximumMicros;
          state.reservedMicros -= request.maximumMicros;
          state.spentMicros += request.maximumMicros;
          released++;
        }
    return released;
  }

  cancel(reservation: RequestReservation): boolean {
    const state = this.agents.get(reservation.agent);
    const request = state?.requests.get(reservation.requestId);
    if (!state || !request || request.credentialId !== reservation.credentialId || request.status !== "reserved") return false;
    request.status = "cancelled";
    state.reservedMicros -= request.maximumMicros;
    return true;
  }

  private agentState(credential: GatewayCredential): AgentState {
    const old = this.agents.get(credential.agent);
    if (old) return old;
    const state: AgentState = { budgetMicros: credential.budgetMicros, spentMicros: 0, reservedMicros: 0, requests: new Map() };
    this.agents.set(credential.agent, state);
    return state;
  }

  private reservation(credential: GatewayCredential, requestId: string): RequestReservation {
    return { agent: credential.agent, credentialId: credential.id, requestId };
  }
}
