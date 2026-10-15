import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

/** Granular read-only scopes (required for Xero apps created on or after 2 March 2026). */
export const GRANULAR_SCOPES = [
  "openid", "profile", "email", "offline_access",
  "accounting.settings.read", "accounting.contacts.read", "accounting.invoices.read", "accounting.banktransactions.read",
  "accounting.reports.profitandloss.read", "accounting.reports.balancesheet.read", "accounting.reports.banksummary.read",
  "accounting.payments.read", "accounting.manualjournals.read", "accounting.reports.trialbalance.read", "accounting.reports.aged.read",
];
/** Legacy broad read-only scopes, for Xero apps created before 2 March 2026 (valid until 13 Sept 2027). */
export const BROAD_SCOPES = [
  "openid", "profile", "email", "offline_access",
  "accounting.settings.read", "accounting.contacts.read", "accounting.transactions.read", "accounting.reports.read",
];

/** Added to the read-only set only when XERO_AGG_ENABLE_WRITES=1 (draft manual journals). */
export const WRITE_SCOPE_GRANULAR = "accounting.manualjournals";
export const WRITE_SCOPE_BROAD = "accounting.transactions";
/** Optional extra read scopes used by v1.2 tools; each tool degrades gracefully if one was not granted. */
export const GRANULAR_EXTRA_READ = ["accounting.payments.read", "accounting.manualjournals.read", "accounting.reports.trialbalance.read", "accounting.reports.aged.read"];

export interface Config {
  demo: boolean;
  fixturesDir: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  tokenFile: string;
  tokenKey?: string;
  exportDir: string;
  syncMinutes: number;
  asOf?: string;
  writesEnabled: boolean;
  auditFile: string;
  scanMinutes: number;
  staleDays: number;
}

const ALLOWED_SCOPE = /^(openid|profile|email|offline_access|accounting\.[a-z.]+\.read)$/;
const WRITE_SCOPES = new Set([WRITE_SCOPE_GRANULAR, WRITE_SCOPE_BROAD]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = path.join(os.homedir(), ".xero-aggregator");
  const scopes = env.XERO_SCOPES
    ? env.XERO_SCOPES.split(/[\s,]+/).filter(Boolean)
    : [...(env.XERO_SCOPE_SET === "broad" ? BROAD_SCOPES : GRANULAR_SCOPES)]; // copy: never mutate the shared defaults
  const writesEnabled = env.XERO_AGG_ENABLE_WRITES === "1" || env.XERO_AGG_ENABLE_WRITES === "true";
  if (writesEnabled && !env.XERO_SCOPES) scopes.push(env.XERO_SCOPE_SET === "broad" ? WRITE_SCOPE_BROAD : WRITE_SCOPE_GRANULAR);
  const bad = scopes.filter((s) => !ALLOWED_SCOPE.test(s) && !(writesEnabled && WRITE_SCOPES.has(s)));
  if (bad.length) throw new Error(`Refusing non read-only Xero scopes: ${bad.join(", ")}${writesEnabled ? "" : " (set XERO_AGG_ENABLE_WRITES=1 to allow draft manual journals)"}`);
  if (!scopes.includes("offline_access")) scopes.push("offline_access");
  const demo = env.XERO_AGG_DEMO === "1" || env.XERO_AGG_DEMO === "true";
  const fixturesDir = env.XERO_AGG_FIXTURES ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  return {
    demo,
    fixturesDir,
    clientId: env.XERO_CLIENT_ID || undefined,
    clientSecret: env.XERO_CLIENT_SECRET || undefined,
    redirectUri: env.XERO_REDIRECT_URI ?? "http://localhost:5173/oauth/callback",
    scopes,
    tokenFile: env.XERO_AGG_TOKEN_FILE ?? path.join(home, "tokens.enc"),
    tokenKey: env.XERO_AGG_TOKEN_KEY || undefined,
    exportDir: path.resolve(env.XERO_AGG_EXPORT_DIR ?? path.join(home, "exports")),
    syncMinutes: env.XERO_AGG_SYNC_MINUTES === undefined ? 60 : Math.max(0, Number(env.XERO_AGG_SYNC_MINUTES) || 0),
    asOf: env.XERO_AGG_AS_OF ?? (demo ? "2026-09-30" : undefined),
    writesEnabled,
    auditFile: env.XERO_AGG_AUDIT_FILE ?? path.join(home, "audit.jsonl"),
    scanMinutes: env.XERO_AGG_SCAN_MINUTES === undefined ? 0 : Math.max(0, Number(env.XERO_AGG_SCAN_MINUTES) || 0),
    staleDays: Math.max(1, Number(env.XERO_AGG_STALE_DAYS ?? 7) || 7),
  };
}
