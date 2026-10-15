import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildContext } from "../src/context.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { FixtureSource } from "../src/source.js";
import { fetchOrg } from "../src/sync.js";
import { pullDetail } from "../src/pull.js";
import { scanOrg, taxPeriod, taxReadiness, closeReadiness, DEFAULT_SCAN } from "../src/checks.js";
import { RateLimiter, mapLimit } from "../src/ratelimit.js";
import { AS_OF, FIXTURES, fakeXero, rm, tmp } from "./helpers.js";

const KEY = "test-key-0123456789abcdef";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(rm));
function env(extra: Record<string, string> = {}) {
  const d = tmp("xagg-pr-");
  dirs.push(d);
  return { dir: d, env: { XERO_CLIENT_ID: "cid", XERO_AGG_TOKEN_FILE: path.join(d, "tokens.enc"), XERO_AGG_TOKEN_KEY: KEY, XERO_AGG_EXPORT_DIR: path.join(d, "exports"),
    XERO_AGG_AUDIT_FILE: path.join(d, "audit.jsonl"), XERO_AGG_AS_OF: AS_OF, XERO_AGG_SYNC_MINUTES: "0", ...extra } as Record<string, string> };
}
async function mcp(ctx: ReturnType<typeof buildContext>) {
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0].text;
    return { isError: Boolean(r.isError), text, json: () => JSON.parse(text) };
  };
}
const demo = (extra: Record<string, string> = {}) => { const e = env({ XERO_AGG_DEMO: "1", ...extra }); return { ...e, ctx: buildContext(e.env) }; };
async function connect(ctx: ReturnType<typeof buildContext>) {
  const s = ctx.oauth.start();
  return ctx.oauth.complete({ redirect_url: `http://localhost:5173/oauth/callback?code=abc&state=${s.state}` });
}

async function kookaburra() {
  const src = new FixtureSource(FIXTURES);
  const det = await pullDetail(src, "kookaburra-coffee", AS_OF);
  const snap = await fetchOrg(src, "kookaburra-coffee", AS_OF);
  return { det, snap, findings: scanOrg(det, snap, DEFAULT_SCAN) };
}

