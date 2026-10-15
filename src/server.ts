import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safe, UserError } from "./result.js";
import { getContext, type Context } from "./context.js";
import { health, overdueAcross, payrollRisk, practiceDashboard, trendingTrouble } from "./analytics.js";
import { writePack } from "./xlsx.js";
import type { OrgSnapshot } from "./normalize.js";

export const VERSION = "1.0.0";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const asOf = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional().describe("Report date (YYYY-MM-DD). Defaults to today (demo mode: 2026-09-30).");
const orgArg = z.string().min(1).max(120).describe("Client org: tenant id or (part of) the organisation name, e.g. 'Northwind'.");

function resolveOrg(orgs: OrgSnapshot[], q: string): OrgSnapshot {
  const exact = orgs.find((o) => o.orgId === q || o.name.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  const hits = orgs.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new UserError(`No connected org matches "${q}". Connected: ${orgs.map((o) => o.name).join(", ")}`);
  throw new UserError(`"${q}" matches several orgs: ${hits.map((o) => o.name).join(", ")}. Be more specific.`);
}

export function createServer(c: Context = getContext()): McpServer {
  const server = new McpServer({ name: "xero-aggregator", version: VERSION });
  const { cfg, cache, oauth } = c;

  server.registerTool("connect_org_start", {
    title: "Start connecting a client's Xero org",
    description: "Creates a Xero OAuth2 (authorization code + PKCE) sign-in link with READ-ONLY scopes. Give the link to the client (or open it yourself if you are their adviser user); they pick their org and approve. Then call connect_org_complete with the URL they were redirected to. Not needed in demo mode.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, safe(async () => {
    if (cfg.demo) return { mode: "demo", message: "Demo mode: two fixture orgs (Harbour Bakery Ltd, Northwind Joinery Ltd) are already connected. Unset XERO_AGG_DEMO to connect real orgs." };
    const s = oauth.start();
    return { ...s, scopes: cfg.scopes, redirect_uri: cfg.redirectUri, next_step: "Ask the user to open authorize_url, approve, then paste the full URL of the page they land on into connect_org_complete." };
  }));

  server.registerTool("connect_org_complete", {
    title: "Finish connecting a Xero org",
    description: "Exchanges the authorization code from Xero's redirect for tokens, encrypts them at rest, and syncs the new org. Pass the full redirect URL (contains code and state).",
    inputSchema: { redirect_url: z.string().url().max(4000).describe("The full URL the browser was redirected to after approving in Xero.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, safe(async ({ redirect_url }: { redirect_url: string }) => {
    if (cfg.demo) throw new UserError("Demo mode is on; there is nothing to connect.");
    const conn = await oauth.complete({ redirect_url });
    const sync = await cache.sync();
    return { connected: conn.tenants.map((t) => t.tenantName), scopes: conn.scopes, stored: "OAuth tokens only, AES-256-GCM encrypted", sync };
  }));

  server.registerTool("list_orgs", {
    title: "List connected client orgs",
    description: "Lists every connected Xero org with sync status, currency and counts. Start here.",
    inputSchema: {},
    annotations: RO,
  }, safe(async () => {
    const tenants = await c.source.tenants();
    if (!cache.lastSync && tenants.length) await cache.sync();
    return {
      mode: c.source.kind, poll_interval_minutes: cfg.syncMinutes, last_sync: cache.lastSync?.syncedAt ?? null, as_of: cache.lastSync?.asOf ?? null,
      orgs: tenants.map((t) => {
        const o = cache.orgs.get(t.tenantId);
        const st = cache.lastSync?.orgs.find((x) => x.orgId === t.tenantId);
        return { org_id: t.tenantId, name: t.tenantName, currency: o?.currency ?? null, synced: Boolean(st?.ok), error: st?.error,
          open_invoices: o?.invoices.filter((i) => i.kind === "receivable").length ?? 0, open_bills: o?.invoices.filter((i) => i.kind === "payable").length ?? 0,
          contacts: o?.contacts ?? 0, bank_accounts: o?.bank.length ?? 0 };
      }),
    };
  }));

  server.registerTool("sync_now", {
    title: "Sync all orgs now",
    description: "Re-fetches invoices, bills, contacts, bank balances and reports for every connected org into the in-memory cache (nothing financial is written to disk). The poller also does this automatically every XERO_AGG_SYNC_MINUTES.",
    inputSchema: { as_of: asOf },
    annotations: RO,
  }, safe(async ({ as_of }: { as_of?: string }) => cache.sync(as_of)));

  server.registerTool("overdue_invoices", {
    title: "Overdue invoices across all clients",
    description: "Every client invoice (receivable) more than 30, 60 or 90 days past its due date, across all connected orgs, with per-org and per-currency totals. Uses amount still due (part-payments excluded).",
    inputSchema: { min_days: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(30).describe("Overdue by MORE than this many days."), as_of: asOf },
    annotations: RO,
  }, safe(async ({ min_days, as_of }: { min_days: 30 | 60 | 90; as_of?: string }) => ({ as_of: cache.asOf(as_of), ...overdueAcross(await cache.ensure(as_of), min_days) })));

  server.registerTool("payroll_risk", {
    title: "Payroll risk ranking",
    description: "Ranks orgs by how close they are to missing their next payroll. coverage = (cash in bank - bills due on or before payroll date) / payroll amount. Below 1.0 means a shortfall. Payroll amount defaults to the average of wages/salaries P&L lines over the last 3 months, next payroll date to the next 25th; override with set_payroll_profile. Shows the formula with numbers for each org.",
    inputSchema: { as_of: asOf },
    annotations: RO,
  }, safe(async ({ as_of }: { as_of?: string }) => {
    const rows = (await cache.ensure(as_of)).map((o) => ({ org_id: o.orgId, ...payrollRisk(o, c.payroll.get(o.orgId)) }))
      .sort((a, b) => (a.coverage_ratio ?? Infinity) - (b.coverage_ratio ?? Infinity));
    return { as_of: cache.asOf(as_of), closest_to_missing_payroll: rows[0]?.org ?? null, orgs: rows };
  }));

  server.registerTool("set_payroll_profile", {
    title: "Set an org's payroll amount/date",
    description: "Overrides the estimated payroll amount and/or next payroll date for one org. Held in memory only (cleared on restart); nothing is sent to Xero.",
    inputSchema: { org: orgArg, amount: z.number().positive().max(1e9).optional(), next_payroll_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, safe(async ({ org, amount, next_payroll_date }: { org: string; amount?: number; next_payroll_date?: string }) => {
    const o = resolveOrg(await cache.ensure(), org);
    c.payroll.set(o.orgId, { amount, nextDate: next_payroll_date });
    return { org: o.name, payroll_profile: c.payroll.get(o.orgId), persisted: false, result: payrollRisk(o, c.payroll.get(o.orgId)) };
  }));

  server.registerTool("month_end_pack", {
    title: "Export a client's month-end pack (.xlsx)",
    description: "Writes an Excel workbook for ONE client with three sheets: Aged Receivables (per invoice, bucketed current/1-30/31-60/61-90/90+ with totals), Bank Reconciliation (closing balance, unreconciled count and amount per account) and P&L Snapshot (latest month and period total). Saved in XERO_AGG_EXPORT_DIR; returns the path and the totals written so you can quote them.",
    inputSchema: { org: orgArg, as_of: asOf },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, safe(async ({ org, as_of }: { org: string; as_of?: string }) => {
    const o = resolveOrg(await cache.ensure(as_of), org);
    return { org: o.name, as_of: o.asOf, ...(await writePack(o, cfg.exportDir)) };
  }));

  server.registerTool("client_health", {
    title: "Client health score",
    description: "0-100 health score per client from transparent rules (each rule and its points is listed): 90+ day receivables share, payroll coverage, expense spike (z-score of latest month vs trailing months), growing director loan, DSO, unreconciled items, falling income. >=80 healthy, 60-79 watch, <60 at risk. Omit org for all clients.",
    inputSchema: { org: orgArg.optional(), as_of: asOf },
    annotations: RO,
  }, safe(async ({ org, as_of }: { org?: string; as_of?: string }) => {
    const orgs = await cache.ensure(as_of);
    const list = org ? [resolveOrg(orgs, org)] : orgs;
    return { as_of: cache.asOf(as_of), clients: list.map((o) => health(o, c.payroll.get(o.orgId))) };
  }));

  server.registerTool("practice_dashboard", {
    title: "Practice dashboard",
    description: "Practice-level totals: revenue (P&L income) across all clients for the last N months, grouped by currency (never mixes currencies), average DSO, and each client's health band.",
    inputSchema: { months: z.number().int().min(1).max(12).default(3), as_of: asOf },
    annotations: RO,
  }, safe(async ({ months, as_of }: { months: number; as_of?: string }) => ({ as_of: cache.asOf(as_of), ...practiceDashboard(await cache.ensure(as_of), months, c.payroll) })));

  server.registerTool("clients_trending_trouble", {
    title: "Clients trending toward trouble",
    description: "Clients whose health score is below the threshold (default 80), worst first, with the reasons.",
    inputSchema: { threshold: z.number().int().min(1).max(100).default(80), as_of: asOf },
    annotations: RO,
  }, safe(async ({ threshold, as_of }: { threshold: number; as_of?: string }) => ({ as_of: cache.asOf(as_of), ...trendingTrouble(await cache.ensure(as_of), c.payroll, threshold) })));

  server.registerTool("disconnect_org", {
    title: "Disconnect a client's Xero org",
    description: "Revokes this app's Xero connection for one org and deletes its stored tokens and cached data. Call first with confirm=false to see what will happen, ask the user, then confirm=true.",
    inputSchema: { org: orgArg, confirm: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, safe(async ({ org, confirm }: { org: string; confirm: boolean }) => {
    if (cfg.demo) throw new UserError("Demo mode: fixture orgs cannot be disconnected.");
    const tenants = await c.source.tenants();
    const t = tenants.find((x) => x.tenantId === org) ?? (() => {
      const hits = tenants.filter((x) => x.tenantName.toLowerCase().includes(org.toLowerCase()));
      if (hits.length !== 1) throw new UserError(hits.length ? `Ambiguous: ${hits.map((h) => h.tenantName).join(", ")}` : `No connected org matches "${org}"`);
      return hits[0];
    })();
    if (!confirm) return { status: "preview", will_disconnect: t.tenantName, effect: "Revokes the Xero connection and deletes its encrypted tokens and cached data. Call again with confirm=true after the user agrees." };
    const r = await oauth.disconnect(t.tenantId);
    cache.forget(t.tenantId);
    return { status: "done", org: t.tenantName, ...r };
  }));

  return server;
}
