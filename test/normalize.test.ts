import { describe, it, expect } from "vitest";
import { normalizeBankSummary, normalizeDirectorLoans, normalizeInvoices, normalizePnl, normalizeUnreconciled, num, xeroDate } from "../src/normalize.js";
import { fixture } from "./helpers.js";

describe("primitives", () => {
  it("parses both Xero date formats", () => {
    expect(xeroDate("2026-09-20T00:00:00")).toBe("2026-09-20");
    expect(xeroDate(`/Date(${Date.parse("2026-09-20T00:00:00Z")}+0000)/`)).toBe("2026-09-20");
    expect(xeroDate("nonsense")).toBeUndefined();
    expect(xeroDate(undefined)).toBeUndefined();
  });
  it("parses report numbers incl. commas and parentheses", () => {
    expect(num("1,234.50")).toBe(1234.5);
    expect(num("(250.00)")).toBe(-250);
    expect(num("")).toBe(0);
    expect(num(12)).toBe(12);
    expect(num("abc")).toBe(0);
  });
});

describe("invoices", () => {
  const inv = normalizeInvoices("b", fixture("northwind-joinery", "Invoices"), "GBP");
  it("keeps only AUTHORISED with amount due (drops VOIDED/DRAFT/PAID)", () => {
    expect(inv.map((i) => i.number)).not.toContain("INV-B107");
    expect(inv.filter((i) => i.kind === "receivable")).toHaveLength(6);
    expect(inv.filter((i) => i.kind === "payable")).toHaveLength(4);
    const a = normalizeInvoices("a", fixture("harbour-bakery", "Invoices"), "GBP").map((i) => i.number);
    expect(a).not.toContain("INV-A006");
    expect(a).not.toContain("INV-A007");
  });
  it("uses AmountDue, not Total, for part-paid invoices", () => {
    const b101 = inv.find((i) => i.number === "INV-B101")!;
    expect(b101.total).toBe(8800);
    expect(b101.amountDue).toBe(6800);
    expect(b101.dueDate).toBe("2026-06-10");
    expect(b101.contact).toBe("Oakridge Homes");
  });
  it("falls back to /Date()/ when DueDateString is missing and ignores junk payloads", () => {
    const raw = fixture("northwind-joinery", "Invoices");
    delete raw.Invoices[0].DueDateString;
    expect(normalizeInvoices("b", raw, "GBP")[0].dueDate).toBe("2026-06-10");
    expect(normalizeInvoices("b", {}, "GBP")).toEqual([]);
  });
});

describe("reports", () => {
  it("bank summary closing balances", () => {
    expect(normalizeBankSummary(fixture("harbour-bakery", "BankSummary")).map((b) => b.closingBalance)).toEqual([18420.35, 10000]);
  });
  it("unreconciled bank transactions grouped per account, reconciled ones excluded", () => {
    const m = normalizeUnreconciled(fixture("northwind-joinery", "BankTransactions"));
    expect([...m.values()]).toEqual([{ count: 7, amount: 6495.24 }]);
  });
  it("P&L monthly income/expenses/payroll, newest first", () => {
    const p = normalizePnl(fixture("northwind-joinery", "ProfitAndLoss"));
    expect(p).toHaveLength(6);
    expect(p[0]).toMatchObject({ label: "Sep 26", income: 23300, expenses: 33600, netProfit: -10300, payroll: 12000 });
    expect(p.map((m) => m.expenses)).toEqual([33600, 26200, 26100, 25800, 26300, 26000]);
  });
  it("director loan accounts found anywhere in the balance sheet", () => {
    expect(normalizeDirectorLoans(fixture("northwind-joinery", "BalanceSheet"))).toEqual([{ name: "Director's Loan Account", balances: [14100, 10400, 7800, 5200, 3500, 2000] }]);
  });
  it("rejects payloads without a report", () => {
    expect(() => normalizePnl({})).toThrow(/Reports/);
  });
});
