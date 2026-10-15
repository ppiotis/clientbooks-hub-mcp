import { describe, it, expect } from "vitest";
import { agedReceivables, bucketOf, daysBetween, dso, health, nextPayrollDate, overdueAcross, payrollRisk, practiceDashboard, trendingTrouble } from "../src/analytics.js";
import { demoOrgs } from "./helpers.js";

const { bakery, joinery } = await demoOrgs();
const both = [bakery, joinery];

describe("ageing", () => {
  it("bucket boundaries", () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual(["current", "1-30", "1-30", "31-60", "31-60", "61-90", "61-90", "90+"]);
    expect(daysBetween("2026-06-10", "2026-09-30")).toBe(112);
  });
  it("aged receivables per org", () => {
    expect(agedReceivables(joinery).totals).toEqual({ current: 2600, "1-30": 1480, "31-60": 2175.5, "61-90": 3900, "90+": 11050 });
    expect(agedReceivables(joinery).total).toBe(21205.5);
    expect(agedReceivables(bakery).total).toBe(8150);
  });
  it.each([
    [30, 6, 20435.5],
    [60, 4, 15810],
    [90, 2, 11050],
  ])("overdue > %i days across both orgs: %i invoices, £%f", (d, count, total) => {
    const r = overdueAcross(both, d);
    expect(r.count).toBe(count);
    expect(r.totals_by_currency).toEqual({ GBP: total });
  });
  it("sorts most overdue first and keeps currency per invoice", () => {
    const r = overdueAcross(both, 30);
    expect(r.invoices[0]).toMatchObject({ invoice: "INV-B101", days_overdue: 112, amount_due: 6800, currency: "GBP" });
  });
  it("never sums different currencies together", () => {
    const usd = { ...bakery, currency: "USD", invoices: bakery.invoices.map((i) => ({ ...i, currency: "USD" })) };
    expect(overdueAcross([usd, joinery], 30).totals_by_currency).toEqual({ USD: 3310, GBP: 17125.5 });
  });
});

describe("payroll risk", () => {
  it("next payroll date", () => {
    expect(nextPayrollDate("2026-09-30")).toBe("2026-10-25");
    expect(nextPayrollDate("2026-10-10")).toBe("2026-10-25");
    expect(nextPayrollDate("2026-12-28")).toBe("2027-01-25");
  });
  it("Northwind is short; bakery is fine", () => {
    expect(payrollRisk(joinery)).toMatchObject({ cash: 7212.4, committed_bills: 9530, payroll_amount: 12000, coverage_ratio: -0.19, headroom: -14317.6, status: "SHORTFALL" });
    expect(payrollRisk(bakery)).toMatchObject({ cash: 28420.35, committed_bills: 4150, payroll_amount: 9000, coverage_ratio: 2.7, headroom: 15270.35, status: "ok" });
    expect(payrollRisk(joinery).formula).toContain("(cash 7212.4 - bills due on or before 2026-10-25 9530) / payroll 12000 = -0.19");
  });
  it("profile override changes amount and committed window", () => {
    const r = payrollRisk(bakery, { amount: 20000, nextDate: "2026-10-08" });
    expect(r.committed_bills).toBe(2300); // only VAT due 7 Oct
    expect(r.coverage_ratio).toBe(1.31);
    expect(r.status).toBe("tight");
  });
});

describe("health + dashboard", () => {
  it("bakery healthy, joinery at risk with exact flags", () => {
    expect(health(bakery)).toMatchObject({ score: 100, band: "healthy", flags: [] });
    const h = health(joinery);
    expect(h.score).toBe(10);
    expect(h.band).toBe("at risk");
    expect(h.flags.map((f) => f.points)).toEqual([15, 25, 15, 15, 10, 10]);
    expect(h.metrics.expense_z_score).toBe(39.09);
    expect(health(bakery).metrics.expense_z_score).toBe(0.34);
  });
  it("director loan growth rule needs 3 consecutive rises", () => {
    const flat = { ...joinery, directorLoans: [{ name: "Director's Loan Account", balances: [14100, 10400, 10400, 5200] }] };
    expect(health(flat).flags.some((f) => /Director/.test(f.rule))).toBe(false);
  });
  it("DSO", () => {
    expect(dso(bakery)).toMatchObject({ receivables: 8150, income_last_3_months: 70500, days_in_period: 92, dso_days: 10.6 });
    expect(dso(joinery).dso_days).toBe(26.2);
  });
  it("practice dashboard", () => {
    const d = practiceDashboard(both, 3, new Map());
    expect(d.total_revenue_by_currency).toEqual({ GBP: 145100 });
    expect(d.average_dso_days).toBe(18.4);
    expect(practiceDashboard(both, 6, new Map()).total_revenue_by_currency).toEqual({ GBP: 300100 });
  });
  it("trending trouble", () => {
    const t = trendingTrouble(both, new Map());
    expect(t.count).toBe(1);
    expect(t.clients[0]).toMatchObject({ org: "Northwind Joinery Ltd", score: 10 });
  });
});
