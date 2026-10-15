import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { rm, tmp } from "./helpers.js";

const TOOLS = ["connect_org_start", "connect_org_complete", "list_orgs", "sync_now", "overdue_invoices", "payroll_risk", "set_payroll_profile", "month_end_pack", "client_health", "practice_dashboard", "clients_trending_trouble", "disconnect_org",
  "pull_data", "scan_issues", "unreconciled_items", "tax_readiness", "close_readiness", "month_end_summary", "practice_scan", "prepare_manual_journal", "confirm_manual_journal", "list_proposals", "audit_trail"];
type Text = { type: string; text: string };
let dir = "";
let env: Record<string, string>;

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Text[]).map((c) => c.text).join("\n");
  return { isError: Boolean(r.isError), text, json: () => JSON.parse(text) };
}

/** The reviewer scenarios from the README, run verbatim over MCP. */
async function scenarios(client: Client, exportDir: string) {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  for (const t of tools) expect(t.description!.length).toBeGreaterThan(40);

  const orgs = (await call(client, "list_orgs")).json();
  expect(orgs.mode).toBe("demo");
  expect(orgs.orgs.map((o: { name: string }) => o.name)).toEqual(["Harbour Bakery Ltd", "Kookaburra Coffee Co Pty Ltd", "Northwind Joinery Ltd"]);
  expect(orgs.orgs.map((o: { open_invoices: number }) => o.open_invoices)).toEqual([5, 4, 6]);

  const o30 = (await call(client, "overdue_invoices", { min_days: 30 })).json();
  expect(o30.count).toBe(7);
  expect(o30.totals_by_currency).toEqual({ GBP: 20435.5, AUD: 4400 }); // currencies never mixed
  expect((await call(client, "overdue_invoices", { min_days: 90 })).json().invoices.map((i: { invoice: string }) => i.invoice)).toEqual(["INV-B101", "INV-B102"]);
  expect((await call(client, "overdue_invoices", { min_days: 45 })).isError).toBe(true);

  const pr = (await call(client, "payroll_risk")).json();
  expect(pr.closest_to_missing_payroll).toBe("Kookaburra Coffee Co Pty Ltd"); // the duplicate Bean Brokers bill pushes it under
  expect(pr.orgs[0]).toMatchObject({ coverage_ratio: -1.65, headroom: -13754.45 });
  expect(pr.orgs.find((o: { org: string }) => o.org === "Northwind Joinery Ltd")).toMatchObject({ coverage_ratio: -0.19, headroom: -14317.6 });

  const pack = (await call(client, "month_end_pack", { org: "northwind" })).json();
  expect(pack.summary.aged_receivables.total).toBe(21205.5);
  expect(pack.file.startsWith(exportDir)).toBe(true);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(pack.file);
  expect(wb.worksheets.map((w) => w.name)).toEqual(["Aged Receivables", "Bank Reconciliation", "P&L Snapshot"]);

  const h = (await call(client, "client_health")).json();
  expect(h.clients.map((c: { score: number }) => c.score)).toEqual([100, 50, 10]);

  const d = (await call(client, "practice_dashboard")).json();
  expect(d).toMatchObject({ clients: 3, total_revenue_by_currency: { GBP: 145100, AUD: 52500 }, average_dso_days: 18.9 });

  const t = (await call(client, "clients_trending_trouble")).json();
  expect(t.clients.map((c: { org: string }) => c.org)).toEqual(["Northwind Joinery Ltd", "Kookaburra Coffee Co Pty Ltd"]);

  const sp = (await call(client, "set_payroll_profile", { org: "Harbour", amount: 20000, next_payroll_date: "2026-10-08" })).json();
  expect(sp).toMatchObject({ persisted: false, result: { coverage_ratio: 1.31, status: "tight" } });

  expect((await call(client, "month_end_pack", { org: "Ltd" })).text).toMatch(/matches several orgs/);
  expect((await call(client, "connect_org_start")).json().mode).toBe("demo");
  expect((await call(client, "disconnect_org", { org: "Harbour" })).isError).toBe(true);
  expect((await call(client, "sync_now")).json().orgs.every((o: { ok: boolean }) => o.ok)).toBe(true);

  // v1.2 practice-scale tools, over the real transport
  const un = (await call(client, "unreconciled_items", { older_than_days: 7 })).json();
  expect(un.clients_with_items).toEqual(["Harbour Bakery Ltd", "Kookaburra Coffee Co Pty Ltd", "Northwind Joinery Ltd"]);
  const tr = (await call(client, "tax_readiness")).json();
  expect(tr.orgs.find((o: { org: string }) => o.org.startsWith("Kookaburra"))).toMatchObject({ return_type: "BAS", status: "not ready" });
  const ps = (await call(client, "practice_scan")).json();
  expect(ps.clients[0]).toMatchObject({ org: "Kookaburra Coffee Co Pty Ltd", high: 7, tax_return: "BAS: not ready", close_score: 0 });
  const pj = (await call(client, "prepare_manual_journal", { org: "kookaburra", date: "2026-09-30", narration: "Clear suspense", lines: [{ account_code: "899", amount: 734.2 }, { account_code: "469", amount: -734.2 }] })).json();
  expect(pj).toMatchObject({ status: "prepared (not sent)", writes_enabled: false });
  const cj = await call(client, "confirm_manual_journal", { proposal_id: pj.proposal_id, confirmation_phrase: pj.confirmation_phrase });
  expect(cj.isError).toBe(true);
  expect(cj.text).toMatch(/Write-back is disabled/);
}

