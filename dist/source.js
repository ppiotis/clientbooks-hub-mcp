import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
export const API_BASE = "https://api.xero.com/api.xro/2.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class LiveSource {
    store;
    oauth;
    fetchImpl;
    kind = "live";
    constructor(store, oauth, fetchImpl = fetch) {
        this.store = store;
        this.oauth = oauth;
        this.fetchImpl = fetchImpl;
    }
    async tenants() {
        return (await this.store.load()).connections.flatMap((c) => c.tenants);
    }
    async get(tenantId, resource, query = {}) {
        if (!/^[A-Za-z/]+$/.test(resource))
            throw new Error(`Invalid resource ${resource}`);
        const url = `${API_BASE}/${resource}${Object.keys(query).length ? "?" + new URLSearchParams(query) : ""}`;
        for (let attempt = 0; attempt < 4; attempt++) {
            const token = await this.oauth.accessTokenFor(tenantId);
            const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}`, "xero-tenant-id": tenantId, accept: "application/json" } });
            if (res.status === 429) {
                const wait = Math.min(60, Number(res.headers.get("retry-after") ?? 5));
                await sleep(wait * 1000);
                continue;
            }
            if (res.status === 401 && attempt === 0) {
                await this.oauth.accessTokenFor(tenantId, true);
                continue;
            }
            if (!res.ok)
                throw new Error(`Xero ${resource} returned HTTP ${res.status}`);
            return (await res.json());
        }
        throw new Error(`Xero ${resource}: gave up after repeated rate limiting`);
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
        const data = JSON.parse(await readFile(path.join(this.dir, tenantId, `${file}.json`), "utf8"));
        // Emulate Xero paging: everything is on page 1.
        if (query.page && query.page !== "1") {
            const key = Object.keys(data)[0];
            return { [key]: [] };
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
