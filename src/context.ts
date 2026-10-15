import { loadConfig, type Config } from "./config.js";
import { TokenStore } from "./tokens.js";
import { XeroOAuth, type FetchLike } from "./oauth.js";
import { FixtureSource, LiveSource, MixedSource, type XeroSource } from "./source.js";
import { Cache } from "./sync.js";
import type { PayrollProfile } from "./analytics.js";
import { AuditLog, CountingSource } from "./audit.js";
import { Practice } from "./practice.js";
import { RateLimiter, XERO_LIMITS } from "./ratelimit.js";

export interface Context {
  cfg: Config; store: TokenStore; oauth: XeroOAuth; source: XeroSource; live: LiveSource; counter: CountingSource; cache: Cache;
  payroll: Map<string, PayrollProfile>; audit: AuditLog; practice: Practice;
}

let ctx: Context | undefined;

export function buildContext(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): Context {
  const cfg = loadConfig(env);
  const store = new TokenStore(cfg.tokenFile, cfg.tokenKey);
  const oauth = new XeroOAuth(cfg, store, fetchImpl);
  // Xero plan tiers differ (e.g. 1,000/day on Starter); XERO_AGG_DAILY_LIMIT lowers the local daily cap to match.
  const perDay = Math.max(1, Number(env.XERO_AGG_DAILY_LIMIT ?? XERO_LIMITS.perDay) || XERO_LIMITS.perDay);
  const live = new LiveSource(store, oauth, fetchImpl, new RateLimiter({ ...XERO_LIMITS, perDay }));
  const inner: XeroSource = cfg.demo ? new FixtureSource(cfg.fixturesDir)
    : env.XERO_AGG_EXTRA_FIXTURES ? new MixedSource(live, new FixtureSource(env.XERO_AGG_EXTRA_FIXTURES)) : live;
  const counter = new CountingSource(inner);
  // Before each sync of a live book, re-read /connections (at most every 15 min) to pick up renamed/revoked orgs.
  const beforeSync = cfg.demo ? undefined : async () => { await live.refreshConnections().catch(() => undefined); };
  const cache = new Cache(counter, cfg.asOf, beforeSync);
  const c = { cfg, store, oauth, source: counter as XeroSource, live, counter, cache, payroll: new Map(), audit: new AuditLog(cfg.auditFile) } as Omit<Context, "practice"> as Context;
  c.practice = new Practice(c);
  return c;
}

/** Process-wide singleton so the in-memory cache and pending OAuth states survive across stateless HTTP requests. */
export function getContext(): Context {
  if (!ctx) {
    ctx = buildContext();
    ctx.cache.startPolling(ctx.cfg.syncMinutes);
    ctx.practice.startSchedule(ctx.cfg.scanMinutes);
  }
  return ctx;
}
