/**
 * Per-tenant Xero rate limiting. Xero allows, per tenant per app: 5 concurrent calls, 60 calls per
 * rolling minute and 5,000 per day (plus 10,000/min app-wide). We stay under those locally and also
 * trust Xero's own X-MinLimit-Remaining / X-DayLimit-Remaining headers when they arrive.
 */
export interface Limits { concurrent: number; perMinute: number; perDay: number }
export const XERO_LIMITS: Limits = { concurrent: 5, perMinute: 60, perDay: 5000 };

export class DailyLimitError extends Error {}

type Clock = { now(): number; sleep(ms: number): Promise<void> };
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

interface TenantState { active: number; queue: (() => void)[]; window: number[]; day: string; dayCount: number; dayRemaining?: number; blockedUntil: number }

export class RateLimiter {
  private t = new Map<string, TenantState>();
  constructor(private limits: Limits = XERO_LIMITS, private clock: Clock = realClock) {}

  private state(id: string): TenantState {
    let s = this.t.get(id);
    if (!s) this.t.set(id, (s = { active: 0, queue: [], window: [], day: "", dayCount: 0, blockedUntil: 0 }));
    const day = new Date(this.clock.now()).toISOString().slice(0, 10);
    if (s.day !== day) { s.day = day; s.dayCount = 0; s.dayRemaining = undefined; }
    return s;
  }

  /** Runs fn when a slot is free for this tenant, respecting concurrency, the minute window and the daily cap. */
  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const s = this.state(tenantId);
    if (s.active >= this.limits.concurrent) await new Promise<void>((r) => s.queue.push(r));
    s.active += 1;
    try {
      for (;;) {
        const now = this.clock.now();
        s.window = s.window.filter((x) => now - x < 60_000);
        if (s.dayCount >= this.limits.perDay || s.dayRemaining === 0) throw new DailyLimitError(`Xero daily API limit (${this.limits.perDay}/day) reached for this organisation; try again tomorrow (UTC).`);
        const waitBlock = s.blockedUntil - now;
        const waitWindow = s.window.length >= this.limits.perMinute ? 60_000 - (now - s.window[0]) + 5 : 0;
        const wait = Math.max(waitBlock, waitWindow);
        if (wait <= 0) break;
        await this.clock.sleep(wait);
      }
      s.window.push(this.clock.now());
      s.dayCount += 1;
      return await fn();
    } finally {
      s.active -= 1;
      s.queue.shift()?.();
    }
  }

  /** Feed Xero's response headers back in (429 Retry-After, remaining-call counters). */
  observe(tenantId: string, status: number, headers: Headers): { retryAfterMs?: number; problem?: string } {
    const s = this.state(tenantId);
    const day = headers.get("x-daylimit-remaining");
    if (day !== null && day !== "" && Number.isFinite(Number(day))) s.dayRemaining = Number(day);
    if (status !== 429) return {};
    const problem = headers.get("x-rate-limit-problem") ?? undefined;
    const retryAfterMs = Math.min(120, Math.max(1, Number(headers.get("retry-after") ?? 5) || 5)) * 1000;
    if (problem === "day") { s.dayRemaining = 0; return { problem }; }
    s.blockedUntil = this.clock.now() + retryAfterMs;
    return { retryAfterMs, problem };
  }

  usage(tenantId: string) { const s = this.state(tenantId); return { calls_today: s.dayCount, day_remaining_reported: s.dayRemaining ?? null, in_flight: s.active }; }
}

/** Run tasks with at most n in flight (used to fan out across tenants). */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
