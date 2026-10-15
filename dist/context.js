import { loadConfig } from "./config.js";
import { TokenStore } from "./tokens.js";
import { XeroOAuth } from "./oauth.js";
import { FixtureSource, LiveSource } from "./source.js";
import { Cache } from "./sync.js";
let ctx;
export function buildContext(env = process.env, fetchImpl = fetch) {
    const cfg = loadConfig(env);
    const store = new TokenStore(cfg.tokenFile, cfg.tokenKey);
    const oauth = new XeroOAuth(cfg, store, fetchImpl);
    const source = cfg.demo ? new FixtureSource(cfg.fixturesDir) : new LiveSource(store, oauth, fetchImpl);
    const cache = new Cache(source, cfg.asOf);
    return { cfg, store, oauth, source, cache, payroll: new Map() };
}
/** Process-wide singleton so the in-memory cache and pending OAuth states survive across stateless HTTP requests. */
export function getContext() {
    if (!ctx) {
        ctx = buildContext();
        ctx.cache.startPolling(ctx.cfg.syncMinutes);
    }
    return ctx;
}
