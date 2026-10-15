/** v1.2 practice-scale tools: data pulls, issue scans, BAS/VAT + close readiness, month-end summaries, safe write-back, audit. */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safe, UserError } from "./result.js";
import type { Context } from "./context.js";
import { agedReceivables, BUCKETS, bucketOf, daysBetween } from "./analytics.js";
import { CHECKS, DEFAULT_SCAN, brief, closedMonths, closeReadiness, scanOrg, summarise, taxReadiness, type CheckName, type Finding, type ScanOptions, type Severity } from "./checks.js";
import { compact, deepLink, flattenReport, pages, pullDetail, RESOURCES, type OrgDetail, type ResourceName } from "./pull.js";
import { num, round2, type OrgSnapshot } from "./normalize.js";
import { mapLimit } from "./ratelimit.js";
import { WRITE_SCOPE_BROAD, WRITE_SCOPE_GRANULAR } from "./config.js";
import type { Tenant } from "./tokens.js";
import { slug } from "./xlsx.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const asOfArg = isoDate.optional().describe("Report date (YYYY-MM-DD). Defaults to today (demo mode: 2026-09-30).");
const orgsArg = z.array(z.string().min(1).max(120)).max(200).optional().describe("Client orgs (tenant ids or partial names). Omit for EVERY connected org.");
const TENANT_FANOUT = 3; // orgs scanned in parallel; each is still capped at 5 concurrent / 60 per minute by the rate limiter

export function resolveTenants(all: Tenant[], wanted?: string[]): Tenant[] {
  if (!wanted?.length) return all;
  return wanted.map((q) => {
    const exact = all.find((t) => t.tenantId === q || t.tenantName.toLowerCase() === q.toLowerCase());
    if (exact) return exact;
    const hits = all.filter((t) => t.tenantName.toLowerCase().includes(q.toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new UserError(`No connected org matches "${q}". Connected: ${all.map((t) => t.tenantName).join(", ")}`);
    throw new UserError(`"${q}" matches several orgs: ${hits.map((t) => t.tenantName).join(", ")}. Be more specific.`);
  }).filter((t, i, arr) => arr.findIndex((x) => x.tenantId === t.tenantId) === i);
}

export interface OrgScan { tenant_id: string; org: string; ok: boolean; error?: string; detail?: OrgDetail; snap?: OrgSnapshot; findings: Finding[] }
export interface PracticeScanResult { as_of: string; ran_at: string; trigger: "on_demand" | "scheduled"; orgs: OrgScan[] }

export class Practice {
  private details = new Map<string, { at: number; det: OrgDetail }>();
  lastScan?: PracticeScanResult;
  proposals = new Map<string, Proposal>();
  private timer?: NodeJS.Timeout;
  constructor(private c: Context) {}

  async detail(t: Tenant, asOf: string): Promise<OrgDetail> {
    const k = `${t.tenantId}|${asOf}`;
    const hit = this.details.get(k);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.det;
    const det = await pullDetail(this.c.source, t.tenantId, asOf);
    this.details.set(k, { at: Date.now(), det });
    return det;
  }
  invalidate() { this.details.clear(); }

  async tenants(wanted?: string[]) {
    const all = await this.c.source.tenants();
    if (!all.length) throw new UserError("No Xero organisations connected yet. Use connect_org_start to connect a client's org.");
    return resolveTenants(all, wanted);
  }

  async scan(asOf: string, wanted: string[] | undefined, opt: ScanOptions, trigger: PracticeScanResult["trigger"] = "on_demand"): Promise<PracticeScanResult> {
    const tenants = await this.tenants(wanted);
    await this.c.cache.ensure(asOf);
    const orgs = await mapLimit(tenants, TENANT_FANOUT, async (t): Promise<OrgScan> => {
      try {
        const det = await this.detail(t, asOf);
        const snap = this.c.cache.orgs.get(t.tenantId);
        return { tenant_id: t.tenantId, org: det.meta.name, ok: true, detail: det, snap, findings: scanOrg(det, snap, opt) };
      } catch (e) {
        return { tenant_id: t.tenantId, org: t.tenantName, ok: false, error: e instanceof Error ? e.message : String(e), findings: [] };
      }
    });
    const res = { as_of: asOf, ran_at: new Date().toISOString(), trigger, orgs: orgs.sort((a, b) => a.org.localeCompare(b.org)) };
    if (!wanted?.length) this.lastScan = res;
    return res;
  }

  /** Optional in-process schedule (XERO_AGG_SCAN_MINUTES): refresh data and re-scan the whole book. */
  startSchedule(minutes: number) {
    if (this.timer) clearInterval(this.timer);
    if (minutes <= 0) return;
    this.timer = setInterval(() => void (async () => {
      const asOf = this.c.cache.asOf();
      await this.c.cache.sync(asOf);
      this.invalidate();
      const r = await this.scan(asOf, undefined, { ...DEFAULT_SCAN, staleDays: this.c.cfg.staleDays }, "scheduled");
      await this.c.audit.write({ event: "scheduled_scan", orgs: r.orgs.length, findings: r.orgs.reduce((s, o) => s + o.findings.length, 0), reads: this.c.counter.drain() });
    })().catch(() => undefined), minutes * 60_000);
    this.timer.unref();
  }
}

export interface ProposalLine { account_code: string; amount: number; description?: string; tax_type?: string }
export interface Proposal { id: string; tenant_id: string; org: string; date: string; narration: string; lines: ProposalLine[]; reason?: string; created_at: number; phrase: string; used: boolean }
const PROPOSAL_TTL_MS = 30 * 60_000;

function arSnapshot(o: OrgSnapshot) { const a = agedReceivables(o); return { total: a.total, buckets: a.totals, invoices: a.rows.length }; }
function apSnapshot(o: OrgSnapshot) {
  const rows = o.invoices.filter((i) => i.kind === "payable").map((i) => ({ amt: i.amountDue, b: bucketOf(daysBetween(i.dueDate, o.asOf)) }));
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, round2(rows.filter((r) => r.b === b).reduce((s, r) => s + r.amt, 0))]));
  return { total: round2(rows.reduce((s, r) => s + r.amt, 0)), buckets, bills: rows.length };
}

