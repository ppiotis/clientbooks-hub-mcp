import ExcelJS from "exceljs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { agedReceivables, BUCKETS } from "./analytics.js";
import { round2 } from "./normalize.js";
export const SHEETS = ["Aged Receivables", "Bank Reconciliation", "P&L Snapshot"];
const MONEY = '#,##0.00;[Red]-#,##0.00';
export function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "client"; }
/** Builds the 3-sheet month-end pack. Returns the workbook plus the totals written, for verification. */
export function buildPack(o) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "clientbooks-hub-mcp";
    wb.created = new Date(o.asOf + "T00:00:00Z");
    const title = (ws, t) => {
        ws.addRow([`${o.name}: ${t}`]).font = { bold: true, size: 14 };
        ws.addRow([`As at ${o.asOf} (${o.currency}). Source: Xero, synced ${o.syncedAt}`]);
        ws.addRow([]);
    };
    // 1. Aged receivables
    const aged = agedReceivables(o);
    const ar = wb.addWorksheet(SHEETS[0]);
    title(ar, "Aged Receivables");
    const hdr = ar.addRow(["Contact", "Invoice", "Invoice date", "Due date", "Days overdue", "Current", "1-30", "31-60", "61-90", "90+", "Amount due"]);
    hdr.font = { bold: true };
    for (const r of aged.rows)
        ar.addRow([r.contact, r.number, r.date, r.dueDate, r.daysOverdue, ...BUCKETS.map((b) => (r.bucket === b ? r.amountDue : null)), r.amountDue]);
    const tot = ar.addRow(["Total", "", "", "", "", ...BUCKETS.map((b) => aged.totals[b]), aged.total]);
    tot.font = { bold: true };
    for (let c = 6; c <= 11; c++)
        ar.getColumn(c).numFmt = MONEY;
    ar.columns.forEach((col, i) => (col.width = i === 0 ? 26 : 13));
    // 2. Bank reconciliation status
    const br = wb.addWorksheet(SHEETS[1]);
    title(br, "Bank Reconciliation Status");
    br.addRow(["Bank account", "Closing balance (Xero)", "Unreconciled items", "Unreconciled amount", "Status"]).font = { bold: true };
    for (const b of o.bank)
        br.addRow([b.name, b.closingBalance, b.unreconciledCount, b.unreconciledAmount, b.unreconciledCount ? "Needs reconciling" : "Reconciled"]);
    const bankTotals = { closing: round2(o.bank.reduce((a, b) => a + b.closingBalance, 0)), count: o.bank.reduce((a, b) => a + b.unreconciledCount, 0), amount: round2(o.bank.reduce((a, b) => a + b.unreconciledAmount, 0)) };
    br.addRow(["Total", bankTotals.closing, bankTotals.count, bankTotals.amount, ""]).font = { bold: true };
    br.addRow([]);
    br.addRow(["Unreconciled = Xero bank transactions with IsReconciled=false (amounts are absolute). Bank statement lines not yet imported or matched are not exposed by the Xero API."]);
    br.getColumn(2).numFmt = MONEY;
    br.getColumn(4).numFmt = MONEY;
    br.columns.forEach((col, i) => (col.width = i === 0 ? 28 : 20));
    // 3. P&L snapshot: latest month + period total
    const pl = wb.addWorksheet(SHEETS[2]);
    title(pl, "Profit & Loss Snapshot");
    const latest = o.pnl[0];
    const periodLabel = `${o.pnl.length} months to ${latest?.label ?? ""}`;
    pl.addRow(["Line", "Section", latest?.label ?? "Latest", periodLabel]).font = { bold: true };
    const names = latest ? latest.lines.map((l) => [l.section, l.name]) : [];
    for (const [section, name] of names) {
        const total = round2(o.pnl.reduce((a, m) => a + (m.lines.find((l) => l.section === section && l.name === name)?.amount ?? 0), 0));
        pl.addRow([name, section, latest.lines.find((l) => l.section === section && l.name === name).amount, total]);
    }
    const pnlTotals = {
        latest: { income: latest?.income ?? 0, expenses: latest?.expenses ?? 0, net: latest?.netProfit ?? 0 },
        period: { income: round2(o.pnl.reduce((a, m) => a + m.income, 0)), expenses: round2(o.pnl.reduce((a, m) => a + m.expenses, 0)), net: round2(o.pnl.reduce((a, m) => a + m.netProfit, 0)) },
    };
    pl.addRow([]);
    pl.addRow(["Total income", "", pnlTotals.latest.income, pnlTotals.period.income]).font = { bold: true };
    pl.addRow(["Total expenses", "", pnlTotals.latest.expenses, pnlTotals.period.expenses]).font = { bold: true };
    pl.addRow(["Net profit", "", pnlTotals.latest.net, pnlTotals.period.net]).font = { bold: true };
    pl.getColumn(3).numFmt = MONEY;
    pl.getColumn(4).numFmt = MONEY;
    pl.columns.forEach((col, i) => (col.width = i < 2 ? 26 : 18));
    return { wb, summary: { aged_receivables: { rows: aged.rows.length, totals: aged.totals, total: aged.total }, bank_reconciliation: { accounts: o.bank.length, ...bankTotals }, pnl: pnlTotals } };
}
export async function writePack(o, exportDir) {
    const { wb, summary } = buildPack(o);
    await mkdir(exportDir, { recursive: true });
    const file = path.join(exportDir, `${slug(o.name)}-month-end-${o.asOf}.xlsx`);
    if (path.dirname(file) !== path.resolve(exportDir))
        throw new Error("Refusing to write outside the export directory");
    await wb.xlsx.writeFile(file);
    return { file, sheets: [...SHEETS], summary };
}
