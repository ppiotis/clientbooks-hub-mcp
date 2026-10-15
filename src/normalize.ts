/** Normalizes Xero Accounting API payloads into one cross-org model. Pure functions, unit tested. */

export interface Invoice {
  orgId: string; id: string; number: string; kind: "receivable" | "payable"; contact: string;
  date: string; dueDate: string; total: number; amountDue: number; currency: string;
}
export interface BankAccount { id: string; name: string; closingBalance: number; unreconciledCount: number; unreconciledAmount: number }
export interface PnlMonth { label: string; income: number; expenses: number; netProfit: number; payroll: number; lines: { section: string; name: string; amount: number }[] }
export interface OrgSnapshot {
  orgId: string; name: string; currency: string; syncedAt: string; asOf: string;
  invoices: Invoice[]; contacts: number; bank: BankAccount[];
  pnl: PnlMonth[]; // newest first
  directorLoans: { name: string; balances: number[] }[]; // newest first
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export { round2 };

/** Xero dates come as "2026-09-20T00:00:00" (DateString) or "/Date(1789862400000+0000)/". */
export function xeroDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const ms = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(v);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return undefined;
}

export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || v.trim() === "") return 0;
  const n = Number(v.replace(/,/g, "").replace(/^\((.*)\)$/, "-$1"));
  return Number.isFinite(n) ? n : 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type X = any;

/** Only AUTHORISED invoices/bills with something still owing are outstanding. */
export function normalizeInvoices(orgId: string, payload: X, baseCurrency: string): Invoice[] {
  const list: X[] = Array.isArray(payload?.Invoices) ? payload.Invoices : [];
  return list
    .filter((i) => i.Status === "AUTHORISED" && num(i.AmountDue) > 0 && (i.Type === "ACCREC" || i.Type === "ACCPAY"))
    .map((i) => ({
      orgId, id: String(i.InvoiceID), number: String(i.InvoiceNumber ?? i.Reference ?? i.InvoiceID),
      kind: i.Type === "ACCREC" ? "receivable" : "payable", contact: String(i.Contact?.Name ?? "Unknown"),
      date: xeroDate(i.DateString) ?? xeroDate(i.Date) ?? "", dueDate: xeroDate(i.DueDateString) ?? xeroDate(i.DueDate) ?? "",
      total: round2(num(i.Total)), amountDue: round2(num(i.AmountDue)), currency: String(i.CurrencyCode ?? baseCurrency),
    }));
}

interface Row { RowType: string; Title?: string; Cells?: { Value?: string }[]; Rows?: Row[] }
function report(payload: X): { header: string[]; rows: Row[] } {
  const r = payload?.Reports?.[0];
  if (!r) throw new Error("Report payload missing Reports[0]");
  const rows: Row[] = r.Rows ?? [];
  const header = (rows.find((x) => x.RowType === "Header")?.Cells ?? []).map((c) => String(c.Value ?? ""));
  return { header, rows };
}

export function normalizeBankSummary(payload: X): { id: string; name: string; closingBalance: number }[] {
  const { header, rows } = report(payload);
  const idx = header.findIndex((h) => /closing balance/i.test(h));
  const col = idx >= 0 ? idx : header.length - 1;
  const out: { id: string; name: string; closingBalance: number }[] = [];
  for (const s of rows.filter((x) => x.RowType === "Section")) {
    for (const row of s.Rows ?? []) {
      if (row.RowType !== "Row" || !row.Cells) continue;
      const c0 = row.Cells[0] as { Value?: string; Attributes?: { Id: string; Value: string }[] };
      out.push({ id: c0.Attributes?.find((a) => a.Id === "account")?.Value ?? String(c0.Value), name: String(c0.Value), closingBalance: round2(num(row.Cells[col]?.Value)) });
    }
  }
  return out;
}

export function normalizeUnreconciled(payload: X): Map<string, { count: number; amount: number }> {
  const list: X[] = Array.isArray(payload?.BankTransactions) ? payload.BankTransactions : [];
  const m = new Map<string, { count: number; amount: number }>();
  for (const t of list) {
    if (t.IsReconciled !== false || t.Status === "DELETED" || t.Status === "VOIDED") continue;
    const id = String(t.BankAccount?.AccountID ?? "unknown");
    const cur = m.get(id) ?? { count: 0, amount: 0 };
    cur.count += 1;
    cur.amount = round2(cur.amount + Math.abs(num(t.Total)));
    m.set(id, cur);
  }
  return m;
}

const INCOME = /^(income|revenue|trading income|sales)$/i;
const EXPENSE = /(cost of sales|expenses|overheads)/i;
const PAYROLL = /(wages|salar|payroll|paye|superannuation|pension|kiwisaver|national insurance)/i;

export function normalizePnl(payload: X): PnlMonth[] {
  const { header, rows } = report(payload);
  const labels = header.slice(1);
  const months: PnlMonth[] = labels.map((label) => ({ label, income: 0, expenses: 0, netProfit: 0, payroll: 0, lines: [] }));
  for (const s of rows.filter((x) => x.RowType === "Section")) {
    const title = String(s.Title ?? "").replace(/^less\s+/i, "");
    const isIncome = INCOME.test(title);
    const isExpense = !isIncome && EXPENSE.test(title);
    if (!isIncome && !isExpense) continue;
    for (const row of s.Rows ?? []) {
      if (row.RowType !== "Row" || !row.Cells) continue;
      const name = String(row.Cells[0]?.Value ?? "");
      labels.forEach((_, i) => {
        const v = num(row.Cells![i + 1]?.Value);
        const m = months[i];
        m.lines.push({ section: isIncome ? "Income" : title, name, amount: round2(v) });
        if (isIncome) m.income += v;
        else {
          m.expenses += v;
          if (PAYROLL.test(name)) m.payroll += v;
        }
      });
    }
  }
  for (const m of months) {
    m.income = round2(m.income);
    m.expenses = round2(m.expenses);
    m.payroll = round2(m.payroll);
    m.netProfit = round2(m.income - m.expenses);
  }
  return months;
}

const DIRECTOR_LOAN = /director/i;
const LOAN = /(loan|current account)/i;

export function normalizeDirectorLoans(payload: X): { name: string; balances: number[] }[] {
  const { rows } = report(payload);
  const out: { name: string; balances: number[] }[] = [];
  const walk = (list: Row[]) => {
    for (const row of list) {
      if (row.Rows) walk(row.Rows);
      if (row.RowType !== "Row" || !row.Cells) continue;
      const name = String(row.Cells[0]?.Value ?? "");
      if (DIRECTOR_LOAN.test(name) && LOAN.test(name)) out.push({ name, balances: row.Cells.slice(1).map((c) => round2(num(c.Value))) });
    }
  };
  walk(rows);
  return out;
}
