import { loadConfig } from "./config.js";
import { TokenStore } from "./tokens.js";
import { XeroOAuth } from "./oauth.js";
import { FixtureSource, LiveSource, MixedSource } from "./source.js";
import { Cache } from "./sync.js";
import { AuditLog, CountingSource } from "./audit.js";
import { Practice } from "./practice.js";
import { RateLimiter, XERO_LIMITS } from "./ratelimit.js";
let ctx;
export function buildContext(env = process.env, fetchImpl = fetch) {
    const cfg = loadConfig(env);
    const store = new TokenStore(cfg.tokenFile, cfg.tokenKey);
    const oauth = new XeroOAuth(cfg, store, fetchImpl);
    // Xero plan tiers differ (e.g. 1,000/day on Starter); XERO_AGG_DAILY_LIMIT lowers the local daily cap to match.
    const perDay = Math.max(1, Number(env.XERO_AGG_DAILY_LIMIT ?? XERO_LIMITS.perDay) || XERO_LIMITS.perDay);
    const live = new LiveSource(store, oauth, fetchImpl, new RateLimiter({ ...XERO_LIMITS, perDay }));
    const inner = cfg.demo ? new FixtureSource(cfg.fixturesDir)
        : env.XERO_AGG_EXTRA_FIXTURES ? new MixedSource(live, new FixtureSource(env.XERO_AGG_EXTRA_FIXTURES)) : live;
    const counter = new CountingSource(inner);
    // Before each sync of a live book, re-read /connections (at most every 15 min) to pick up renamed/revoked orgs.
    const beforeSync = cfg.demo ? undefined : async () => { await live.refreshConnections().catch(() => undefined); };
    const cache = new Cache(counter, cfg.asOf, beforeSync);
    const c = { cfg, store, oauth, source: counter, live, counter, cache, payroll: new Map(), audit: new AuditLog(cfg.auditFile) };
    c.practice = new Practice(c);
    return c;
}
/** Process-wide singleton so the in-memory cache and pending OAuth states survive across stateless HTTP requests. */
export function getContext() {
    if (!ctx) {
        ctx = buildContext();
        ctx.cache.startPolling(ctx.cfg.syncMinutes);
        ctx.practice.startSchedule(ctx.cfg.scanMinutes);
    }
    return ctx;
}