/** Plain-English variance commentary draft, for the accountant to edit before it goes anywhere. */
export function commentary(o: OrgSnapshot, findings: Finding[]): string[] {
  const [m0, m1] = closedMonths(o);
  if (!m0) return ["No P&L data for this period."];
  const pct = (a: number, b: number) => (b ? `${a >= b ? "up" : "down"} ${Math.abs(Math.round(((a - b) / Math.abs(b)) * 100))}%` : "n/a");
  const lines = [`${m0.label}: income ${o.currency} ${m0.income.toLocaleString("en-GB")}${m1 ? ` (${pct(m0.income, m1.income)} on ${m1.label})` : ""}, expenses ${m0.expenses.toLocaleString("en-GB")}${m1 ? ` (${pct(m0.expenses, m1.expenses)})` : ""}, net ${m0.netProfit >= 0 ? "profit" : "loss"} ${Math.abs(m0.netProfit).toLocaleString("en-GB")}.`];
  for (const f of findings.filter((x) => x.check === "large_variance").slice(0, 5)) lines.push(`${f.title}: ${f.detail}. [Explanation needed from client]`);
  const unrec = findings.filter((f) => f.check === "unreconciled_bank");
  if (unrec.length) lines.push(`${unrec.length} bank line(s) unreconciled for more than the threshold (${o.currency} ${round2(unrec.reduce((s, f) => s + f.value_at_risk, 0))}); figures may move once reconciled.`);
  return lines;
}

