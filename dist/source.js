import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RateLimiter } from "./ratelimit.js";
export const API_BASE = "https://api.xero.com/api.xro/2.0";
/** Thrown for HTTP status errors so callers can tell "missing scope / not on your tier" (401/403) from outages. */
export class XeroHttpError extends Error {
    resource;
    status;
    constructor(resource, status, detail = "") {
        super(`Xero ${resource} returned HTTP ${status}${status === 403 || status === 401 ? " (not authorised: the connection lacks the scope for this endpoint, or your Xero app tier does not include it)" : ""}${detail ? `: ${detail}` : ""}`);
        this.resource = resource;
        this.status = status;
    }
}
const RESOURCE = /^(Reports\/)?[A-Za-z]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class LiveSource {
    store;
    oauth;
    fetchImpl;
    sleepImpl;
    kind = "live";
    limiter;
    lastConnRefresh = 0;
    constructor(store, oauth, fetchImpl = fetch, limiter, sleepImpl = sleep) {
        this.store = store;
        this.oauth = oauth;
        this.fetchImpl = fetchImpl;
        this.sleepImpl = sleepImpl;
        this.limiter = limiter ?? new RateLimiter();
    }
    async tenants() {
        return (await this.store.load()).connections.flatMap((c) => c.tenants);
    }
    /** GET /connections at most every 15 minutes (called before each sync) so renamed/revoked orgs are picked up. */
    async refreshConnections(force = false) {
        if (!force && Date.now() - this.lastConnRefresh < 15 * 60_000)
            return undefined;
        this.lastConnRefresh = Date.now();
        return this.oauth.refreshConnections();
    }
    async call(tenantId, resource, url, init) {
        if (!RESOURCE.test(resource))
            throw new Error(`Invalid resource ${resource}`);
        for (let attempt = 0; attempt < 5; attempt++) {
            const token = await this.oauth.accessTokenFor(tenantId);
            const res = await this.limiter.run(tenantId, () => this.fetchImpl(url, { method: init.method, body: init.body,
                headers: { authorization: `Bearer ${token}`, "xero-tenant-id": tenantId, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } }));
            const rl = this.limiter.observe(tenantId, res.status, res.headers);
            if (res.status === 429) {
                if (rl.problem === "day")
                    throw new XeroHttpError(resource, 429, "daily limit for this organisation reached");
                await this.sleepImpl(rl.retryAfterMs ?? 5000);
                continue;
            }
            if (res.status === 401 && attempt === 0) {
                await this.oauth.accessTokenFor(tenantId, true);
                continue;
            }
            if (!res.ok) {
                let detail = "";
                try {
                    const j = (await res.json());
                    detail = [j.Message, ...(j.Elements ?? []).flatMap((e) => (e.ValidationErrors ?? []).map((v) => v.Message))].filter(Boolean).join("; ");
                }
                catch { /* not json */ }
                throw new XeroHttpError(resource, res.status, detail);
            }
            return (await res.json());
        }
        throw new Error(`Xero ${resource}: gave up after repeated rate limiting`);
    }
    async get(tenantId, resource, query = {}) {
        const url = `${API_BASE}/${resource}${Object.keys(query).length ? "?" + new URLSearchParams(query) : ""}`;
        return this.call(tenantId, resource, url, { method: "GET" });
    }
    async post(tenantId, resource, body) {
        if (resource !== "ManualJournals")
            throw new Error("Only ManualJournals can be written by ClientBooks Hub");
        return this.call(tenantId, resource, `${API_BASE}/${resource}`, { method: "PUT", body: JSON.stringify(body) });
    }
}
/** Serves recorded/fixture Xero responses from <dir>/<tenant>/<Resource>.json. Read-only, no network. */
export class FixtureSource {
    dir;
    kind = "demo";
    constructor(dir) {
        this.dir = dir;
    }
    async tenants() {
        const entries = (await readdir(this.dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
        const out = [];
        for (const name of entries) {
            const org = JSON.parse(await readFile(path.join(this.dir, name, "Organisation.json"), "utf8"));
            out.push({ tenantId: name, tenantName: org.Organisations[0].Name });
        }
        return out;
    }
    async get(tenantId, resource, query = {}) {
        if (!/^[a-z0-9-]+$/.test(tenantId))
            throw new Error("Invalid demo tenant");
        const file = resource.replace(/^Reports\//, "");
        if (!/^[A-Za-z]+$/.test(file))
            throw new Error(`Invalid resource ${resource}`);
        let data;
        try {
            data = JSON.parse(await readFile(path.join(this.dir, tenantId, `${file}.json`), "utf8"));
        }
        catch (e) {
            if (e.code === "ENOENT")
                return {}; // no sample data for this endpoint: behaves like an empty list
            throw e;
        }
        // Emulate Xero paging: everything is on page 1.
        if (query.page && query.page !== "1") {
            const key = Object.keys(data)[0];
            return key ? { [key]: [] } : {};
        }
        return data;
    }
}
/**
 * Live orgs plus fixture orgs side by side (XERO_AGG_EXTRA_FIXTURES=<dir>). For trials and reviewer
 * testing when only one real Xero org is available. Fixture tenants are labelled "(sample)".
 */
export class MixedSource {
    live;
    fixtures;
    kind = "live";
    fixtureIds = new Set();
    constructor(live, fixtures) {
        this.live = live;
        this.fixtures = fixtures;
    }
    async tenants() {
        const fx = await this.fixtures.tenants();
        this.fixtureIds = new Set(fx.map((t) => t.tenantId));
        return [...(await this.live.tenants()), ...fx.map((t) => ({ ...t, tenantName: `${t.tenantName} (sample)` }))];
    }
    async get(tenantId, resource, query = {}) {
        if (!this.fixtureIds.size)
            await this.tenants();
        if (!this.fixtureIds.has(tenantId))
            return this.live.get(tenantId, resource, query);
        const data = await this.fixtures.get(tenantId, resource, query);
        if (resource === "Organisation") {
            const orgs = data.Organisations ?? [];
            return { ...data, Organisations: orgs.map((o) => ({ ...o, Name: `${o.Name} (sample)` })) };
        }
        return data;
    }
}
