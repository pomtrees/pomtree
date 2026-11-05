// Shared per-provider circuit breaker (TODO(provider-breaker)). Pure: no clock, no I/O. After `threshold` retryable
// errors inside `windowMs` the provider is "degraded" until a deadline; admission holds starts and retrying agents
// back off at least until then, so an outage is not hammered by every agent on its own schedule.
export class ProviderBreaker {
  private readonly errors = new Map<string, number[]>();
  private readonly until = new Map<string, number>();
  private readonly o: { threshold: number; windowMs: number };
  constructor(o: { threshold: number; windowMs: number }) {
    this.o = o;
  }

  // Records a retryable error. Returns the new degraded-until when this error tripped the breaker, else null.
  record(provider: string, now: number, holdMs: number): number | null {
    const recent = (this.errors.get(provider) ?? []).filter((t) => now - t < this.o.windowMs);
    recent.push(now);
    this.errors.set(provider, recent);
    if (recent.length < this.o.threshold) return null;
    const cur = this.until.get(provider) ?? 0;
    if (cur > now) return null; // already open
    const until = now + holdMs;
    this.until.set(provider, until);
    return until;
  }

  degradedUntil(provider: string, now: number): number | null {
    const u = this.until.get(provider);
    return u !== undefined && u > now ? u : null;
  }

  anyDegraded(now: number): boolean {
    for (const u of this.until.values()) if (u > now) return true;
    return false;
  }

  // A successful call closes the breaker for that provider.
  success(provider: string): void {
    this.errors.delete(provider);
    this.until.delete(provider);
  }
}
