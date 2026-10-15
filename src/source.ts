import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { XeroOAuth, FetchLike } from "./oauth.js";
import type { TokenStore, Tenant } from "./tokens.js";
import { RateLimiter } from "./ratelimit.js";

export const API_BASE = "https://api.xero.com/api.xro/2.0";

/** Anything that can answer Xero Accounting API GETs for a tenant. */
export interface XeroSource {
  kind: "live" | "demo";
  tenants(): Promise<Tenant[]>;
  get(tenantId: string, resource: string, query?: Record<string, string>): Promise<Record<string, unknown>>;
  /** Write path. Only LiveSource implements it, and only the confirm_* tools call it. */
  post?(tenantId: string, resource: string, body: unknown): Promise<Record<string, unknown>>;
}

/** Thrown for HTTP status errors so callers can tell "missing scope / not on your tier" (401/403) from outages. */
export class XeroHttpError extends Error {
  constructor(public resource: string, public status: number, detail = "") {
    super(`Xero ${resource} returned HTTP ${status}${status === 403 || status === 401 ? " (not authorised: the connection lacks the scope for this endpoint, or your Xero app tier does not include it)" : ""}${detail ? `: ${detail}` : ""}`);
  }
}
const RESOURCE = /^(Reports\/)?[A-Za-z]+$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveSource implements XeroSource {
  kind = "live" as const;
  readonly limiter: RateLimiter;
  private lastConnRefresh = 0;
  constructor(private store: TokenStore, private oauth: XeroOAuth, private fetchImpl: FetchLike = fetch, limiter?: RateLimiter, private sleepImpl = sleep) {
    this.limiter = limiter ?? new RateLimiter();
  }

  async tenants(): Promise<Tenant[]> {
    return (await this.store.load()).connections.flatMap((c) => c.tenants);
  }

  /** GET /connections at most every 15 minutes (called before each sync) so renamed/revoked orgs are picked up. */
  async refreshConnections(force = false) {
    if (!force && Date.now() - this.lastConnRefresh < 15 * 60_000) return undefined;
    this.lastConnRefresh = Date.now();
    return this.oauth.refreshConnections();
  }

  private async call(tenantId: string, resource: string, url: string, init: { method: string; body?: string }): Promise<Record<string, unknown>> {
    if (!RESOURCE.test(resource)) throw new Error(`Invalid resource ${resource}`);
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = await this.oauth.accessTokenFor(tenantId);
      const res = await this.limiter.run(tenantId, () => this.fetchImpl(url, { method: init.method, body: init.body,
        headers: { authorization: `Bearer ${token}`, "xero-tenant-id": tenantId, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } }));
      const rl = this.limiter.observe(tenantId, res.status, res.headers);
      if (res.status === 429) {
        if (rl.problem === "day") throw new XeroHttpError(resource, 429, "daily limit for this organisation reached");
        await this.sleepImpl(rl.retryAfterMs ?? 5000);
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        await this.oauth.accessTokenFor(tenantId, true);
        continue;
      }
      if (!res.ok) {
        let detail = "";
        try { const j = (await res.json()) as { Message?: string; Elements?: { ValidationErrors?: { Message: string }[] }[] }; detail = [j.Message, ...(j.Elements ?? []).flatMap((e) => (e.ValidationErrors ?? []).map((v) => v.Message))].filter(Boolean).join("; "); } catch { /* not json */ }
        throw new XeroHttpError(resource, res.status, detail);
      }
      return (await res.json()) as Record<string, unknown>;
    }
    throw new Error(`Xero ${resource}: gave up after repeated rate limiting`);
  }

  async get(tenantId: string, resource: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const url = `${API_BASE}/${resource}${Object.keys(query).length ? "?" + new URLSearchParams(query) : ""}`;
    return this.call(tenantId, resource, url, { method: "GET" });
  }

  async post(tenantId: string, resource: string, body: unknown): Promise<Record<string, unknown>> {
    if (resource !== "ManualJournals") throw new Error("Only ManualJournals can be written by ClientBooks Hub");
    return this.call(tenantId, resource, `${API_BASE}/${resource}`, { method: "PUT", body: JSON.stringify(body) });
  }
}

/** Serves recorded/fixture Xero responses from <dir>/<tenant>/<Resource>.json. Read-only, no network. */
export class FixtureSource implements XeroSource {
  kind = "demo" as const;
  constructor(private dir: string) {}

  async tenants(): Promise<Tenant[]> {
    const entries = (await readdir(this.dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const out: Tenant[] = [];
    for (const name of entries) {
      const org = JSON.parse(await readFile(path.join(this.dir, name, "Organisation.json"), "utf8")) as { Organisations: { OrganisationID: string; Name: string }[] };
      out.push({ tenantId: name, tenantName: org.Organisations[0].Name });
    }
    return out;
  }

  async get(tenantId: string, resource: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (!/^[a-z0-9-]+$/.test(tenantId)) throw new Error("Invalid demo tenant");
    const file = resource.replace(/^Reports\//, "");
    if (!/^[A-Za-z]+$/.test(file)) throw new Error(`Invalid resource ${resource}`);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await readFile(path.join(this.dir, tenantId, `${file}.json`), "utf8")) as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; // no sample data for this endpoint: behaves like an empty list
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
export class MixedSource implements XeroSource {
  kind = "live" as const;
  private fixtureIds = new Set<string>();
  constructor(private live: XeroSource, private fixtures: FixtureSource) {}
  async tenants(): Promise<Tenant[]> {
    const fx = await this.fixtures.tenants();
    this.fixtureIds = new Set(fx.map((t) => t.tenantId));
    return [...(await this.live.tenants()), ...fx.map((t) => ({ ...t, tenantName: `${t.tenantName} (sample)` }))];
  }
  async get(tenantId: string, resource: string, query: Record<string, string> = {}) {
    if (!this.fixtureIds.size) await this.tenants();
    if (!this.fixtureIds.has(tenantId)) return this.live.get(tenantId, resource, query);
    const data = await this.fixtures.get(tenantId, resource, query);
    if (resource === "Organisation") {
      const orgs = (data as { Organisations?: { Name: string }[] }).Organisations ?? [];
      return { ...data, Organisations: orgs.map((o) => ({ ...o, Name: `${o.Name} (sample)` })) };
    }
    return data;
  }
}
