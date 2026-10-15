import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { XeroOAuth, FetchLike } from "./oauth.js";
import type { TokenStore, Tenant } from "./tokens.js";

export const API_BASE = "https://api.xero.com/api.xro/2.0";

/** Anything that can answer Xero Accounting API GETs for a tenant. */
export interface XeroSource {
  kind: "live" | "demo";
  tenants(): Promise<Tenant[]>;
  get(tenantId: string, resource: string, query?: Record<string, string>): Promise<Record<string, unknown>>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveSource implements XeroSource {
  kind = "live" as const;
  constructor(private store: TokenStore, private oauth: XeroOAuth, private fetchImpl: FetchLike = fetch) {}

  async tenants(): Promise<Tenant[]> {
    return (await this.store.load()).connections.flatMap((c) => c.tenants);
  }

  async get(tenantId: string, resource: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z/]+$/.test(resource)) throw new Error(`Invalid resource ${resource}`);
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
      if (!res.ok) throw new Error(`Xero ${resource} returned HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    }
    throw new Error(`Xero ${resource}: gave up after repeated rate limiting`);
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
    const data = JSON.parse(await readFile(path.join(this.dir, tenantId, `${file}.json`), "utf8")) as Record<string, unknown>;
    // Emulate Xero paging: everything is on page 1.
    if (query.page && query.page !== "1") {
      const key = Object.keys(data)[0];
      return { [key]: [] };
    }
    return data;
  }
}
