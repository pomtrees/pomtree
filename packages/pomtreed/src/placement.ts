import { randomBytes } from "node:crypto";
import type { AgentId, HostId, HostRecord, HostStore, Placement, PlacementStatus, Reservation, Resources, TemplateId } from "@pomtree/core";
import { pendingReasons } from "./auto-sessions.ts";

export const NO_HOST_REASON = "no host satisfies requirements";

type Req = { agent: AgentId; priority: number; resources?: Resources; template?: TemplateId; affinity?: { host?: HostId } };

// Placement over the host and reservation tables (HostStore): the running set and the queue live in the
// store, never here, so a restarted daemon sees what the last one admitted. The only in-memory state is the
// listener list and a promise-chain mutex (which holds no placement state) that serializes mutations.
// TODO(multi-host): scoring is count-based (affinity, then fewest running); warm-image and parked-folder
// scoring, expiring `reserved` rows and drain-aware placement wait for the multi-host node contract.
export class HostPlacement implements Placement {
  private readonly hosts: HostStore;
  private readonly local: HostId;
  private readonly requiresOf: ((template: TemplateId) => Promise<string[]>) | undefined;
  private readonly ready: (() => Promise<unknown>) | undefined;
  private readyP: Promise<void> | undefined;
  private listeners: ((agent: AgentId, host: HostId) => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly nonce = randomBytes(6).toString("hex"); // keys must differ across restarts: the store replays a repeated key
  private n = 0;

  // `host` is the host this daemon's node runs on: `sync` reconciles that host's running set. `requires` maps a
  // template id to its `Template.requires` labels (absent = no requirements).
  // `ready` (optional) runs once before the first operation, e.g. `() => node.register(hosts)`.
  constructor(opts: { hosts: HostStore; host: HostId; requires?: (template: TemplateId) => Promise<string[]>; ready?: () => Promise<unknown> }) {
    this.hosts = opts.hosts;
    this.local = opts.host;
    this.requiresOf = opts.requires;
    this.ready = opts.ready;
  }

  // Called when a queued agent is promoted by a release.
  onAdmit(cb: (agent: AgentId, host: HostId) => void): void {
    this.listeners.push(cb);
  }

  private key(op: string, agent: AgentId): string {
    return `placement:${op}:${agent}:${this.nonce}:${++this.n}`;
  }

  // Runs `ready` once, before the first operation (hosts registered lazily, e.g. by sync test rigs).
  private ensureReady(): Promise<void> {
    // A rejected `ready` is not cached: the next operation retries it.
    this.readyP ??= Promise.resolve()
      .then(() => this.ready?.())
      .then(
        () => {},
        (e) => {
          this.readyP = undefined;
          throw e;
        },
      );
    return this.readyP;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.ensureReady()).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // Template `requires` entries are label names (or `name=value` pairs); a host satisfies one when its labels carry it.
  private static labelOk(h: HostRecord, req: string): boolean {
    const eq = req.indexOf("=");
    if (eq < 0) return req in h.labels;
    return h.labels[req.slice(0, eq)] === req.slice(eq + 1);
  }

  // Per-session fit against a host's capacity, where both sides state a figure.
  private static fits(h: HostRecord, r: Resources | undefined): boolean {
    const c = h.capacity;
    if (r?.cpus !== undefined && c.cpus !== undefined && r.cpus > c.cpus) return false;
    if (r?.memoryBytes !== undefined && c.memoryBytes !== undefined && r.memoryBytes > c.memoryBytes) return false;
    if (r?.shmBytes !== undefined && c.shmBytes !== undefined && r.shmBytes > c.shmBytes) return false;
    return true;
  }

  private async requires(template: TemplateId | null | undefined): Promise<string[]> {
    return template == null || !this.requiresOf ? [] : this.requiresOf(template);
  }

  private eligible(hosts: HostRecord[], r: { resources?: Resources; requires: string[] }): HostRecord[] {
    return hosts.filter((h) => h.state === "ready" && r.requires.every((q) => HostPlacement.labelOk(h, q)) && HostPlacement.fits(h, r.resources));
  }

  private async load(): Promise<{ hosts: HostRecord[]; running: Reservation[] }> {
    return { hosts: await this.hosts.listHosts(), running: await this.hosts.listReservations({ state: "running" }) };
  }

  private slotFull(hosts: HostRecord[], running: Reservation[]): string {
    const ids = new Set(hosts.map((h) => h.id));
    return pendingReasons.slot(
      running.filter((r) => r.host !== null && ids.has(r.host)).length,
      hosts.reduce((n, h) => n + h.capacity.maxSessions, 0),
    );
  }

  // A free eligible host for `r`: the affinity host if free, else the one with the fewest running agents.
  private pick(hosts: HostRecord[], running: Reservation[], r: { resources?: Resources; requires: string[]; affinity?: HostId }): HostRecord | null {
    const count = (h: HostRecord) => running.filter((x) => x.host === h.id).length;
    const free = this.eligible(hosts, r).filter((h) => count(h) < h.capacity.maxSessions);
    if (!free.length) return null;
    const preferred = r.affinity === undefined ? undefined : free.find((h) => h.id === r.affinity);
    if (preferred) return preferred;
    return free.reduce((best, h) => (count(h) < count(best) ? h : best));
  }

  // TODO(multi-host): reservations carry no generation (every stored record is meant to carry host id and generation). Current behavior:
  // admit is keyed by agent only, so a stale-generation admit receives the existing answer (its running host or its
  // queued reason). The daemon does NOT fence before calling admit (Daemon.admit re-reads only the agent's state);
  // it fences after: drive() via registry.transition(id, gen, ...), the resume path via the `fresh.generation !== gen`
  // check, which returns without touching the worktree (the superseding run owns the slot).
  admit(req: Req): Promise<{ host: HostId } | { queued: true; reason: string }> {
    return this.locked(async () => {
      const cur = await this.hosts.getReservation(req.agent);
      const { hosts, running } = await this.load();
      const need = { ...(req.resources !== undefined && { resources: req.resources }), requires: await this.requires(req.template) };
      if (cur?.state === "running" && cur.host !== null) return { host: cur.host };
      if (cur?.state === "queued") {
        const ok = this.eligible(hosts, need);
        return { queued: true as const, reason: ok.length ? this.slotFull(ok, running) : NO_HOST_REASON };
      }
      const host = this.pick(hosts, running, { ...need, ...(req.affinity?.host !== undefined && { affinity: req.affinity.host }) });
      const base = { agent: req.agent, priority: req.priority, resources: req.resources ?? {}, template: req.template ?? null };
      if (host) {
        await this.hosts.reserve({ ...base, host: host.id, state: "running" }, this.key("admit", req.agent));
        return { host: host.id };
      }
      await this.hosts.reserve({ ...base, host: null, state: "queued" }, this.key("queue", req.agent));
      const ok = this.eligible(hosts, need);
      return { queued: true as const, reason: ok.length ? this.slotFull(ok, running) : NO_HOST_REASON };
    });
  }

  async status(): Promise<PlacementStatus[]> {
    await this.ensureReady();
    const { hosts, running } = await this.load();
    const queue = (await this.hosts.listReservations({ state: "queued" })).map((q) => ({ agent: q.agent, priority: q.priority }));
    return hosts.map((h) => ({
      host: h.id,
      maxConcurrent: h.capacity.maxSessions,
      running: running.filter((r) => r.host === h.id).map((r) => r.agent),
      queue: queue.map((q) => ({ ...q })),
    }));
  }

  // Reconcile the local host with the agents actually running: listed agents become running (they already hold a
  // container, so they bypass the cap and leave the queue); other agents running here are released.
  sync(agents: AgentId[]): Promise<void> {
    return this.locked(async () => {
      const live = new Set(agents);
      for (const a of live) {
        const cur = await this.hosts.getReservation(a);
        if (cur?.state === "running" && cur.host === this.local) continue;
        await this.hosts.reserve(
          { agent: a, host: this.local, state: "running", priority: cur?.priority ?? 0, resources: cur?.resources ?? {}, template: cur?.template ?? null },
          this.key("sync", a),
        );
      }
      for (const r of await this.hosts.listReservations({ host: this.local, state: "running" })) {
        if (!live.has(r.agent)) await this.hosts.releaseReservation(r.agent, this.key("sync-release", r.agent));
      }
      await this.promote();
    });
  }

  release(agent: AgentId): Promise<void> {
    return this.locked(async () => {
      const cur = await this.hosts.getReservation(agent);
      if (!cur) return;
      await this.hosts.releaseReservation(agent, this.key("release", agent));
      if (cur.state === "running") await this.promote();
    });
  }

  // Promote the best queued reservation (priority, then arrival) onto a free host until none fits. Listeners are
  // told BEFORE the promotion is committed: one that throws leaves the agent queued and the slot free.
  private async promote(): Promise<void> {
    for (;;) {
      const { hosts, running } = await this.load();
      let chosen: { q: Reservation; host: HostRecord } | null = null;
      for (const q of await this.hosts.listReservations({ state: "queued" })) {
        const host = this.pick(hosts, running, {
          ...(Object.keys(q.resources).length > 0 && { resources: q.resources }),
          requires: await this.requires(q.template),
        });
        if (host) {
          chosen = { q, host };
          break;
        }
      }
      if (!chosen) return;
      for (const cb of this.listeners) cb(chosen.q.agent, chosen.host.id);
      await this.hosts.reserve(
        {
          agent: chosen.q.agent,
          host: chosen.host.id,
          state: "running",
          priority: chosen.q.priority,
          resources: chosen.q.resources,
          template: chosen.q.template,
        },
        this.key("promote", chosen.q.agent),
      );
    }
  }
}