describe("issue checks (pure)", () => {
  it("finds every planted issue in the Kookaburra sample org with correct values", async () => {
    const { findings } = await kookaburra();
    const by = (c: string) => findings.filter((f) => f.check === c);
    expect(findings).toHaveLength(18);
    expect(by("duplicate_invoice")).toHaveLength(1);
    expect(by("duplicate_invoice")[0]).toMatchObject({ severity: "high", value_at_risk: 5500, org: "Kookaburra Coffee Co Pty Ltd", tenant_id: "kookaburra-coffee", currency: "AUD" });
    expect(by("duplicate_invoice")[0].xero_link).toMatch(/^https:\/\/go\.xero\.com\/organisationlogin\/default\.aspx\?shortcode=!KOOK3&redirecturl=%2FAccountsPayable/);
    expect(by("duplicate_payment").map((f) => f.value_at_risk)).toEqual([1100]);
    expect(by("missing_tax_code")).toHaveLength(1);
    expect(by("missing_tax_code")[0]).toMatchObject({ severity: "high", value_at_risk: 2000, reference: { number: "KC-1003" } });
    expect(by("tax_anomaly").map((f) => f.value_at_risk).sort((a, b) => a - b)).toEqual([15, 64, 330]); // TEL-0925 GST 45 vs 30; cash sale NONE; KC-1004 BASEXCLUDED
    expect(by("unreconciled_bank").map((f) => f.value_at_risk)).toEqual([1980, 640]); // 85.00 line is only 3 days old
    expect(by("unreconciled_payment")).toHaveLength(1);
    expect(by("suspense_balance")[0]).toMatchObject({ severity: "high", value_at_risk: 734.2 });
    expect(by("large_variance")[0]).toMatchObject({ title: "Repairs and Maintenance up 645% in Sep 26", value_at_risk: 3116.67 });
    expect(by("stale_draft").map((f) => f.reference?.type).sort()).toEqual(["Invoice", "ManualJournal"]);
    expect(by("missing_attachment").map((f) => f.value_at_risk)).toEqual([5500, 1980, 1320]);
    expect(by("overdue_tax_liability")[0]).toMatchObject({ value_at_risk: 2950, title: "ATO liability 33 days overdue" });
    expect(by("lock_date")[0].title).toBe("Lock date 2026-03-31 is 5 month(s) behind");
    for (const f of findings) { expect(f.suggested_fix.length).toBeGreaterThan(10); expect(["high", "medium", "low"]).toContain(f.severity); }
  });
  it("stale_days is configurable and filters are honoured", async () => {
    const { det, snap } = await kookaburra();
    expect(scanOrg(det, snap, { ...DEFAULT_SCAN, staleDays: 30, checks: ["unreconciled_bank"] }).map((f) => f.value_at_risk)).toEqual([1980]);
    expect(scanOrg(det, snap, { ...DEFAULT_SCAN, staleDays: 0, checks: ["unreconciled_bank"] })).toHaveLength(3);
    expect(scanOrg(det, snap, { ...DEFAULT_SCAN, minSeverity: "high" }).every((f) => f.severity === "high")).toBe(true);
  });
  it("tax period, BAS readiness and close readiness", async () => {
    expect(taxPeriod("2026-09-30")).toMatchObject({ from: "2026-07-01", to: "2026-09-30" });
    expect(taxPeriod("2026-02-28", "MONTHLY")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    // live regression: mid-period as-of must prepare the period that just ended, not the open one
    expect(taxPeriod("2026-10-15")).toMatchObject({ from: "2026-07-01", to: "2026-09-30" });
    expect(taxPeriod("2026-01-20")).toMatchObject({ from: "2025-10-01", to: "2025-12-31" });
    expect(taxPeriod("2026-02-10", "MONTHLY")).toMatchObject({ from: "2026-01-01", to: "2026-01-31" });
    const { det, findings } = await kookaburra();
    const t = taxReadiness(det, findings);
    expect(t).toMatchObject({ return_type: "BAS", status: "not ready", basis: "ACCRUALS", period: { from: "2026-07-01", to: "2026-09-30" } });
    expect(t.items.filter((i) => i.level === "blocker").map((i) => i.check).sort()).toEqual(["missing_tax_code", "suspense_balance", "unreconciled_bank", "unreconciled_bank"]);
    const c = closeReadiness(det, findings);
    expect(c).toMatchObject({ score: 0, status: "not ready", of: 10 });
  });
});

describe("live-found false positives (Demo Company, 15 Oct 2026)", () => {
  const meta = { name: "Live Org", currency: "USD", country: "US", shortCode: "!abc", lockDate: "2026-09-30" };
  const det = (invoices: unknown[], bankTx: unknown[] = []) => ({ tenantId: "t", meta, asOf: "2026-10-15", from: "2026-06-17", invoices, bankTx, payments: [], accounts: [], taxRates: [], manualJournals: [], gaps: [] }) as never;
  const bill = (id: string, no: string, date: string, total = 1181.25, contact = "c-rent") => ({ Type: "ACCPAY", InvoiceID: id, InvoiceNumber: no, Status: "PAID", Contact: { ContactID: contact, Name: "Landlord" }, DateString: `${date}T00:00:00`, Total: total, AmountDue: 0 });
  it("monthly rent / weekly cleaning with the same number are recurring, not duplicates", () => {
    const rent = [bill("1", "RENT", "2026-07-28"), bill("2", "RENT", "2026-08-28"), bill("3", "RENT", "2026-09-17")];
    const clean = ["2026-08-25", "2026-09-01", "2026-09-08", "2026-09-15"].map((d, i) => bill(`c${i}`, `M00${i}`, d, 216.5, "c-clean"));
    expect(scanOrg(det([...rent, ...clean]), undefined, { ...DEFAULT_SCAN, checks: ["duplicate_invoice"] })).toEqual([]);
    expect(scanOrg(det([bill("a", "BB-1", "2026-09-12", 5500, "s"), bill("b", "BB-1", "2026-09-13", 5500, "s")]), undefined, { ...DEFAULT_SCAN, checks: ["duplicate_invoice"] })).toHaveLength(1);
  });
  it("daily parking spends are recurring, not duplicate payments", () => {
    const park = ["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-05"].map((d, i) => ({ BankTransactionID: `p${i}`, Type: "SPEND", Status: "AUTHORISED", Contact: { ContactID: "park", Name: "Parking" }, DateString: `${d}T00:00:00`, Total: 12 }));
    expect(scanOrg(det([], park), undefined, { ...DEFAULT_SCAN, checks: ["duplicate_payment"] })).toEqual([]);
  });
  it("a mid-month as-of does not report the part month as a 100% variance", async () => {
    const src = new FixtureSource(FIXTURES);
    const snap = await fetchOrg(src, "northwind-joinery", AS_OF);
    const mid = { ...snap, asOf: "2026-10-15", pnl: [{ ...snap.pnl[0], label: "31 Oct 26", income: 0, expenses: 0, lines: snap.pnl[0].lines.map((l) => ({ ...l, amount: 0 })) }, ...snap.pnl] };
    const f = scanOrg(det([]), mid, { ...DEFAULT_SCAN, checks: ["large_variance"] });
    expect(f.map((x) => x.title)).toEqual(["Materials up 72% in Sep 26"]);
  });
});

describe("practice tools over MCP (demo)", () => {
  it("answers the practice questions in one call each", async () => {
    const { ctx } = demo();
    const call = await mcp(ctx);
    const un = (await call("unreconciled_items", { older_than_days: 20 })).json();
    expect(un.orgs.map((o: { org: string; count: number }) => [o.org, o.count])).toEqual([["Northwind Joinery Ltd", 3], ["Harbour Bakery Ltd", 3], ["Kookaburra Coffee Co Pty Ltd", 2]]);
    const scan = (await call("scan_issues", {})).json();
    expect(scan.orgs_scanned).toBe(3);
    expect(scan.summary.value_at_risk_by_currency).toEqual({ GBP: 14537.41, AUD: 29709.87 });
    expect(scan.findings.every((f: { org: string; tenant_id: string }) => f.org && f.tenant_id)).toBe(true);
    const tax = (await call("tax_readiness", {})).json();
    expect(tax.not_ready).toEqual(["Harbour Bakery Ltd", "Kookaburra Coffee Co Pty Ltd", "Northwind Joinery Ltd"]);
    const close = (await call("close_readiness", {})).json();
    expect(close.orgs.map((o: { org: string; score: number }) => [o.org, o.score])).toEqual([["Kookaburra Coffee Co Pty Ltd", 0], ["Northwind Joinery Ltd", 70], ["Harbour Bakery Ltd", 80]]);
    const one = (await call("scan_issues", { orgs: ["harbour"], checks: ["lock_date"] })).json();
    expect(one.findings.map((f: { org: string }) => f.org)).toEqual(["Harbour Bakery Ltd"]);
    expect((await call("scan_issues", { orgs: ["Ltd"] })).text).toMatch(/matches several orgs/);
  });
  it("pull_data across every org, tagged with org and tenant", async () => {
    const { ctx } = demo();
    const call = await mcp(ctx);
    const bills = (await call("pull_data", { resource: "bills", status: "AUTHORISED" })).json();
    expect(bills.orgs.map((o: { org: string; count: number }) => [o.org, o.count])).toEqual([["Harbour Bakery Ltd", 3], ["Kookaburra Coffee Co Pty Ltd", 5], ["Northwind Joinery Ltd", 4]]);
    const tb = (await call("pull_data", { resource: "trial_balance", orgs: ["kook"] })).json();
    expect(tb.orgs[0].columns).toEqual(["Account", "Debit", "Credit", "YTD Debit", "YTD Credit"]);
    expect(tb.orgs[0].rows.find((r: { account: string }) => r.account === "Suspense (899)").values[1]).toBe(734.2);
    const ap = (await call("pull_data", { resource: "aged_payables", orgs: ["northwind"] })).json();
    expect(ap.orgs[0].rows.reduce((s: number, r: { amount_due: number }) => s + r.amount_due, 0)).toBe(10180);
    const inv = (await call("pull_data", { resource: "invoices", from_date: "2026-09-01", to_date: "2026-09-30" })).json();
    expect(inv.orgs.flatMap((o: { rows: { date: string }[] }) => o.rows).every((r: { date: string }) => r.date >= "2026-09-01" && r.date <= "2026-09-30")).toBe(true);
    for (const r of ["contacts", "accounts", "tax_rates", "payments", "manual_journals", "bank_transactions", "profit_and_loss", "balance_sheet", "bank_summary", "aged_receivables", "journals", "credit_notes"]) {
      const res = (await call("pull_data", { resource: r })).json();
      expect(res.orgs.every((o: { ok: boolean }) => o.ok), r).toBe(true);
    }
  });
  it("month_end_summary drafts commentary and exports a practice workbook", async () => {
    const { ctx, dir } = demo();
    const call = await mcp(ctx);
    const m = (await call("month_end_summary", { export: true })).json();
    const nw = m.orgs.find((o: { org: string }) => o.org === "Northwind Joinery Ltd");
    expect(nw).toMatchObject({ cash: { total: 7212.4 }, receivables: { total: 21205.5 }, payables: { total: 10180 }, pnl: { income: 23300, net: -10300 } });
    expect(nw.commentary_draft[1]).toMatch(/Materials up 72%.*Explanation needed/);
    expect(m.file.startsWith(path.join(dir, "exports"))).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(m.file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Exceptions"]);
    expect(wb.getWorksheet("Exceptions")!.rowCount).toBe(32); // header + 31 findings
  });
  it("practice_scan ranks the book and use_last serves the stored scan without new reads", async () => {
    const { ctx } = demo();
    const call = await mcp(ctx);
    const r = (await call("practice_scan", { top: 5 })).json();
    expect(r.clients.map((c: { org: string }) => c.org)).toEqual(["Kookaburra Coffee Co Pty Ltd", "Northwind Joinery Ltd", "Harbour Bakery Ltd"]);
    expect(r.top_findings).toHaveLength(5);
    ctx.counter.drain();
    const again = (await call("practice_scan", { use_last: true })).json();
    expect(again.ran_at).toBe(r.ran_at);
    expect(ctx.counter.drain()).toEqual([]);
  });
});

describe("safe write-back", () => {
  const lines = [{ account_code: "899", amount: 734.2, description: "Clear suspense" }, { account_code: "469", amount: -734.2 }];
  it("prepare validates and never calls Xero; confirm refuses while writes are disabled", async () => {
    const { ctx, env: e } = demo();
    const call = await mcp(ctx);
    expect((await call("prepare_manual_journal", { org: "kook", date: "2026-09-30", narration: "x bad", lines: [{ account_code: "899", amount: 1 }, { account_code: "469", amount: -2 }] })).text).toMatch(/does not balance/);
    expect((await call("prepare_manual_journal", { org: "kook", date: "2026-09-30", narration: "x bad", lines: [{ account_code: "999", amount: 1 }, { account_code: "469", amount: -1 }] })).text).toMatch(/Unknown or archived account code.*999/);
    expect((await call("prepare_manual_journal", { org: "kook", date: "2026-03-01", narration: "locked", lines })).text).toMatch(/locked up to 2026-03-31/);
    expect((await call("prepare_manual_journal", { org: "kook", date: "2026-09-30", narration: "bank", lines: [{ account_code: "090", amount: 1 }, { account_code: "469", amount: -1 }] })).text).toMatch(/bank accounts/);
    const p = (await call("prepare_manual_journal", { org: "kook", date: "2026-09-30", narration: "Clear suspense to rent", lines, reason: "suspense_balance finding" })).json();
    expect(p.confirmation_phrase).toBe(`POST DRAFT ${p.proposal_id} TO Kookaburra Coffee Co Pty Ltd`);
    expect((await call("confirm_manual_journal", { proposal_id: p.proposal_id, confirmation_phrase: p.confirmation_phrase })).text).toMatch(/Write-back is disabled/);
    const audit = readFileSync(e.XERO_AGG_AUDIT_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.map((a) => a.event)).toEqual(expect.arrayContaining(["proposal_created", "confirm_refused", "read"]));
    expect(statSync(e.XERO_AGG_AUDIT_FILE).mode & 0o777).toBe(0o600);
    const trail = (await call("audit_trail", { org: "kook", event: "proposal_created" })).json();
    expect(trail.entries[0]).toMatchObject({ org: "Kookaburra Coffee Co Pty Ltd", reason: "suspense_balance finding" });
  });
  it("demo + writes enabled: phrase must match the org exactly, single use, simulated only", async () => {
    const { ctx } = demo({ XERO_AGG_ENABLE_WRITES: "1" });
    const call = await mcp(ctx);
    const p = (await call("prepare_manual_journal", { org: "kook", date: "2026-09-30", narration: "Clear suspense", lines })).json();
    expect((await call("confirm_manual_journal", { proposal_id: p.proposal_id, confirmation_phrase: `POST DRAFT ${p.proposal_id} TO Northwind Joinery Ltd` })).text).toMatch(/does not match/);
    const ok = (await call("confirm_manual_journal", { proposal_id: p.proposal_id, confirmation_phrase: p.confirmation_phrase.toLowerCase() })).json();
    expect(ok.status).toMatch(/simulated/);
    expect(ok.would_send.ManualJournals[0]).toMatchObject({ Status: "DRAFT", Date: "2026-09-30" });
    expect((await call("confirm_manual_journal", { proposal_id: p.proposal_id, confirmation_phrase: p.confirmation_phrase })).text).toMatch(/already used/);
    expect((await call("list_proposals")).json().proposals[0].status).toBe("used");
  });
  it("live path: refuses a read-only grant, then PUTs a DRAFT journal with the right tenant once the scope is granted", async () => {
    const ro = env({ XERO_AGG_ENABLE_WRITES: "1" });
    const fx1 = fakeXero();
    const c1 = buildContext(ro.env, fx1.impl);
    await connect(c1);
    const call1 = await mcp(c1);
    const p1 = (await call1("prepare_manual_journal", { org: "Harbour", date: "2026-09-30", narration: "Accrue rent", lines: [{ account_code: "469", amount: 100 }, { account_code: "825", amount: -100 }] })).json();
    expect((await call1("confirm_manual_journal", { proposal_id: p1.proposal_id, confirmation_phrase: p1.confirmation_phrase })).text).toMatch(/read-only scopes/);
    expect(fx1.calls.some((c) => c.init?.method === "PUT")).toBe(false);

    const rw = env({ XERO_AGG_ENABLE_WRITES: "1" });
    const fx = fakeXero({ scope: "offline_access accounting.invoices.read accounting.manualjournals" });
    const ctx = buildContext(rw.env, fx.impl);
    expect(ctx.cfg.scopes).toContain("accounting.manualjournals");
    await connect(ctx);
    const call = await mcp(ctx);
    const p = (await call("prepare_manual_journal", { org: "Harbour", date: "2026-09-30", narration: "Accrue rent", lines: [{ account_code: "469", amount: 100 }, { account_code: "825", amount: -100 }] })).json();
    expect(fx.calls.some((c) => c.init?.method === "PUT")).toBe(false); // prepare never writes
    const r = (await call("confirm_manual_journal", { proposal_id: p.proposal_id, confirmation_phrase: p.confirmation_phrase })).json();
    expect(r).toMatchObject({ status: "created in Xero as DRAFT", org: "Harbour Bakery Ltd", tenant_id: "tid-bakery", manual_journal_id: "mj-created-1" });
    const puts = fx.calls.filter((c) => c.init?.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(new Headers(puts[0].init!.headers).get("xero-tenant-id")).toBe("tid-bakery");
    expect(JSON.parse(String(puts[0].init!.body)).ManualJournals[0]).toMatchObject({ Status: "DRAFT", JournalLines: [{ AccountCode: "469", LineAmount: 100 }, { AccountCode: "825", LineAmount: -100 }] });
  });
  it("write scopes are opt-in", () => {
    expect(loadConfig({}).scopes.some((s) => !s.endsWith(".read") && s.startsWith("accounting."))).toBe(false);
    expect(loadConfig({ XERO_AGG_ENABLE_WRITES: "1" }).scopes).toContain("accounting.manualjournals");
    expect(loadConfig({ XERO_AGG_ENABLE_WRITES: "1", XERO_SCOPE_SET: "broad" }).scopes).toContain("accounting.transactions");
    expect(() => loadConfig({ XERO_SCOPES: "accounting.manualjournals offline_access" })).toThrow(/XERO_AGG_ENABLE_WRITES/);
    expect(() => loadConfig({ XERO_AGG_ENABLE_WRITES: "1", XERO_SCOPES: "payroll.employees" })).toThrow(/non read-only/);
  });
});

describe("multi-tenant connection maintenance", () => {
  it("refreshConnections renames and drops revoked orgs but never adds new ones", async () => {
    const { env: e } = env();
    let live = [{ tenantId: "tid-bakery", tenantName: "Harbour Bakery Ltd" }, { tenantId: "tid-joinery", tenantName: "Northwind Joinery Ltd" }];
    const fx = fakeXero({ connections: () => live });
    const ctx = buildContext(e, fx.impl);
    await connect(ctx);
    live = [{ tenantId: "tid-bakery", tenantName: "Harbour Bakery Group Ltd" }, { tenantId: "tid-new", tenantName: "Sneaky New Org" }];
    const r = await ctx.oauth.refreshConnections();
    expect(r).toMatchObject({ renamed: ["Harbour Bakery Ltd -> Harbour Bakery Group Ltd"], removed: ["Northwind Joinery Ltd"], errors: [] });
    expect((await ctx.source.tenants()).map((t) => t.tenantName)).toEqual(["Harbour Bakery Group Ltd"]);
    const call = await mcp(ctx);
    const lo = (await call("list_orgs", { refresh_connections: true })).json();
    expect(lo.orgs.map((o: { name: string }) => o.name)).toEqual(["Harbour Bakery Group Ltd"]);
    expect(lo.orgs[0].api_usage.calls_today).toBeGreaterThan(0);
  });
});

describe("rate limiter", () => {
  function clock() { let t = Date.UTC(2026, 8, 30, 12); return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => (t += ms) }; }
  it("caps 5 concurrent calls per tenant", async () => {
    const rl = new RateLimiter();
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => rl.run("t1", async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; })));
    expect(peak).toBe(5);
  });
  it("waits for the rolling 60-per-minute window, per tenant", async () => {
    const c = clock();
    const rl = new RateLimiter({ concurrent: 5, perMinute: 60, perDay: 5000 }, c);
    const start = c.now();
    for (let i = 0; i < 60; i++) await rl.run("t1", async () => undefined);
    await rl.run("t2", async () => undefined);
    expect(c.now() - start).toBe(0); // other tenant unaffected
    await rl.run("t1", async () => undefined);
    expect(c.now() - start).toBeGreaterThanOrEqual(60_000);
  });
  it("stops at the daily cap and honours Retry-After / day-limit headers", async () => {
    const c = clock();
    const rl = new RateLimiter({ concurrent: 5, perMinute: 1000, perDay: 3 }, c);
    for (let i = 0; i < 3; i++) await rl.run("t1", async () => undefined);
    await expect(rl.run("t1", async () => undefined)).rejects.toThrow(/daily API limit/);
    const r2 = new RateLimiter(undefined, c);
    expect(r2.observe("t1", 429, new Headers({ "retry-after": "7", "x-rate-limit-problem": "minute" }))).toMatchObject({ retryAfterMs: 7000 });
    const t0 = c.now();
    await r2.run("t1", async () => undefined);
    expect(c.now() - t0).toBe(7000);
    r2.observe("t2", 200, new Headers({ "x-daylimit-remaining": "0" }));
    await expect(r2.run("t2", async () => undefined)).rejects.toThrow(/daily/);
  });
  it("LiveSource retries 429 with Retry-After and gives up cleanly on the daily limit", async () => {
    const { env: e } = env();
    const fx = fakeXero();
    let n = 0;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("TaxRates") && n++ === 0) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
      if (u.includes("Accounts")) return new Response("{}", { status: 429, headers: { "retry-after": "1", "x-rate-limit-problem": "day" } });
      return fx.impl(input, init);
    }) as typeof fetch;
    const ctx = buildContext(e, impl);
    await connect(ctx);
    const slept: number[] = [];
    const { LiveSource } = await import("../src/source.js");
    const live = new LiveSource(ctx.store, ctx.oauth, impl, undefined, async (ms) => { slept.push(ms); });
    expect(((await live.get("tid-bakery", "TaxRates")) as { TaxRates: unknown[] }).TaxRates.length).toBe(4);
    expect(slept).toEqual([1000]);
    await expect(live.get("tid-bakery", "Accounts")).rejects.toThrow(/daily limit/);
  });
  it("mapLimit keeps order and bounds parallelism", async () => {
    let active = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 2)); active--; return x * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