describe("e2e over MCP (demo fixtures)", () => {
  let http: ChildProcess | undefined;
  beforeAll(() => {
    dir = tmp("xagg-e2e-");
    env = { ...(process.env as Record<string, string>), XERO_AGG_DEMO: "1", XERO_AGG_SYNC_MINUTES: "0", XERO_AGG_TOKEN_FILE: path.join(dir, "tokens.enc"), XERO_AGG_AUDIT_FILE: path.join(dir, "audit.jsonl") };
  });
  afterAll(() => { http?.kill(); rm(dir); });

  it("stdio transport", async () => {
    const exportDir = path.join(dir, "stdio");
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/stdio.js"], env: { ...env, XERO_AGG_EXPORT_DIR: exportDir } }));
    try { await scenarios(client, exportDir); } finally { await client.close(); }
    expect(existsSync(path.join(dir, "tokens.enc"))).toBe(false);
  }, 60_000);

  it("Streamable HTTP transport (bearer auth, health, oauth callback)", async () => {
    const exportDir = path.join(dir, "http");
    const port = 39000 + Math.floor(Math.random() * 1000);
    http = spawn(process.execPath, ["dist/serve-http.js"], { env: { ...env, XERO_AGG_EXPORT_DIR: exportDir, PORT: String(port), MCP_AUTH_TOKEN: "test-token" }, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      http!.stderr!.on("data", (d) => String(d).includes("listening") && resolve());
      http!.on("exit", (code) => reject(new Error(`http server exited ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { authorization: "Bearer wrong-token" } })).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const cb = await fetch(`${base}/oauth/callback?code=x&state=forged`);
    expect(cb.status).toBe(400);
    expect(await cb.text()).not.toContain("forged");
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer test-token" } } }));
    try { await scenarios(client, exportDir); } finally { await client.close(); }
  }, 60_000);
});

describe("HTTP hardening", () => {
  it("refuses to listen publicly without MCP_AUTH_TOKEN", async () => {
    const p = spawn(process.execPath, ["dist/serve-http.js"], { env: { ...(process.env as Record<string, string>), XERO_AGG_DEMO: "1", HOST: "0.0.0.0", PORT: "0", MCP_AUTH_TOKEN: "" }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr!.on("data", (d) => (err += d));
    const code = await new Promise((r) => p.on("exit", r));
    expect(code).toBe(1);
    expect(err).toMatch(/Refusing/);
  });
});
