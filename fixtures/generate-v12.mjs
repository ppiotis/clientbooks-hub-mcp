// v1.2 demo data: a third, issue-laden org (Kookaburra Coffee Co, AUD/GST) plus chart of accounts,
// tax rates, payments, manual journals and trial balances for every org, so the practice-scan,
// data-pull, BAS/VAT readiness and journal-prepare tools all have realistic data in demo mode.
// Synthetic data (not real businesses). Re-run with: node fixtures/generate-v12.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const msDate = (iso) => `/Date(${Date.parse(iso + "T00:00:00Z")}+0000)/`;
const months = ["Sep 26", "Aug 26", "Jul 26", "Jun 26", "May 26", "Apr 26"];
let seq = 0;
const uid = (p) => `${p}0000-0000-4000-9000-${String(++seq).padStart(12, "0")}`;
const cell = (v, account) => (account ? { Value: v, Attributes: [{ Value: account, Id: "account" }] } : { Value: v });
const fmt = (n) => n.toFixed(2);
function write(tenant, name, data) {
  const p = join(root, tenant, `${name}.json`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}
const acct = (code, name, type, taxType, cls) => ({ AccountID: uid("ac"), Code: code, Name: name, Type: type, TaxType: taxType, Class: cls, Status: "ACTIVE" });
function trialBalance(title, rows) {
  return { Reports: [{ ReportID: "TrialBalance", ReportName: "Trial Balance", ReportType: "TrialBalance", ReportTitles: ["Trial Balance", title, "As at 30 September 2026"], ReportDate: "30 September 2026",
    Rows: [{ RowType: "Header", Cells: ["Account", "Debit", "Credit", "YTD Debit", "YTD Credit"].map((v) => cell(v)) },
      { RowType: "Section", Title: "Accounts", Rows: rows.map(([a, dr, cr]) => ({ RowType: "Row", Cells: [cell(`${a.Name} (${a.Code})`, a.AccountID), cell(dr ? fmt(dr) : ""), cell(cr ? fmt(cr) : ""), cell(dr ? fmt(dr) : ""), cell(cr ? fmt(cr) : "")] })) }] }] };
}

// ---------- UK orgs: chart, VAT rates, clean TBs ----------
const ukRates = { TaxRates: [
  { Name: "20% (VAT on Income)", TaxType: "OUTPUT2", EffectiveRate: 20, Status: "ACTIVE" },
  { Name: "20% (VAT on Expenses)", TaxType: "INPUT2", EffectiveRate: 20, Status: "ACTIVE" },
  { Name: "Zero Rated Income", TaxType: "ZERORATEDOUTPUT", EffectiveRate: 0, Status: "ACTIVE" },
  { Name: "No VAT", TaxType: "NONE", EffectiveRate: 0, Status: "ACTIVE" }] };
for (const [t, name, bank] of [["harbour-bakery", "Harbour Bakery Ltd", 28420.35], ["northwind-joinery", "Northwind Joinery Ltd", 7212.4]]) {
  const a = { bank: acct("090", "Business Current Account", "BANK", "NONE", "ASSET"), sales: acct("200", "Sales", "REVENUE", "OUTPUT2", "REVENUE"),
    wages: acct("477", "Wages and Salaries", "EXPENSE", "NONE", "EXPENSE"), rent: acct("469", "Rent", "EXPENSE", "INPUT2", "EXPENSE"),
    vat: acct("820", "VAT", "CURRLIAB", "NONE", "LIABILITY"), accr: acct("825", "Accruals", "CURRLIAB", "NONE", "LIABILITY"), equity: acct("970", "Retained Earnings", "EQUITY", "NONE", "EQUITY") };
  write(t, "Accounts", { Accounts: Object.values(a) });
  write(t, "TaxRates", ukRates);
  write(t, "TrialBalance", trialBalance(name, [[a.bank, bank, 0], [a.sales, 0, 140000], [a.wages, 60000, 0], [a.rent, 15000, 0], [a.vat, 0, 3100], [a.equity, 68100 - bank, 0]]));
  write(t, "Payments", { Payments: [] });
  write(t, "ManualJournals", { ManualJournals: [] });
}

// ---------- Org C: Kookaburra Coffee Co Pty Ltd (AUD, GST; month-end mess) ----------
{
  const t = "kookaburra-coffee";
  const contact = (n) => ({ ContactID: uid("c"), Name: n, ContactStatus: "ACTIVE" });
  const c = { brew: contact("Brew Bar Cafe"), lane: contact("Laneway Roasters"), hotel: contact("Harbourside Hotel"), events: contact("Pop-up Events Co"),
    beans: contact("Bean Brokers Pty Ltd"), collins: contact("Collins St Property"), telco: contact("Telstra"), office: contact("Officeworks"), ato: contact("ATO") };
  const a = { bank: acct("090", "Business Cheque Account", "BANK", "BASEXCLUDED", "ASSET"), sales: acct("200", "Sales", "REVENUE", "OUTPUT", "REVENUE"),
    cogs: acct("310", "Cost of Goods Sold", "DIRECTCOSTS", "INPUT", "EXPENSE"), rent: acct("469", "Rent", "EXPENSE", "INPUT", "EXPENSE"),
    tel: acct("489", "Telephone & Internet", "EXPENSE", "INPUT", "EXPENSE"), rep: acct("473", "Repairs and Maintenance", "EXPENSE", "INPUT", "EXPENSE"),
    wages: acct("477", "Wages and Salaries", "EXPENSE", "BASEXCLUDED", "EXPENSE"), office: acct("461", "Office Expenses", "EXPENSE", "INPUT", "EXPENSE"),
    gst: acct("820", "GST", "CURRLIAB", "BASEXCLUDED", "LIABILITY"), susp: acct("899", "Suspense", "CURRLIAB", "BASEXCLUDED", "LIABILITY"),
    accr: acct("825", "Accrued Expenses", "CURRLIAB", "BASEXCLUDED", "LIABILITY"), loan: acct("835", "Director Loan Account", "CURRLIAB", "BASEXCLUDED", "LIABILITY"),
    equity: acct("960", "Retained Earnings", "EQUITY", "BASEXCLUDED", "EQUITY") };
  write(t, "Organisation", { Organisations: [{ OrganisationID: "c3c3c3c3-0000-4000-8000-000000000003", Name: "Kookaburra Coffee Co Pty Ltd", LegalName: "Kookaburra Coffee Co Pty Ltd",
    BaseCurrency: "AUD", CountryCode: "AU", ShortCode: "!KOOK3", TaxNumber: "51 824 753 556", SalesTaxBasis: "ACCRUALS", SalesTaxPeriod: "QUARTERLY",
    PeriodLockDate: "2026-03-31T00:00:00", FinancialYearEndDay: 30, FinancialYearEndMonth: 6 }] });
  write(t, "Contacts", { Contacts: Object.values(c) });
  write(t, "Accounts", { Accounts: Object.values(a) });
  write(t, "TaxRates", { TaxRates: [
    { Name: "GST on Income", TaxType: "OUTPUT", EffectiveRate: 10, Status: "ACTIVE" },
    { Name: "GST on Expenses", TaxType: "INPUT", EffectiveRate: 10, Status: "ACTIVE" },
    { Name: "GST Free Income", TaxType: "EXEMPTOUTPUT", EffectiveRate: 0, Status: "ACTIVE" },
    { Name: "BAS Excluded", TaxType: "BASEXCLUDED", EffectiveRate: 0, Status: "ACTIVE" }] });
  const line = (desc, account, amount, taxType, taxAmount) => ({ LineItemID: uid("l"), Description: desc, AccountCode: account.Code, LineAmount: amount, TaxType: taxType, TaxAmount: taxAmount, Quantity: 1, UnitAmount: amount });
  const inv = (type, number, ct, date, due, lines, status = "AUTHORISED", paid = 0, extra = {}) => {
    const sub = lines.reduce((s, l) => s + l.LineAmount, 0), tax = lines.reduce((s, l) => s + l.TaxAmount, 0), total = +(sub + tax).toFixed(2);
    return { Type: type, InvoiceID: uid("1"), InvoiceNumber: number, Reference: extra.Reference ?? "", Status: status, LineAmountTypes: "Exclusive",
      Contact: { ContactID: ct.ContactID, Name: ct.Name }, Date: msDate(date), DateString: `${date}T00:00:00`, DueDate: msDate(due), DueDateString: `${due}T00:00:00`,
      CurrencyCode: "AUD", LineItems: lines, SubTotal: sub, TotalTax: tax, Total: total, AmountPaid: paid, AmountDue: +(total - paid).toFixed(2), HasAttachments: extra.HasAttachments ?? true };
  };
  const paidInv = inv("ACCREC", "KC-0990", c.events, "2026-06-10", "2026-06-24", [line("Event catering", a.sales, 1000, "OUTPUT", 100)], "PAID", 1100);
  const invoices = [
    inv("ACCREC", "KC-1001", c.brew, "2026-07-01", "2026-07-31", [line("Wholesale beans July", a.sales, 4000, "OUTPUT", 400)]),
    inv("ACCREC", "KC-1002", c.brew, "2026-08-15", "2026-09-14", [line("Wholesale beans Aug", a.sales, 1500, "OUTPUT", 150)]),
    inv("ACCREC", "KC-1003", c.lane, "2026-09-05", "2026-10-05", [line("Roasting contract", a.sales, 2000, "", 0)]),
    inv("ACCREC", "KC-1004", c.hotel, "2026-09-10", "2026-10-10", [line("Coffee cart, conference", a.sales, 3300, "BASEXCLUDED", 0)]),
    inv("ACCREC", "KC-1005", c.events, "2026-08-20", "2026-09-19", [line("Festival stall (unapproved)", a.sales, 800, "OUTPUT", 80)], "DRAFT"),
    paidInv,
    inv("ACCPAY", "BB-7781", c.beans, "2026-09-12", "2026-10-12", [line("Green beans 60kg", a.cogs, 5000, "INPUT", 500)]),
    inv("ACCPAY", "BB-7781", c.beans, "2026-09-13", "2026-10-13", [line("Green beans 60kg", a.cogs, 5000, "INPUT", 500)], "AUTHORISED", 0, { HasAttachments: false }),
    inv("ACCPAY", "RENT-SEP", c.collins, "2026-09-01", "2026-09-08", [line("Rent Sep 2026", a.rent, 6000, "INPUT", 600)]),
    inv("ACCPAY", "TEL-0925", c.telco, "2026-09-25", "2026-10-25", [line("Mobile + NBN", a.tel, 300, "INPUT", 45)]),
    inv("ACCPAY", "BAS-Q4", c.ato, "2026-07-28", "2026-08-28", [line("BAS Apr-Jun", a.gst, 2950, "BASEXCLUDED", 0)], "AUTHORISED", 0),
  ];
  write(t, "Invoices", { Invoices: invoices });
  const pay = (invoice, date, amount, reconciled) => ({ PaymentID: uid("p"), Date: msDate(date), DateString: `${date}T00:00:00`, Amount: amount, Reference: "", IsReconciled: reconciled, Status: "AUTHORISED",
    PaymentType: "ACCRECPAYMENT", Account: { AccountID: a.bank.AccountID, Code: a.bank.Code }, Invoice: { InvoiceID: invoice.InvoiceID, InvoiceNumber: invoice.InvoiceNumber, Contact: invoice.Contact } });
  write(t, "Payments", { Payments: [pay(paidInv, "2026-06-20", 1100, true), pay(paidInv, "2026-06-21", 1100, false)] });
  const bank = { AccountID: a.bank.AccountID, Code: a.bank.Code, Name: a.bank.Name };
  const btx = (type, date, contactObj, lines, reconciled, hasAtt, ref = "") => ({ BankTransactionID: uid("b"), Type: type, Status: "AUTHORISED", IsReconciled: reconciled, HasAttachments: hasAtt,
    Reference: ref, Contact: { ContactID: contactObj.ContactID, Name: contactObj.Name }, Date: msDate(date), DateString: `${date}T00:00:00`, LineAmountTypes: "Exclusive", LineItems: lines,
    SubTotal: lines.reduce((s, l) => s + l.LineAmount, 0), TotalTax: lines.reduce((s, l) => s + l.TaxAmount, 0), Total: +lines.reduce((s, l) => s + l.LineAmount + l.TaxAmount, 0).toFixed(2), CurrencyCode: "AUD", BankAccount: bank });
  write(t, "BankTransactions", { BankTransactions: [
    btx("SPEND", "2026-08-10", c.office, [line("Espresso grinder", a.office, 1800, "INPUT", 180)], false, false, "Card 4471"),
    btx("SPEND", "2026-09-27", c.office, [line("Printer paper", a.office, 77.27, "INPUT", 7.73)], false, true),
    btx("RECEIVE", "2026-09-15", c.events, [line("Cash sales, markets", a.sales, 640, "NONE", 0)], false, false),
    btx("SPEND", "2026-09-18", c.collins, [line("Fit-out deposit", a.rep, 2400, "INPUT", 240)], true, true),
    btx("SPEND", "2026-09-20", c.office, [line("Machine service", a.rep, 1200, "INPUT", 120)], true, false),
  ] });
  write(t, "ManualJournals", { ManualJournals: [
    { ManualJournalID: uid("m"), Date: msDate("2026-07-31"), DateString: "2026-07-31T00:00:00", Status: "DRAFT", Narration: "July accruals (never posted)", LineAmountTypes: "NoTax",
      JournalLines: [{ AccountCode: "469", LineAmount: 500, Description: "Accrue rent top-up" }, { AccountCode: "825", LineAmount: -500, Description: "Accrue rent top-up" }] },
    { ManualJournalID: uid("m"), Date: msDate("2026-06-30"), DateString: "2026-06-30T00:00:00", Status: "POSTED", Narration: "EOFY depreciation", LineAmountTypes: "NoTax",
      JournalLines: [{ AccountCode: "473", LineAmount: 1200 }, { AccountCode: "960", LineAmount: -1200 }] }] });
  const closing = 12340.55;
  write(t, "BankSummary", { Reports: [{ ReportID: "BankSummary", ReportName: "Bank Summary", ReportType: "BankSummary", ReportDate: "30 September 2026",
    Rows: [{ RowType: "Header", Cells: ["Bank Accounts", "Opening Balance", "Cash Received", "Cash Spent", "Closing Balance"].map((v) => cell(v)) },
      { RowType: "Section", Title: "", Rows: [{ RowType: "Row", Cells: [cell(a.bank.Name, a.bank.AccountID), cell("10880.55"), cell("18840.00"), cell("17380.00"), cell(fmt(closing))] }] }] }] });
  const income = [18200, 16900, 17400, 16800, 15900, 15200];
  const exp = { "Cost of Goods Sold": [6100, 5600, 5800, 5500, 5300, 5000], "Rent": [6000, 6000, 6000, 6000, 6000, 6000], "Wages and Salaries": [5200, 5200, 5200, 5000, 5000, 5000],
    "Repairs and Maintenance": [3600, 450, 520, 480, 500, 470], "Telephone & Internet": [300, 290, 295, 300, 290, 285] };
  const header = { RowType: "Header", Cells: [cell(""), ...months.map((m) => cell(m))] };
  const expTotals = months.map((_, i) => Object.values(exp).reduce((s, v) => s + v[i], 0));
  write(t, "ProfitAndLoss", { Reports: [{ ReportID: "ProfitAndLoss", ReportName: "Profit and Loss", ReportType: "ProfitAndLoss", ReportDate: "30 September 2026", Rows: [header,
    { RowType: "Section", Title: "Income", Rows: [{ RowType: "Row", Cells: [cell("Sales", a.sales.AccountID), ...income.map((n) => cell(fmt(n)))] }] },
    { RowType: "Section", Title: "Less Operating Expenses", Rows: [...Object.entries(exp).map(([n, v]) => ({ RowType: "Row", Cells: [cell(n, uid("x")), ...v.map((x) => cell(fmt(x)))] })),
      { RowType: "SummaryRow", Cells: [cell("Total Operating Expenses"), ...expTotals.map((x) => cell(fmt(x)))] }] }] }] });
  write(t, "BalanceSheet", { Reports: [{ ReportID: "BalanceSheet", ReportName: "Balance Sheet", ReportType: "BalanceSheet", ReportDate: "30 September 2026", Rows: [header,
    { RowType: "Section", Title: "Bank", Rows: [{ RowType: "Row", Cells: [cell(a.bank.Name), ...[closing, 10880.55, 11200, 9800, 9100, 8700].map((x) => cell(fmt(x)))] }] },
    { RowType: "Section", Title: "Current Liabilities", Rows: [{ RowType: "Row", Cells: [cell("Director Loan Account"), ...[3000, 3000, 3000, 3000, 3000, 3000].map((x) => cell(fmt(x)))] },
      { RowType: "Row", Cells: [cell("Suspense"), ...[734.2, 734.2, 0, 0, 0, 0].map((x) => cell(fmt(x)))] }] }] }] });
  write(t, "TrialBalance", trialBalance("Kookaburra Coffee Co Pty Ltd", [[a.bank, closing, 0], [a.sales, 0, 50500], [a.cogs, 17500, 0], [a.rent, 18000, 0], [a.wages, 15600, 0],
    [a.rep, 4570, 0], [a.gst, 0, 2950], [a.susp, 0, 734.2], [a.loan, 0, 3000], [a.equity, 0, 10826.35]]));
}
console.log("v1.2 fixtures written");
