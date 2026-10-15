/** Raw-ish data pulls used by pull_data and the issue scanner. Every list is tagged with its org. */
import type { XeroSource } from "./source.js";
import { num, round2, xeroDate } from "./normalize.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type X = any;

export const RESOURCES = ["invoices", "bills", "credit_notes", "bank_transactions", "payments", "manual_journals", "journals", "contacts", "accounts", "tax_rates",
  "profit_and_loss", "balance_sheet", "trial_balance", "bank_summary", "aged_receivables", "aged_payables"] as const;
export type ResourceName = (typeof RESOURCES)[number];

const xdt = (iso: string) => { const [y, m, d] = iso.split("-"); return `DateTime(${y},${m},${d})`; };

export async function pages(src: XeroSource, tenantId: string, resource: string, key: string, query: Record<string, string>, maxPages = 20): Promise<X[]> {
  const out: X[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await src.get(tenantId, resource, { ...query, page: String(page) });
    const list = (data[key] as X[]) ?? [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

export interface OrgMeta { name: string; currency: string; country: string; shortCode?: string; taxNumber?: string; taxBasis?: string; taxPeriod?: string; lockDate?: string; endOfYearLockDate?: string }
export function orgMeta(payload: X, fallback: string): OrgMeta {
  const o = payload?.Organisations?.[0] ?? {};
  return { name: String(o.Name ?? fallback), currency: String(o.BaseCurrency ?? ""), country: String(o.CountryCode ?? ""), shortCode: o.ShortCode || undefined,
    taxNumber: o.TaxNumber || undefined, taxBasis: o.SalesTaxBasis || undefined, taxPeriod: o.SalesTaxPeriod || undefined,
    lockDate: xeroDate(o.PeriodLockDate), endOfYearLockDate: xeroDate(o.EndOfYearLockDate) };
}

/** Xero web-app links. The organisationlogin hop selects the right org via its ShortCode. */
export function deepLink(meta: OrgMeta, kind: "invoice" | "bill" | "bank_transaction" | "manual_journal" | "bank_account" | "payment" | "account" | "settings", id: string): string {
  const paths: Record<typeof kind, string> = {
    invoice: `/AccountsReceivable/View.aspx?InvoiceID=${id}`, bill: `/AccountsPayable/View.aspx?InvoiceID=${id}`,
    bank_transaction: `/Bank/ViewTransaction.aspx?bankTransactionID=${id}`, manual_journal: `/Journal/View.aspx?invoiceID=${id}`,
    bank_account: `/Bank/BankRec.aspx?accountID=${id}`, payment: `/Accounts/Payment/${id}`, account: `/GeneralLedger/AccountTransactions.aspx?accountID=${id}`, settings: "/Setup/FinancialSettings.aspx",
  };
  const p = paths[kind];
  return meta.shortCode ? `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(meta.shortCode)}&redirecturl=${encodeURIComponent(p)}` : `https://go.xero.com${p}`;
}

/** Everything the scanner needs for one org. Missing scopes/tier limits become `gaps`, not failures. */
export interface OrgDetail {
  tenantId: string; meta: OrgMeta; asOf: string; from: string;
  invoices: X[]; bankTx: X[]; payments: X[]; accounts: X[]; taxRates: X[]; manualJournals: X[]; trialBalance?: X;
  gaps: { resource: string; reason: string }[];
}

export async function pullDetail(src: XeroSource, tenantId: string, asOf: string, lookbackDays = 120): Promise<OrgDetail> {
  const from = new Date(Date.parse(asOf + "T00:00:00Z") - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const meta = orgMeta(await src.get(tenantId, "Organisation"), tenantId);
  const gaps: OrgDetail["gaps"] = [];
  const soft = async <T>(resource: string, fn: () => Promise<T>, empty: T): Promise<T> => {
    try { return await fn(); } catch (e) { gaps.push({ resource, reason: e instanceof Error ? e.message : String(e) }); return empty; }
  };
  const dateWhere = `Date>=${xdt(from)}&&Date<=${xdt(asOf)}`;
  const invoices = await soft("Invoices", () => pages(src, tenantId, "Invoices", "Invoices", { where: dateWhere, Statuses: "DRAFT,SUBMITTED,AUTHORISED,PAID" }), []);
  const bankTx = await soft("BankTransactions", () => pages(src, tenantId, "BankTransactions", "BankTransactions", { where: dateWhere }), []);
  const payments = await soft("Payments", () => pages(src, tenantId, "Payments", "Payments", { where: dateWhere }), []);
  const accounts = await soft("Accounts", async () => ((await src.get(tenantId, "Accounts")).Accounts as X[]) ?? [], []);
  const taxRates = await soft("TaxRates", async () => ((await src.get(tenantId, "TaxRates")).TaxRates as X[]) ?? [], []);
  const manualJournals = await soft("ManualJournals", () => pages(src, tenantId, "ManualJournals", "ManualJournals", { where: dateWhere }), []);
  const trialBalance = await soft("Reports/TrialBalance", () => src.get(tenantId, "Reports/TrialBalance", { date: asOf }), undefined as X);
  return { tenantId, meta, asOf, from, invoices, bankTx, payments, accounts, taxRates, manualJournals, trialBalance, gaps };
}

/** Flattens any Xero report into rows of { section, account, account_id, values[] } plus its column headers. */
export function flattenReport(payload: X): { title: string; columns: string[]; rows: { section: string; account: string; account_id?: string; values: (number | string)[]; summary?: boolean }[] } {
  const r = payload?.Reports?.[0];
  if (!r) return { title: "", columns: [], rows: [] };
  const header = (r.Rows ?? []).find((x: X) => x.RowType === "Header");
  const columns = (header?.Cells ?? []).map((c: X) => String(c.Value ?? ""));
  const rows: ReturnType<typeof flattenReport>["rows"] = [];
  const walk = (list: X[], section: string) => {
    for (const row of list ?? []) {
      if (row.Rows) walk(row.Rows, row.Title || section);
      if ((row.RowType !== "Row" && row.RowType !== "SummaryRow") || !row.Cells) continue;
      const c0 = row.Cells[0] ?? {};
      rows.push({ section, account: String(c0.Value ?? ""), account_id: c0.Attributes?.find((a: X) => /^account(id)?$/i.test(a.Id))?.Value,
        values: row.Cells.slice(1).map((c: X) => { const v = String(c.Value ?? ""); return /^-?[\d,]+(\.\d+)?$/.test(v) ? num(v) : v; }), ...(row.RowType === "SummaryRow" ? { summary: true } : {}) });
    }
  };
  walk(r.Rows ?? [], "");
  return { title: String(r.ReportName ?? r.ReportID ?? ""), columns, rows };
}

/** Compact, consistent row shapes for pull_data (Xero payloads are huge). */
export function compact(resource: ResourceName, x: X): Record<string, unknown> {
  switch (resource) {
    case "invoices": case "bills": case "credit_notes":
      return { id: x.InvoiceID ?? x.CreditNoteID, number: x.InvoiceNumber ?? x.CreditNoteNumber, type: x.Type, status: x.Status, contact: x.Contact?.Name, date: xeroDate(x.DateString) ?? xeroDate(x.Date),
        due_date: xeroDate(x.DueDateString) ?? xeroDate(x.DueDate), total: round2(num(x.Total)), amount_due: round2(num(x.AmountDue ?? x.RemainingCredit)), tax: round2(num(x.TotalTax)), currency: x.CurrencyCode, reference: x.Reference || undefined, has_attachments: x.HasAttachments };
    case "bank_transactions":
      return { id: x.BankTransactionID, type: x.Type, status: x.Status, date: xeroDate(x.DateString) ?? xeroDate(x.Date), contact: x.Contact?.Name, bank_account: x.BankAccount?.Name,
        total: round2(num(x.Total)), reconciled: x.IsReconciled, reference: x.Reference || undefined, has_attachments: x.HasAttachments, currency: x.CurrencyCode };
    case "payments":
      return { id: x.PaymentID, date: xeroDate(x.DateString) ?? xeroDate(x.Date), amount: round2(num(x.Amount)), invoice: x.Invoice?.InvoiceNumber, contact: x.Invoice?.Contact?.Name, reconciled: x.IsReconciled, status: x.Status, type: x.PaymentType };
    case "manual_journals":
      return { id: x.ManualJournalID, date: xeroDate(x.DateString) ?? xeroDate(x.Date), status: x.Status, narration: x.Narration, lines: (x.JournalLines ?? []).map((l: X) => ({ account: l.AccountCode, amount: round2(num(l.LineAmount)), description: l.Description })) };
    case "journals":
      return { id: x.JournalID, number: x.JournalNumber, date: xeroDate(x.JournalDate), source: x.SourceType, lines: (x.JournalLines ?? []).map((l: X) => ({ account: l.AccountCode, net: round2(num(l.NetAmount)), tax: round2(num(l.TaxAmount)) })) };
    case "contacts":
      return { id: x.ContactID, name: x.Name, status: x.ContactStatus, customer: x.IsCustomer, supplier: x.IsSupplier, email: x.EmailAddress || undefined, tax_number: x.TaxNumber || undefined };
    case "accounts":
      return { id: x.AccountID, code: x.Code, name: x.Name, type: x.Type, class: x.Class, tax_type: x.TaxType, status: x.Status };
    case "tax_rates":
      return { name: x.Name, tax_type: x.TaxType, rate: x.EffectiveRate, status: x.Status };
    default:
      return x;
  }
}
