/**
 * Integration tests against the REAL Xero API (your Demo Company).
 * Skipped unless XERO_CLIENT_ID, XERO_AGG_TOKEN_KEY and either XERO_REFRESH_TOKEN or
 * XERO_AGG_TOKEN_FILE are set (XERO_CLIENT_SECRET too for "Web app" Xero apps).
 * Read-only: only GET requests are made. See README > Integration tests.
 * NOTE: Xero rotates refresh tokens on every use. Point XERO_AGG_TOKEN_FILE at a
 * persistent path so the rotated token is kept (encrypted) for the next run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { buildContext } from "../src/context.js";
import { agedReceivables, overdueAcross, payrollRisk, health } from "../src/analytics.js";
import { writePack } from "../src/xlsx.js";
import { tmp, rm } from "./helpers.js";


const e = process.env;
const enabled = Boolean(e.XERO_CLIENT_ID && e.XERO_AGG_TOKEN_KEY && (e.XERO_REFRESH_TOKEN || e.XERO_AGG_TOKEN_FILE));
if (!enabled) console.warn("[integration] SKIPPED: set XERO_CLIENT_ID, XERO_AGG_TOKEN_KEY and either XERO_REFRESH_TOKEN or XERO_AGG_TOKEN_FILE (plus XERO_CLIENT_SECRET for web apps) to run against the real Xero API.");

describe.skipIf(!enabled)("Xero API integration (Demo Company)", () => {
  const dir = tmp("xagg-int-");
  const env = { ...e, XERO_AGG_DEMO: "", XERO_AGG_SYNC_MINUTES: "0", XERO_AGG_TOKEN_FILE: e.XERO_AGG_TOKEN_FILE ?? path.join(dir, "tokens.enc"), XERO_AGG_EXPORT_DIR: path.join(dir, "exports") };
  const ctx = buildContext(env);

  beforeAll(async () => {
    if (e.XERO_REFRESH_TOKEN) await ctx.oauth.importRefreshToken(e.XERO_REFRESH_TOKEN);
    expect((await ctx.source.tenants()).length).toBeGreaterThan(0);
  }, 60_000);
  afterAll(() => rm(dir)); // the test pack is live client data: don't leave it in /tmp

  it("syncs every connected org with no errors", async () => {
    const r = await ctx.cache.sync();
    expect(r.orgs.length).toBeGreaterThan(0);
    for (const o of r.orgs) expect(o.ok, `${o.name}: ${o.error}`).toBe(true);
  }, 120_000);

  it("normalized model is internally consistent", async () => {
    for (const o of ctx.cache.orgs.values()) {
      expect(o.currency).toMatch(/^[A-Z]{3}$/);
      expect(o.pnl.length).toBeGreaterThan(0);
      expect(o.bank.length).toBeGreaterThan(0);
      // Regression: live BankSummary carries the AccountID as attribute "accountID".
      for (const b of o.bank) expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
      const aged = agedReceivables(o);
      expect(Math.round(Object.values(aged.totals).reduce((a, b) => a + b, 0) * 100) / 100).toBe(aged.total);
      expect(overdueAcross([o], 30).count).toBeLessThanOrEqual(aged.rows.length);
      expect(typeof payrollRisk(o).cash).toBe("number");
      expect(health(o).score).toBeGreaterThanOrEqual(0);
    }
  });

  it("writes a month-end pack from live data", async () => {
    const o = [...ctx.cache.orgs.values()][0];
    const { sheets, summary } = await writePack(o, env.XERO_AGG_EXPORT_DIR);
    expect(sheets).toHaveLength(3);
    expect(summary.aged_receivables.rows).toBe(agedReceivables(o).rows.length);
  });
});
