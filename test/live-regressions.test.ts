/** Regressions found running against the real Xero API (Demo Company (Global), Oct 2026). */
import { describe, it, expect } from "vitest";
import { normalizeBankSummary } from "../src/normalize.js";
import { monthEnd, fetchOrg } from "../src/sync.js";
import { FixtureSource, MixedSource, type XeroSource } from "../src/source.js";
import { FIXTURES } from "./helpers.js";

// Shape copied from a live /Reports/BankSummary response (values unchanged, ids are Xero demo ids).
const liveBankSummary = { Reports: [{ Rows: [
  { RowType: "Header", Cells: [{ Value: "Bank Accounts" }, { Value: "Opening Balance" }, { Value: "Cash Received" }, { Value: "Cash Spent" }, { Value: "Closing Balance" }] },
  { RowType: "Section", Title: "", Rows: [
    { RowType: "Row", Cells: [
      { Value: "Business Bank Account", Attributes: [{ Value: "562555f2-8cde-4ce9-8203-0363922537a4", Id: "accountID" }] },
      { Value: "7430.22" }, { Value: "0.00", Attributes: [{ Value: "562555f2-8cde-4ce9-8203-0363922537a4", Id: "account" }] },
      { Value: "0.00", Attributes: [{ Value: "562555f2-8cde-4ce9-8203-0363922537a4", Id: "account" }] }, { Value: "7430.22" }] },
    { RowType: "SummaryRow", Cells: [{ Value: "Total" }, { Value: "7430.22" }, { Value: "0.00" }, { Value: "0.00" }, { Value: "7430.22" }] },
  ] },
] }] };

describe("live API regressions", () => {
  it("bank summary reads the AccountID from the live 'accountID' attribute (so unreconciled items match)", () => {
    expect(normalizeBankSummary(liveBankSummary)).toEqual([{ id: "562555f2-8cde-4ce9-8203-0363922537a4", name: "Business Bank Account", closingBalance: 7430.22 }]);
  });
  it("monthEnd gives the last calendar day", () => {
    expect(monthEnd("2026-10-15")).toBe("2026-10-31");
    expect(monthEnd("2026-02-03")).toBe("2026-02-28");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
    expect(monthEnd("2026-12-31")).toBe("2026-12-31");
  });
  it("P&L is requested for whole calendar months even mid-month", async () => {
    const seen: Record<string, string>[] = [];
    const fx = new FixtureSource(FIXTURES);
    const spy: XeroSource = { kind: "demo", tenants: () => fx.tenants(), get: (t, r, q) => { if (r === "Reports/ProfitAndLoss") seen.push(q ?? {}); return fx.get(t, r, q); } };
    await fetchOrg(spy, "harbour-bakery", "2026-10-15");
    expect(seen[0]).toMatchObject({ fromDate: "2026-10-01", toDate: "2026-10-31", timeframe: "MONTH" });
  });
  it("mixed source serves live tenants and labelled fixture tenants side by side", async () => {
    const live: XeroSource = { kind: "live", tenants: async () => [{ tenantId: "live-1", tenantName: "Real Org" }], get: async () => ({ from: "live" }) };
    const m = new MixedSource(live, new FixtureSource(FIXTURES));
    const t = await m.tenants();
    expect(t.map((x) => x.tenantName)).toEqual(["Real Org", "Harbour Bakery Ltd (sample)", "Northwind Joinery Ltd (sample)"]);
    expect(await m.get("live-1", "Organisation")).toEqual({ from: "live" });
    expect(((await m.get("harbour-bakery", "Organisation")) as { Organisations: { Name: string }[] }).Organisations[0].Name).toBe("Harbour Bakery Ltd (sample)");
  });
});
