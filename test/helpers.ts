import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FixtureSource } from "../src/source.js";
import { fetchOrg } from "../src/sync.js";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const AS_OF = "2026-09-30";
export const fixture = (tenant: string, name: string) => JSON.parse(readFileSync(path.join(FIXTURES, tenant, `${name}.json`), "utf8"));
export const tmp = (p = "xagg-") => mkdtempSync(path.join(tmpdir(), p));
export const rm = (d: string) => rmSync(d, { recursive: true, force: true });
export async function demoOrgs() {
  const src = new FixtureSource(FIXTURES);
  return { bakery: await fetchOrg(src, "harbour-bakery", AS_OF), joinery: await fetchOrg(src, "northwind-joinery", AS_OF) };
}

/** A fake Xero (identity + api) that serves the fixtures through the LIVE code path. */
export function fakeXero(opts: { rotate?: boolean; connections?: () => { tenantId: string; tenantName: string }[]; scope?: string } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let n = 0;
  const tenants: Record<string, string> = { "tid-bakery": "harbour-bakery", "tid-joinery": "northwind-joinery" };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://identity.xero.com/connect/token") {
      n += 1;
      return json({ access_token: `at-${n}`, refresh_token: opts.rotate === false ? "rt-1" : `rt-${n}`, expires_in: 1800, token_type: "Bearer", scope: opts.scope ?? "offline_access accounting.invoices.read" });
    }
    if (url.startsWith("https://api.xero.com/connections")) {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (opts.connections) return json(opts.connections().map((t, i) => ({ id: `conn-${i}`, tenantType: "ORGANISATION", ...t })));
      return json(Object.entries(tenants).map(([id, dir], i) => ({ id: `conn-${i}`, tenantId: id, tenantType: "ORGANISATION", tenantName: fixture(dir, "Organisation").Organisations[0].Name })));
    }
    const m = /api\.xro\/2\.0\/(?:Reports\/)?([A-Za-z]+)(\?.*)?$/.exec(url);
    if (m) {
      const h = new Headers(init?.headers);
      const dir = tenants[h.get("xero-tenant-id") ?? ""];
      if (!dir) return json({ error: "no tenant" }, 403);
      if (init?.method === "PUT" && m[1] === "ManualJournals") {
        const body = JSON.parse(String(init.body));
        return json({ ManualJournals: body.ManualJournals.map((j: Record<string, unknown>) => ({ ...j, ManualJournalID: "mj-created-1" })) });
      }
      const q = new URLSearchParams(m[2] ?? "");
      if (q.get("page") && q.get("page") !== "1") return json({ [m[1]]: [] });
      try { return json(fixture(dir, m[1])); } catch { return json({}); }
    }
    return json({ error: "unexpected " + url }, 404);
  }) as typeof fetch;
  return { impl, calls };
}
