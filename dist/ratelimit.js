export const XERO_LIMITS = { concurrent: 5, perMinute: 60, perDay: 5000 };
export class DailyLimitError extends Error {
}
const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
export class RateLimiter {
    limits;
    clock;
    t = new Map();
    constructor(limits = XERO_LIMITS, clock = realClock) {
        this.limits = limits;
        this.clock = clock;
    }
    state(id) {
        let s = this.t.get(id);
        if (!s)
            this.t.set(id, (s = { active: 0, queue: [], window: [], day: "", dayCount: 0, blockedUntil: 0 }));
        const day = new Date(this.clock.now()).toISOString().slice(0, 10);
        if (s.day !== day) {
            s.day = day;
            s.dayCount = 0;
            s.dayRemaining = undefined;
        }
        return s;
    }
    /** Runs fn when a slot is free for this tenant, respecting concurrency, the minute window and the daily cap. */
    async run(tenantId, fn) {
        const s = this.state(tenantId);
        if (s.active >= this.limits.concurrent)
            await new Promise((r) => s.queue.push(r));
        s.active += 1;
        try {
            for (;;) {
                const now = this.clock.now();
                s.window = s.window.filter((x) => now - x < 60_000);
                if (s.dayCount >= this.limits.perDay || s.dayRemaining === 0)
                    throw new DailyLimitError(`Xero daily API limit (${this.limits.perDay}/day) reached for this organisation; try again tomorrow (UTC).`);
                const waitBlock = s.blockedUntil - now;
                const waitWindow = s.window.length >= this.limits.perMinute ? 60_000 - (now - s.window[0]) + 5 : 0;
                const wait = Math.max(waitBlock, waitWindow);
                if (wait <= 0)
                    break;
                await this.clock.sleep(wait);
            }
            s.window.push(this.clock.now());
            s.dayCount += 1;
            return await fn();
        }
        finally {
            s.active -= 1;
            s.queue.shift()?.();
        }
    }
    /** Feed Xero's response headers back in (429 Retry-After, remaining-call counters). */
    observe(tenantId, status, headers) {
        const s = this.state(tenantId);
        const day = headers.get("x-daylimit-remaining");
        if (day !== null && day !== "" && Number.isFinite(Number(day)))
            s.dayRemaining = Number(day);
        if (status !== 429)
            return {};
        const problem = headers.get("x-rate-limit-problem") ?? undefined;
        const retryAfterMs = Math.min(120, Math.max(1, Number(headers.get("retry-after") ?? 5) || 5)) * 1000;
        if (problem === "day") {
            s.dayRemaining = 0;
            return { problem };
        }
        s.blockedUntil = this.clock.now() + retryAfterMs;
        return { retryAfterMs, problem };
    }
    usage(tenantId) { const s = this.state(tenantId); return { calls_today: s.dayCount, day_remaining_reported: s.dayRemaining ?? null, in_flight: s.active }; }
}
/** Run tasks with at most n in flight (used to fan out across tenants). */
export async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
            const k = i++;
            out[k] = await fn(items[k]);
        }
    }));
    return out;
}
