// Generates the two demo-org fixtures in Xero Accounting API response shape.
// Synthetic data (not real businesses). Re-run with: node fixtures/generate.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const msDate = (iso) => `/Date(${Date.parse(iso + "T00:00:00Z")}+0000)/`;
const months = ["Sep 26", "Aug 26", "Jul 26", "Jun 26", "May 26", "Apr 26"]; // newest first, like Xero
let seq = 0;
const uid = (p) => `${p}0000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function invoice(type, number, contact, date, due, total, amountDue, status = "AUTHORISED") {
  return { Type: type, InvoiceID: uid("1"), InvoiceNumber: number, Reference: "", Status: status,
    Contact: { ContactID: contact.ContactID, Name: contact.Name }, Date: msDate(date), DateString: `${date}T00:00:00`,
    DueDate: msDate(due), DueDateString: `${due}T00:00:00`, CurrencyCode: "GBP", Total: total,
    AmountPaid: +(total - amountDue).toFixed(2), AmountDue: amountDue };
}
const cell = (v, account) => (account ? { Value: v, Attributes: [{ Value: account, Id: "account" }] } : { Value: v });
const fmt = (n) => n.toFixed(2);
function plReport(title, income, expenseLines) {
  const header = { RowType: "Header", Cells: [cell(""), ...months.map((m) => cell(m))] };
  const incomeRows = [{ RowType: "Row", Cells: [cell("Sales", uid("a")), ...income.map((n) => cell(fmt(n)))] }];
  const expRows = Object.entries(expenseLines).map(([name, vals]) => ({ RowType: "Row", Cells: [cell(name, uid("a")), ...vals.map((n) => cell(fmt(n)))] }));
  const expTotals = months.map((_, i) => Object.values(expenseLines).reduce((s, v) => s + v[i], 0));
  return { Reports: [{ ReportID: "ProfitAndLoss", ReportName: "Profit and Loss", ReportType: "ProfitAndLoss", ReportTitles: ["Profit & Loss", title, "1 April 2026 to 30 September 2026"], ReportDate: "30 September 2026",
    Rows: [header,
      { RowType: "Section", Title: "Income", Rows: [...incomeRows, { RowType: "SummaryRow", Cells: [cell("Total Income"), ...income.map((n) => cell(fmt(n)))] }] },
      { RowType: "Section", Title: "Less Operating Expenses", Rows: [...expRows, { RowType: "SummaryRow", Cells: [cell("Total Operating Expenses"), ...expTotals.map((n) => cell(fmt(n)))] }] },
      { RowType: "Section", Title: "", Rows: [{ RowType: "Row", Cells: [cell("Net Profit"), ...income.map((n, i) => cell(fmt(n - expTotals[i])))] }] }] }] };
}
function bsReport(title, sections) {
  const header = { RowType: "Header", Cells: [cell(""), ...months.map((m) => cell(m))] };
  return { Reports: [{ ReportID: "BalanceSheet", ReportName: "Balance Sheet", ReportType: "BalanceSheet", ReportTitles: ["Balance Sheet", title, "As at 30 September 2026"], ReportDate: "30 September 2026",
    Rows: [header, ...Object.entries(sections).map(([t, rows]) => ({ RowType: "Section", Title: t, Rows: Object.entries(rows).map(([name, vals]) => ({ RowType: "Row", Cells: [cell(name, uid("a")), ...vals.map((n) => cell(fmt(n)))] })) }))] }] };
}
function bankSummary(title, accounts) {
  return { Reports: [{ ReportID: "BankSummary", ReportName: "Bank Summary", ReportType: "BankSummary", ReportTitles: ["Bank Summary", title, "1 September 2026 to 30 September 2026"], ReportDate: "30 September 2026",
    Rows: [{ RowType: "Header", Cells: ["Bank Accounts", "Opening Balance", "Cash Received", "Cash Spent", "Closing Balance"].map((v) => cell(v)) },
      { RowType: "Section", Title: "", Rows: [...accounts.map((a) => ({ RowType: "Row", Cells: [cell(a.name, a.id), cell(fmt(a.open)), cell(fmt(a.in)), cell(fmt(a.out)), cell(fmt(a.close))] })),
        { RowType: "SummaryRow", Cells: [cell("Total"), cell(fmt(accounts.reduce((s, a) => s + a.open, 0))), cell(fmt(accounts.reduce((s, a) => s + a.in, 0))), cell(fmt(accounts.reduce((s, a) => s + a.out, 0))), cell(fmt(accounts.reduce((s, a) => s + a.close, 0)))] }] }] }] };
}
function bankTx(account, amounts, reconciled) {
  return amounts.map((t, i) => ({ BankTransactionID: uid("b"), Type: i % 2 ? "RECEIVE" : "SPEND", Status: "AUTHORISED", IsReconciled: reconciled,
    Date: msDate(`2026-09-${String(3 + i * 3).padStart(2, "0")}`), DateString: `2026-09-${String(3 + i * 3).padStart(2, "0")}T00:00:00`, Total: t, CurrencyCode: "GBP",
    BankAccount: { AccountID: account.id, Name: account.name } }));
}
function contact(name, customer = true) { return { ContactID: uid("c"), Name: name, ContactStatus: "ACTIVE", IsCustomer: customer, IsSupplier: !customer }; }

function write(tenant, name, data) {
  const p = join(root, tenant, `${name}.json`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

// ---------- Org A: Harbour Bakery Ltd (healthy) ----------
{
  const t = "harbour-bakery";
  const c = { lumen: contact("Café Lumen"), grand: contact("Grand Hotel"), deli: contact("Corner Deli"), sea: contact("Seaside Events"),
    flour: contact("Flour Mills Ltd", false), pack: contact("Packaging Co", false), hmrc: contact("HMRC", false) };
  write(t, "Organisation", { Organisations: [{ OrganisationID: "a1a1a1a1-0000-4000-8000-000000000001", Name: "Harbour Bakery Ltd", LegalName: "Harbour Bakery Ltd", BaseCurrency: "GBP", CountryCode: "GB", ShortCode: "!HBAK1" }] });
  write(t, "Contacts", { Contacts: Object.values(c) });
  write(t, "Invoices", { Invoices: [
    invoice("ACCREC", "INV-A001", c.lumen, "2026-08-21", "2026-09-20", 1200, 1200),
    invoice("ACCREC", "INV-A002", c.grand, "2026-07-26", "2026-08-25", 2450, 2450),
    invoice("ACCREC", "INV-A003", c.deli, "2026-06-15", "2026-07-15", 860, 860),
    invoice("ACCREC", "INV-A004", c.sea, "2026-09-15", "2026-10-15", 3100, 3100),
    invoice("ACCREC", "INV-A005", c.grand, "2026-08-29", "2026-09-28", 540, 540),
    invoice("ACCREC", "INV-A006", c.lumen, "2026-09-29", "2026-10-29", 700, 700, "DRAFT"),
    invoice("ACCREC", "INV-A007", c.deli, "2026-05-01", "2026-05-31", 300, 0, "PAID"),
    invoice("ACCPAY", "FM-8812", c.flour, "2026-09-10", "2026-10-10", 1850, 1850),
    invoice("ACCPAY", "PK-0441", c.pack, "2026-09-28", "2026-10-28", 420, 420),
    invoice("ACCPAY", "VAT-Q3", c.hmrc, "2026-09-30", "2026-10-07", 2300, 2300),
  ] });
  const cur = { id: "aaaa0001-0000-4000-8000-000000000001", name: "Business Current Account" };
  const sav = { id: "aaaa0002-0000-4000-8000-000000000002", name: "Business Savings" };
  write(t, "BankSummary", bankSummary("Harbour Bakery Ltd", [
    { ...cur, open: 16210.35, in: 23650, out: 21440, close: 18420.35 },
    { ...sav, open: 10000, in: 0, out: 0, close: 10000 }]));
  write(t, "BankTransactions", { BankTransactions: [...bankTx(cur, [120, 45.5, 310], false), ...bankTx(cur, [999], true)] });
  write(t, "ProfitAndLoss", plReport("Harbour Bakery Ltd", [23650, 24050, 22800, 23100, 22400, 21000], {
    "Wages and Salaries": [9000, 9000, 9000, 9000, 9000, 9000],
    "Cost of Ingredients": [5300, 5250, 5400, 5100, 5350, 5200],
    "Rent": [2000, 2000, 2000, 2000, 2000, 2000] }));
  write(t, "BalanceSheet", bsReport("Harbour Bakery Ltd", {
    "Bank": { "Business Current Account": [18420.35, 16210.35, 15400, 14980, 14100, 13250], "Business Savings": [10000, 10000, 10000, 10000, 10000, 10000] },
    "Current Liabilities": { "Director's Loan Account": [5000, 5000, 5000, 5000, 5000, 5000], "VAT": [2300, 2100, 1900, 2250, 2050, 1980] } }));
}

// ---------- Org B: Northwind Joinery Ltd (in trouble) ----------
{
  const t = "northwind-joinery";
  const c = { oak: contact("Oakridge Homes"), patel: contact("Patel Developments"), kes: contact("Kestrel Interiors"),
    timber: contact("Timber Supplies Ltd", false), tool: contact("ToolHire Direct", false), hmrc: contact("HMRC", false), van: contact("Van Lease Co", false) };
  write(t, "Organisation", { Organisations: [{ OrganisationID: "b2b2b2b2-0000-4000-8000-000000000002", Name: "Northwind Joinery Ltd", LegalName: "Northwind Joinery Ltd", BaseCurrency: "GBP", CountryCode: "GB", ShortCode: "!NWJ02" }] });
  write(t, "Contacts", { Contacts: Object.values(c) });
  write(t, "Invoices", { Invoices: [
    invoice("ACCREC", "INV-B101", c.oak, "2026-05-11", "2026-06-10", 8800, 6800),
    invoice("ACCREC", "INV-B102", c.patel, "2026-05-29", "2026-06-28", 4250, 4250),
    invoice("ACCREC", "INV-B103", c.oak, "2026-06-20", "2026-07-20", 3900, 3900),
    invoice("ACCREC", "INV-B104", c.kes, "2026-07-21", "2026-08-20", 2175.5, 2175.5),
    invoice("ACCREC", "INV-B105", c.patel, "2026-08-26", "2026-09-25", 1480, 1480),
    invoice("ACCREC", "INV-B106", c.kes, "2026-09-20", "2026-10-20", 2600, 2600),
    invoice("ACCREC", "INV-B107", c.oak, "2026-04-02", "2026-05-02", 1500, 1500, "VOIDED"),
    invoice("ACCPAY", "TS-5520", c.timber, "2026-08-16", "2026-09-15", 5400, 5400),
    invoice("ACCPAY", "TH-0193", c.tool, "2026-09-12", "2026-10-12", 980, 980),
    invoice("ACCPAY", "PAYE-09", c.hmrc, "2026-09-30", "2026-10-22", 3150, 3150),
    invoice("ACCPAY", "VL-1105", c.van, "2026-10-01", "2026-11-05", 650, 650),
  ] });
  const cur = { id: "bbbb0001-0000-4000-8000-000000000001", name: "Business Current Account" };
  write(t, "BankSummary", bankSummary("Northwind Joinery Ltd", [{ ...cur, open: 9812.4, in: 23300, out: 25900, close: 7212.4 }]));
  write(t, "BankTransactions", { BankTransactions: [...bankTx(cur, [1250, 860, 2400, 75.25, 310, 1100, 499.99], false), ...bankTx(cur, [640], true)] });
  write(t, "ProfitAndLoss", plReport("Northwind Joinery Ltd", [23300, 24900, 26400, 27200, 29800, 31500], {
    "Wages and Salaries": [12000, 12000, 12000, 12000, 12000, 12000],
    "Materials": [18100, 10700, 10600, 10300, 10800, 10500],
    "Rent": [3500, 3500, 3500, 3500, 3500, 3500] }));
  write(t, "BalanceSheet", bsReport("Northwind Joinery Ltd", {
    "Bank": { "Business Current Account": [7212.4, 9812.4, 12600, 15900, 18800, 21450] },
    "Current Assets": { "Director's Loan Account": [14100, 10400, 7800, 5200, 3500, 2000] },
    "Current Liabilities": { "VAT": [3100, 3300, 3400, 3550, 3800, 4000] } }));
}
console.log("fixtures written");