export function registerPracticeTools(server: McpServer, c: Context) {
  const p = c.practice;
  const audited = <A>(tool: string, fn: (a: A) => Promise<unknown>) => safe(async (a: A) => {
    try { return await fn(a); }
    finally { const reads = c.counter.drain(); if (reads.length) await c.audit.write({ event: "read", tool, reads }).catch(() => undefined); }
  });
  const scanOpts = (a: { stale_days?: number; min_severity?: Severity; checks?: CheckName[]; attachment_threshold?: number; variance_pct?: number; variance_min_amount?: number }): ScanOptions => ({
    ...DEFAULT_SCAN, staleDays: a.stale_days ?? c.cfg.staleDays, minSeverity: a.min_severity, checks: a.checks,
    attachmentThreshold: a.attachment_threshold ?? DEFAULT_SCAN.attachmentThreshold, variancePct: a.variance_pct ?? DEFAULT_SCAN.variancePct, varianceMinAmount: a.variance_min_amount ?? DEFAULT_SCAN.varianceMinAmount });
  const gapsOf = (s: OrgScan) => (s.detail?.gaps.length ? s.detail.gaps.map((g) => `${g.resource}: ${g.reason}`) : undefined);

  server.registerTool("pull_data", {
    title: "Pull Xero data across clients",
    description: `Pulls one kind of Xero data from every connected org (or the orgs you name), each row tagged with org and tenant_id. Resources: ${RESOURCES.join(", ")}. Lists are compacted (ids, numbers, contacts, dates, amounts, status); reports are flattened to section/account/values rows with their column headers. aged_receivables/aged_payables are computed from open invoices/bills (Xero's aged reports need one contact at a time). journals needs Xero Advanced tier; if not granted the org shows an error instead. Read-only.`,
    inputSchema: { resource: z.enum(RESOURCES), orgs: orgsArg, from_date: isoDate.optional().describe("Lists: only items dated on/after. Reports: period start (P&L)."), to_date: isoDate.optional().describe("Lists: only items dated on/before. Reports: report date / period end."),
      status: z.string().regex(/^[A-Z,]+$/).optional().describe("Invoices/bills: e.g. AUTHORISED or DRAFT,AUTHORISED"), max_rows: z.number().int().min(1).max(1000).default(100).describe("Per org.") },
    annotations: RO,
  }, audited("pull_data", async (a: { resource: ResourceName; orgs?: string[]; from_date?: string; to_date?: string; status?: string; max_rows: number }) => {
    const tenants = await p.tenants(a.orgs);
    const asOf = a.to_date ?? c.cache.asOf();
    const dt = (iso: string) => { const [y, m, d] = iso.split("-"); return `DateTime(${y},${m},${d})`; };
    const where = [a.from_date && `Date>=${dt(a.from_date)}`, a.to_date && `Date<=${dt(a.to_date)}`].filter(Boolean).join("&&");
    const inRange = (d?: string) => !d || ((!a.from_date || d >= a.from_date) && (!a.to_date || d <= a.to_date));
    const results = await mapLimit(tenants, TENANT_FANOUT, async (t: Tenant) => {
      try {
        let rows: Record<string, unknown>[] = []; let columns: string[] | undefined;
        const list = async (res: string, key: string, q: Record<string, string> = {}) => (await pages(c.source, t.tenantId, res, key, { ...(where ? { where } : {}), ...q }, Math.ceil(a.max_rows / 100) + 1));
        switch (a.resource) {
          case "invoices": case "bills": {
            const typ = a.resource === "invoices" ? "ACCREC" : "ACCPAY";
            const q: Record<string, string> = { where: [where, `Type=="${typ}"`].filter(Boolean).join("&&") };
            if (a.status) q.Statuses = a.status;
            rows = (await pages(c.source, t.tenantId, "Invoices", "Invoices", q, Math.ceil(a.max_rows / 100) + 1)).filter((x) => x.Type === typ && (!a.status || a.status.split(",").includes(x.Status))).map((x) => compact(a.resource, x));
            break;
          }
          case "credit_notes": rows = (await list("CreditNotes", "CreditNotes")).map((x) => compact(a.resource, x)); break;
          case "bank_transactions": rows = (await list("BankTransactions", "BankTransactions")).map((x) => compact(a.resource, x)); break;
          case "payments": rows = (await list("Payments", "Payments")).map((x) => compact(a.resource, x)); break;
          case "manual_journals": rows = (await list("ManualJournals", "ManualJournals")).map((x) => compact(a.resource, x)); break;
          case "journals": rows = (((await c.source.get(t.tenantId, "Journals")).Journals as unknown[]) ?? []).map((x) => compact(a.resource, x)); break;
          case "contacts": rows = (await pages(c.source, t.tenantId, "Contacts", "Contacts", { summaryOnly: "true" })).map((x) => compact(a.resource, x)); break;
          case "accounts": rows = (((await c.source.get(t.tenantId, "Accounts")).Accounts as unknown[]) ?? []).map((x) => compact(a.resource, x)); break;
          case "tax_rates": rows = (((await c.source.get(t.tenantId, "TaxRates")).TaxRates as unknown[]) ?? []).map((x) => compact(a.resource, x)); break;
          case "profit_and_loss": case "balance_sheet": case "trial_balance": case "bank_summary": {
            const name = { profit_and_loss: "ProfitAndLoss", balance_sheet: "BalanceSheet", trial_balance: "TrialBalance", bank_summary: "BankSummary" }[a.resource];
            const q: Record<string, string> = a.resource === "profit_and_loss" || a.resource === "bank_summary" ? { fromDate: a.from_date ?? `${asOf.slice(0, 8)}01`, toDate: asOf } : { date: asOf };
            const f = flattenReport(await c.source.get(t.tenantId, `Reports/${name}`, q));
            rows = f.rows; columns = f.columns; break;
          }
          case "aged_receivables": case "aged_payables": {
            await c.cache.ensure(asOf);
            const o = c.cache.orgs.get(t.tenantId);
            if (!o) throw new Error("org not synced");
            const kind = a.resource === "aged_receivables" ? "receivable" : "payable";
            rows = o.invoices.filter((i) => i.kind === kind).map((i) => { const days = daysBetween(i.dueDate, o.asOf); return { number: i.number, contact: i.contact, due_date: i.dueDate, days_overdue: Math.max(0, days), bucket: bucketOf(days), amount_due: i.amountDue, currency: i.currency }; });
            break;
          }
        }
        if (["invoices", "bills", "credit_notes", "bank_transactions", "payments", "manual_journals", "journals"].includes(a.resource)) rows = rows.filter((r) => inRange(r.date as string | undefined));
        return { org: t.tenantName, tenant_id: t.tenantId, ok: true, count: rows.length, truncated: rows.length > a.max_rows, ...(columns ? { columns } : {}), rows: rows.slice(0, a.max_rows) };
      } catch (e) {
        return { org: t.tenantName, tenant_id: t.tenantId, ok: false, error: e instanceof Error ? e.message : String(e), count: 0, rows: [] };
      }
    });
    return { resource: a.resource, as_of: asOf, orgs: results };
  }));

  const scanInput = { orgs: orgsArg, as_of: asOfArg, stale_days: z.number().int().min(0).max(365).optional().describe("Unreconciled items older than this many days (default 7, or XERO_AGG_STALE_DAYS)."),
    checks: z.array(z.enum(CHECKS)).optional().describe(`Limit to these checks: ${CHECKS.join(", ")}`), min_severity: z.enum(["low", "medium", "high"]).optional(),
    attachment_threshold: z.number().min(0).optional().describe("Flag spends/bills at or above this amount with no attachment (default 500)."),
    variance_pct: z.number().min(1).optional().describe("Variance % vs 3-month average (default 50)."), variance_min_amount: z.number().min(0).optional().describe("Ignore variances smaller than this (default 1000)."),
    max_findings: z.number().int().min(1).max(1000).default(200) };
  type ScanArgs = { orgs?: string[]; as_of?: string; stale_days?: number; checks?: CheckName[]; min_severity?: Severity; attachment_threshold?: number; variance_pct?: number; variance_min_amount?: number; max_findings: number };

  server.registerTool("scan_issues", {
    title: "Scan client books for issues",
    description: "Data-quality / month-end exception scan across all (or named) client orgs: unreconciled bank lines and payments older than stale_days, possible duplicate invoices/bills/payments, missing tax codes, GST/VAT anomalies (income coded no-tax, tax amount not matching rate, unusual codes), spends/bills with no attachment, large P&L variances vs 3-month average, stale drafts and unposted journals, suspense/clearing balances, period lock date behind, overdrawn bank, very overdue bills and overdue tax liabilities. Every finding has org, tenant_id, severity, value_at_risk, a Xero deep link and a suggested fix. Read-only.",
    inputSchema: scanInput, annotations: RO,
  }, audited("scan_issues", async (a: ScanArgs) => {
    const r = await p.scan(c.cache.asOf(a.as_of), a.orgs, scanOpts(a));
    const all = r.orgs.flatMap((o) => o.findings);
    return { as_of: r.as_of, orgs_scanned: r.orgs.length, summary: summarise(all),
      per_org: r.orgs.map((o) => ({ org: o.org, tenant_id: o.tenant_id, ok: o.ok, error: o.error, data_gaps: gapsOf(o), ...summarise(o.findings) })),
      findings: all.sort((x, y) => (y.severity === "high" ? 3 : y.severity === "medium" ? 2 : 1) - (x.severity === "high" ? 3 : x.severity === "medium" ? 2 : 1) || y.value_at_risk - x.value_at_risk).slice(0, a.max_findings),
      truncated: all.length > a.max_findings,
      limitations: "Unreconciled = Xero bank transactions/payments with IsReconciled=false. Imported bank statement lines that have not been matched or coded at all are not exposed by Xero's public Accounting API, so the true reconcile backlog can be larger." };
  }));

  server.registerTool("unreconciled_items", {
    title: "Unreconciled items older than N days, all clients",
    description: "Answers 'which clients have unreconciled lines older than N days?' in one call: per org, the count and value of unreconciled bank transactions and invoice payments older than older_than_days, oldest first, with Xero links. Read-only.",
    inputSchema: { older_than_days: z.number().int().min(0).max(365).default(7), orgs: orgsArg, as_of: asOfArg }, annotations: RO,
  }, audited("unreconciled_items", async (a: { older_than_days: number; orgs?: string[]; as_of?: string }) => {
    const r = await p.scan(c.cache.asOf(a.as_of), a.orgs, { ...DEFAULT_SCAN, staleDays: a.older_than_days, checks: ["unreconciled_bank", "unreconciled_payment"] });
    const per = r.orgs.map((o) => ({ org: o.org, tenant_id: o.tenant_id, ok: o.ok, error: o.error, count: o.findings.length, value: round2(o.findings.reduce((s, f) => s + f.value_at_risk, 0)), currency: o.detail?.meta.currency,
      oldest: o.findings.map((f) => f.date).filter(Boolean).sort()[0] ?? null, items: o.findings.sort((x, y) => String(x.date).localeCompare(String(y.date))).map((f) => ({ date: f.date, detail: f.detail, amount: f.value_at_risk, link: f.xero_link })) }));
    return { as_of: r.as_of, older_than_days: a.older_than_days, clients_with_items: per.filter((x) => x.count).map((x) => x.org), orgs: per.sort((x, y) => y.count - x.count || y.value - x.value),
      limitations: "Based on IsReconciled=false bank transactions and payments; unmatched imported statement lines are not visible through the public API." };
  }));

  server.registerTool("tax_readiness", {
    title: "BAS / VAT / GST readiness across the practice",
    description: "For each org, readiness of the tax return for the period containing as_of (quarterly unless Xero says otherwise): status ready / needs review / not ready / not registered, blockers (missing tax codes, unreconciled bank lines in the period, suspense balances) and warnings (tax-code anomalies, duplicates, missing receipts, drafts in period), with value at risk and links. Does not file or calculate the return itself. Read-only.",
    inputSchema: { orgs: orgsArg, as_of: asOfArg, stale_days: z.number().int().min(0).max(365).optional() }, annotations: RO,
  }, audited("tax_readiness", async (a: { orgs?: string[]; as_of?: string; stale_days?: number }) => {
    const r = await p.scan(c.cache.asOf(a.as_of), a.orgs, scanOpts({ stale_days: a.stale_days ?? 0 }));
    const rows = r.orgs.map((o) => (o.ok && o.detail ? taxReadiness(o.detail, o.findings) : { org: o.org, tenant_id: o.tenant_id, status: "error", error: o.error }));
    const count = (s: string) => rows.filter((x) => x.status === s).map((x) => x.org);
    return { as_of: r.as_of, ready: count("ready"), needs_review: count("needs review"), not_ready: count("not ready"), not_registered: count("not registered"), orgs: rows };
  }));

  server.registerTool("close_readiness", {
    title: "Month-close readiness check",
    description: "Month-close checklist per org (bank and payments reconciled, no suspense, tax codes complete, no duplicates, no stale drafts, variances explained, receipts attached, tax liabilities paid, prior period locked) with a 0-100 readiness score, worst first. Read-only.",
    inputSchema: { orgs: orgsArg, as_of: asOfArg }, annotations: RO,
  }, audited("close_readiness", async (a: { orgs?: string[]; as_of?: string }) => {
    const r = await p.scan(c.cache.asOf(a.as_of), a.orgs, scanOpts({}));
    return { as_of: r.as_of, orgs: r.orgs.map((o) => (o.ok && o.detail ? { ...closeReadiness(o.detail, o.findings), data_gaps: gapsOf(o) } : { org: o.org, tenant_id: o.tenant_id, status: "error", error: o.error }))
      .sort((x, y) => ((x as { score?: number }).score ?? -1) - ((y as { score?: number }).score ?? -1)) };
  }));

  server.registerTool("month_end_summary", {
    title: "Month-end summary pack for one or many clients",
    description: "For each org: cash snapshot (bank balances), AR and AP aged snapshots, P&L latest month vs prior, a DRAFT variance commentary for the accountant to edit, the exception list (high/medium findings) and close readiness. export=true also writes one practice workbook (.xlsx: Summary + Exceptions sheets) to XERO_AGG_EXPORT_DIR. Re-run any time to refresh. Nothing is sent to clients or to Xero.",
    inputSchema: { orgs: orgsArg, as_of: asOfArg, export: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, audited("month_end_summary", async (a: { orgs?: string[]; as_of?: string; export: boolean }) => {
    const r = await p.scan(c.cache.asOf(a.as_of), a.orgs, scanOpts({}));
    const orgs = r.orgs.map((o) => {
      if (!o.ok || !o.snap || !o.detail) return { org: o.org, tenant_id: o.tenant_id, ok: false, error: o.error ?? "no data" };
      const s = o.snap; const [m0, m1] = closedMonths(s);
      return { org: o.org, tenant_id: o.tenant_id, ok: true, currency: s.currency,
        cash: { total: round2(s.bank.reduce((x, b) => x + b.closingBalance, 0)), accounts: s.bank.map((b) => ({ name: b.name, closing: b.closingBalance, unreconciled: b.unreconciledCount })) },
        receivables: arSnapshot(s), payables: apSnapshot(s),
        pnl: m0 ? { month: m0.label, income: m0.income, expenses: m0.expenses, net: m0.netProfit, prior_month: m1 ? { month: m1.label, income: m1.income, expenses: m1.expenses, net: m1.netProfit } : null } : null,
        commentary_draft: commentary(s, o.findings), exceptions: o.findings.filter((f) => f.severity !== "low").map(brief), close: closeReadiness(o.detail, o.findings) };
    });
    let file: string | undefined;
    if (a.export) {
      const wb = new ExcelJS.Workbook(); wb.creator = "clientbooks-hub-mcp";
      const sum = wb.addWorksheet("Summary");
      sum.addRow([`Practice month-end summary as at ${r.as_of}`]).font = { bold: true, size: 14 }; sum.addRow([]);
      sum.addRow(["Client", "Currency", "Cash", "AR total", "AR 90+", "AP total", "Income", "Expenses", "Net", "Close score", "High", "Medium", "Commentary (draft)"]).font = { bold: true };
      for (const o of orgs) if (o.ok && o.cash && o.receivables && o.payables && o.close && o.exceptions && o.commentary_draft) sum.addRow([o.org, o.currency, o.cash.total, o.receivables.total, o.receivables.buckets["90+"], o.payables.total, o.pnl?.income, o.pnl?.expenses, o.pnl?.net, o.close.score,
        o.exceptions.filter((x) => x.severity === "high").length, o.exceptions.filter((x) => x.severity === "medium").length, o.commentary_draft.join(" ")]);
      const ex = wb.addWorksheet("Exceptions");
      ex.addRow(["Client", "Severity", "Check", "Issue", "Detail", "Value at risk", "Currency", "Suggested fix", "Xero link"]).font = { bold: true };
      for (const o of r.orgs) for (const f of o.findings) ex.addRow([f.org, f.severity, f.check, f.title, f.detail, f.value_at_risk, f.currency, f.suggested_fix, f.xero_link ?? ""]);
      ex.columns.forEach((col, i) => (col.width = [26, 9, 20, 40, 50, 14, 9, 50, 40][i] ?? 14));
      await mkdir(c.cfg.exportDir, { recursive: true });
      file = path.join(c.cfg.exportDir, `practice-month-end-${slug(r.as_of)}.xlsx`);
      await wb.xlsx.writeFile(file);
    }
    return { as_of: r.as_of, orgs, ...(file ? { file } : {}), note: "Commentary is a DRAFT generated from the numbers: review and edit before sending to a client." };
  }));

  server.registerTool("practice_scan", {
    title: "Whole-book practice scan (nightly / month-close routine)",
    description: "One call for a routine: re-syncs every org, runs every check, and returns a ranked digest: clients by high-severity findings and value at risk, unreconciled >N days, BAS/VAT status and close-readiness score, plus the top findings. use_last=true returns the last scheduled/on-demand whole-book scan without calling Xero. Read-only.",
    inputSchema: { as_of: asOfArg, stale_days: z.number().int().min(0).max(365).optional(), use_last: z.boolean().default(false), top: z.number().int().min(1).max(100).default(15) },
    annotations: RO,
  }, audited("practice_scan", async (a: { as_of?: string; stale_days?: number; use_last: boolean; top: number }) => {
    let r = a.use_last ? p.lastScan : undefined;
    if (!r) {
      const asOf = c.cache.asOf(a.as_of);
      await c.cache.sync(asOf); p.invalidate();
      r = await p.scan(asOf, undefined, scanOpts({ stale_days: a.stale_days }));
    }
    const all = r.orgs.flatMap((o) => o.findings);
    const clients = r.orgs.map((o) => {
      const tax = o.detail ? taxReadiness(o.detail, o.findings) : undefined;
      const close = o.detail ? closeReadiness(o.detail, o.findings) : undefined;
      const unrec = o.findings.filter((f) => f.check === "unreconciled_bank" || f.check === "unreconciled_payment");
      return { org: o.org, tenant_id: o.tenant_id, ok: o.ok, error: o.error, high: o.findings.filter((f) => f.severity === "high").length, findings: o.findings.length,
        value_at_risk: round2(o.findings.reduce((s, f) => s + f.value_at_risk, 0)), currency: o.detail?.meta.currency, unreconciled_over_threshold: unrec.length,
        tax_return: tax ? `${tax.return_type}: ${tax.status}` : null, close_score: close?.score ?? null };
    }).sort((x, y) => y.high - x.high || y.value_at_risk - x.value_at_risk);
    return { as_of: r.as_of, ran_at: r.ran_at, trigger: r.trigger, clients, summary: summarise(all),
      top_findings: [...all].sort((x, y) => (y.severity === "high" ? 1 : 0) - (x.severity === "high" ? 1 : 0) || y.value_at_risk - x.value_at_risk).slice(0, a.top).map((f) => ({ org: f.org, ...brief(f) })) };
  }));

  // ---------- Safe write-back ----------
  server.registerTool("prepare_manual_journal", {
    title: "Prepare a DRAFT manual journal (step 1 of 2, nothing sent)",
    description: "Validates and stores a proposed manual journal for ONE org locally: lines must balance to zero (positive = debit, negative = credit), accounts must exist in that org's chart, the date must be after the lock date. Returns a preview, the proposal_id and an exact confirmation_phrase naming the org. NOTHING is sent to Xero. Show the preview to the user; only after they explicitly approve THIS journal for THIS org, call confirm_manual_journal with the phrase. Proposals expire after 30 minutes.",
    inputSchema: { org: z.string().min(1).max(120), date: isoDate, narration: z.string().min(3).max(500), reason: z.string().max(500).optional().describe("Why (e.g. the finding it fixes). Kept in the audit trail."),
      lines: z.array(z.object({ account_code: z.string().min(1).max(10), amount: z.number().refine((x) => x !== 0, "amount cannot be 0").describe("Positive = debit, negative = credit"),
        description: z.string().max(200).optional(), tax_type: z.string().regex(/^[A-Z0-9]+$/).optional() })).min(2).max(50) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, audited("prepare_manual_journal", async (a: { org: string; date: string; narration: string; reason?: string; lines: ProposalLine[] }) => {
    const [t] = await p.tenants([a.org]);
    const det = await p.detail(t, c.cache.asOf());
    const sum = round2(a.lines.reduce((s, l) => s + l.amount, 0));
    if (Math.abs(sum) > 0.004) throw new UserError(`Journal does not balance: debits minus credits = ${sum}. Adjust the lines so they total 0.`);
    if (det.accounts.length) {
      const codes = new Map(det.accounts.map((x) => [String(x.Code), x]));
      const bad = a.lines.filter((l) => !codes.has(l.account_code) || codes.get(l.account_code).Status === "ARCHIVED").map((l) => l.account_code);
      if (bad.length) throw new UserError(`Unknown or archived account code(s) in ${det.meta.name}: ${[...new Set(bad)].join(", ")}`);
      const banks = a.lines.filter((l) => codes.get(l.account_code)?.Type === "BANK").map((l) => l.account_code);
      if (banks.length) throw new UserError(`Manual journals cannot post to bank accounts (${banks.join(", ")}); use a bank transaction or transfer instead.`);
    }
    if (det.meta.lockDate && a.date <= det.meta.lockDate) throw new UserError(`${det.meta.name} is locked up to ${det.meta.lockDate}; the journal date must be later.`);
    const id = randomBytes(4).toString("hex");
    const prop: Proposal = { id, tenant_id: t.tenantId, org: det.meta.name, date: a.date, narration: a.narration, reason: a.reason, lines: a.lines, created_at: Date.now(), phrase: `POST DRAFT ${id} TO ${det.meta.name}`, used: false };
    p.proposals.set(id, prop);
    await c.audit.write({ event: "proposal_created", tool: "prepare_manual_journal", tenant_id: t.tenantId, org: det.meta.name, proposal_id: id, date: a.date, narration: a.narration, reason: a.reason, lines: a.lines });
    const total = round2(a.lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0));
    return { status: "prepared (not sent)", proposal_id: id, org: det.meta.name, tenant_id: t.tenantId, date: a.date, narration: a.narration, total_debits: total, currency: det.meta.currency,
      preview: a.lines.map((l) => ({ account: l.account_code, account_name: det.accounts.find((x) => String(x.Code) === l.account_code)?.Name, debit: l.amount > 0 ? l.amount : null, credit: l.amount < 0 ? -l.amount : null, description: l.description, tax_type: l.tax_type })),
      will_post_as: "DRAFT manual journal (not posted to the ledger until someone approves it inside Xero)",
      writes_enabled: c.cfg.writesEnabled, confirmation_phrase: prop.phrase, expires_in_minutes: PROPOSAL_TTL_MS / 60_000,
      next_step: c.cfg.writesEnabled ? "Show this to the user. Only if they explicitly approve this journal for this org, call confirm_manual_journal with proposal_id and confirmation_phrase." : "Write-back is disabled (read-only install). The user can enter this journal in Xero themselves, or enable XERO_AGG_ENABLE_WRITES=1 and reconnect to grant the manual-journals scope." };
  }));

  server.registerTool("confirm_manual_journal", {
    title: "Send a prepared journal to Xero as DRAFT (step 2 of 2)",
    description: "Creates the prepared manual journal in Xero with Status DRAFT for the org named in its proposal. Requires: the user's explicit approval of that specific journal and org in this conversation, the exact confirmation_phrase from prepare_manual_journal, XERO_AGG_ENABLE_WRITES=1, and a connection granted the manual-journals scope. Never call this on your own initiative. Single use; refused attempts are logged.",
    inputSchema: { proposal_id: z.string().regex(/^[a-f0-9]{8}$/), confirmation_phrase: z.string().min(10).max(300) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, audited("confirm_manual_journal", async (a: { proposal_id: string; confirmation_phrase: string }) => {
    const prop = p.proposals.get(a.proposal_id);
    const refuse = async (why: string) => { await c.audit.write({ event: "confirm_refused", tool: "confirm_manual_journal", proposal_id: a.proposal_id, tenant_id: prop?.tenant_id, org: prop?.org, reason: why }); throw new UserError(why); };
    if (!prop) return refuse("Unknown proposal_id (proposals live in memory for 30 minutes; prepare it again).");
    if (prop.used) return refuse("This proposal was already used.");
    if (Date.now() - prop.created_at > PROPOSAL_TTL_MS) return refuse("Proposal expired; prepare it again and re-confirm with the user.");
    if (a.confirmation_phrase.trim().toLowerCase() !== prop.phrase.toLowerCase()) return refuse(`Confirmation phrase does not match. It must be exactly: ${prop.phrase}`);
    if (!c.cfg.writesEnabled) return refuse("Write-back is disabled. Set XERO_AGG_ENABLE_WRITES=1 and reconnect the org so it grants the manual-journals scope.");
    const body = { ManualJournals: [{ Narration: prop.narration, Date: prop.date, Status: "DRAFT", LineAmountTypes: prop.lines.some((l) => l.tax_type) ? "Exclusive" : "NoTax",
      JournalLines: prop.lines.map((l) => ({ LineAmount: l.amount, AccountCode: l.account_code, Description: l.description ?? prop.narration, ...(l.tax_type ? { TaxType: l.tax_type } : {}) })) }] };
    if (c.cfg.demo || !c.source.post) {
      prop.used = true;
      await c.audit.write({ event: "journal_draft_simulated", tool: "confirm_manual_journal", tenant_id: prop.tenant_id, org: prop.org, proposal_id: prop.id, body });
      return { status: "simulated (demo mode: nothing sent)", org: prop.org, tenant_id: prop.tenant_id, would_send: body };
    }
    const scopes = await c.oauth.scopesFor(prop.tenant_id);
    if (!scopes.includes(WRITE_SCOPE_GRANULAR) && !scopes.includes(WRITE_SCOPE_BROAD)) return refuse(`${prop.org}'s connection was granted read-only scopes. Reconnect it (connect_org_start) with XERO_AGG_ENABLE_WRITES=1 to grant ${WRITE_SCOPE_GRANULAR}.`);
    prop.used = true;
    const res = await c.source.post(prop.tenant_id, "ManualJournals", body);
    const mj = ((res.ManualJournals as Record<string, unknown>[]) ?? [])[0] ?? {};
    const det = await p.detail({ tenantId: prop.tenant_id, tenantName: prop.org }, c.cache.asOf());
    await c.audit.write({ event: "journal_draft_created", tool: "confirm_manual_journal", tenant_id: prop.tenant_id, org: prop.org, proposal_id: prop.id, manual_journal_id: mj.ManualJournalID, xero_status: mj.Status });
    return { status: mj.Status === "DRAFT" ? "created in Xero as DRAFT" : `created with unexpected status ${String(mj.Status)}`, org: prop.org, tenant_id: prop.tenant_id, manual_journal_id: mj.ManualJournalID,
      xero_link: mj.ManualJournalID ? deepLink(det.meta, "manual_journal", String(mj.ManualJournalID)) : undefined, next_step: "Review and post it inside Xero (Accounting > Manual journals > Draft)." };
  }));

  server.registerTool("list_proposals", {
    title: "List prepared write-back proposals",
    description: "Lists manual-journal proposals prepared in this session (org, date, narration, status: pending / expired / used). In memory only.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, safe(async () => ({ writes_enabled: c.cfg.writesEnabled, proposals: [...p.proposals.values()].map((x) => ({ proposal_id: x.id, org: x.org, tenant_id: x.tenant_id, date: x.date, narration: x.narration,
    total_debits: round2(x.lines.filter((l) => l.amount > 0).reduce((s, l) => s + num(l.amount), 0)), status: x.used ? "used" : Date.now() - x.created_at > PROPOSAL_TTL_MS ? "expired" : "pending" })) })));

  server.registerTool("audit_trail", {
    title: "Audit trail of reads and proposals",
    description: "Shows the local audit log (newest first): which Xero endpoints were read for which org by which tool (call counts only, no figures), every journal proposal, confirmation, refusal and Xero write, and scheduled scans. File: XERO_AGG_AUDIT_FILE (default ~/.xero-aggregator/audit.jsonl).",
    inputSchema: { org: z.string().max(120).optional(), event: z.enum(["read", "proposal_created", "confirm_refused", "journal_draft_created", "journal_draft_simulated", "scheduled_scan"]).optional(), limit: z.number().int().min(1).max(500).default(50) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, safe(async (a: { org?: string; event?: string; limit: number }) => {
    const tenant = a.org ? (await p.tenants([a.org]))[0] : undefined;
    let rows = await c.audit.read({ event: a.event, limit: 5000 });
    if (tenant) rows = rows.filter((r) => r.tenant_id === tenant.tenantId || (Array.isArray(r.reads) && (r.reads as { tenant_id: string }[]).some((x) => x.tenant_id === tenant.tenantId)));
    return { file: c.audit.file, entries: rows.slice(0, a.limit) };
  }));
}
