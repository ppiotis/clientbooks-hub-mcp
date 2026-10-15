import { loadConfig, type Config } from "./config.js";
import { TokenStore } from "./tokens.js";
import { XeroOAuth, type FetchLike } from "./oauth.js";
import { FixtureSource, LiveSource, type XeroSource } from "./source.js";
import { Cache } from "./sync.js";
import type { PayrollProfile } from "./analytics.js";

export interface Context { cfg: Config; store: TokenStore; oauth: XeroOAuth; source: XeroSource; cache: Cache; payroll: Map<string, PayrollProfile> }

let ctx: Context | undefined;

export function buildContext(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): Context {
  const cfg = loadConfig(env);
  const store = new TokenStore(cfg.tokenFile, cfg.tokenKey);
  const oauth = new XeroOAuth(cfg, store, fetchImpl);
  const source: XeroSource = cfg.demo ? new FixtureSource(cfg.fixturesDir) : new LiveSource(store, oauth, fetchImpl);
  const cache = new Cache(source, cfg.asOf);
  return { cfg, store, oauth, source, cache, payroll: new Map() };
}

/** Process-wide singleton so the in-memory cache and pending OAuth states survive across stateless HTTP requests. */
export function getContext(): Context {
  if (!ctx) {
    ctx = buildContext();
    ctx.cache.startPolling(ctx.cfg.syncMinutes);
  }
  return ctx;
}
