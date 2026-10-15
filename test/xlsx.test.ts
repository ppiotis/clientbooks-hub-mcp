import { describe, it, expect, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { writePack, SHEETS } from "../src/xlsx.js";
import { demoOrgs, rm, tmp } from "./helpers.js";

const dir = tmp("xagg-xlsx-");
afterAll(() => rm(dir));
const { bakery, joinery } = await demoOrgs();

async function open(file: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}
const rowsOf = (ws: ExcelJS.Worksheet) => {
  const out: unknown[][] = [];
  ws.eachRow((r) => out.push((r.values as unknown[]).slice(1)));
  return out;
};

describe("month-end pack", () => {
  it("Northwind workbook: 3 sheets, exact rows and totals", async () => {
    const { file, sheets } = await writePack(joinery, dir);
    expect(file.endsWith("northwind-joinery-ltd-month-end-2026-09-30.xlsx")).toBe(true);
    expect(sheets).toEqual([...SHEETS]);
    const wb = await open(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Aged Receivables", "Bank Reconciliation", "P&L Snapshot"]);

    const ar = rowsOf(wb.getWorksheet("Aged Receivables")!);
    const header = ar.findIndex((r) => r[0] === "Contact");
    const body = ar.slice(header + 1, -1);
    expect(body.map((r) => r[1])).toEqual(["INV-B101", "INV-B102", "INV-B103", "INV-B104", "INV-B105", "INV-B106"]);
    expect(body[0]).toEqual(["Oakridge Homes", "INV-B101", "2026-05-11", "2026-06-10", 112, undefined, undefined, undefined, undefined, 6800, 6800]);
    expect(ar.at(-1)).toEqual(["Total", "", "", "", "", 2600, 1480, 2175.5, 3900, 11050, 21205.5]);
    // Column totals equal the sum of the rows
    const colSum = (c: number) => Math.round(body.reduce((a, r) => a + (Number(r[c]) || 0), 0) * 100) / 100;
    expect([5, 6, 7, 8, 9, 10].map(colSum)).toEqual([2600, 1480, 2175.5, 3900, 11050, 21205.5]);

    const br = rowsOf(wb.getWorksheet("Bank Reconciliation")!);
    expect(br.find((r) => r[0] === "Business Current Account")).toEqual(["Business Current Account", 7212.4, 7, 6495.24, "Needs reconciling"]);
    expect(br.find((r) => r[0] === "Total")!.slice(0, 4)).toEqual(["Total", 7212.4, 7, 6495.24]);

    const pl = rowsOf(wb.getWorksheet("P&L Snapshot")!);
    expect(pl.find((r) => r[0] === "Line")).toEqual(["Line", "Section", "Sep 26", "6 months to Sep 26"]);
    expect(pl.find((r) => r[0] === "Materials")).toEqual(["Materials", "Operating Expenses", 18100, 71000]);
    expect(pl.find((r) => r[0] === "Total income")!.slice(2)).toEqual([23300, 163100]);
    expect(pl.find((r) => r[0] === "Total expenses")!.slice(2)).toEqual([33600, 164000]);
    expect(pl.find((r) => r[0] === "Net profit")!.slice(2)).toEqual([-10300, -900]);
  });
  it("Harbour Bakery workbook totals", async () => {
    const { file, summary } = await writePack(bakery, dir);
    expect(summary.aged_receivables.totals).toEqual({ current: 3100, "1-30": 1740, "31-60": 2450, "61-90": 860, "90+": 0 });
    expect(summary.bank_reconciliation).toEqual({ accounts: 2, closing: 28420.35, count: 3, amount: 475.5 });
    const br = rowsOf((await open(file)).getWorksheet("Bank Reconciliation")!);
    expect(br.find((r) => r[0] === "Business Savings")).toEqual(["Business Savings", 10000, 0, 0, "Reconciled"]);
    expect(summary.pnl.latest).toEqual({ income: 23650, expenses: 16300, net: 7350 });
  });
  it("cannot be steered outside the export dir by an org name", async () => {
    const { file } = await writePack({ ...bakery, name: "../../etc/passwd" }, dir);
    expect(file.startsWith(dir)).toBe(true);
  });
});
