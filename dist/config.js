import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
/** Granular read-only scopes (required for Xero apps created on or after 2 March 2026). */
export const GRANULAR_SCOPES = [
    "openid", "profile", "email", "offline_access",
    "accounting.settings.read", "accounting.contacts.read", "accounting.invoices.read", "accounting.banktransactions.read",
    "accounting.reports.profitandloss.read", "accounting.reports.balancesheet.read", "accounting.reports.banksummary.read",
];
/** Legacy broad read-only scopes, for Xero apps created before 2 March 2026 (valid until 13 Sept 2027). */
export const BROAD_SCOPES = [
    "openid", "profile", "email", "offline_access",
    "accounting.settings.read", "accounting.contacts.read", "accounting.transactions.read", "accounting.reports.read",
];
const ALLOWED_SCOPE = /^(openid|profile|email|offline_access|accounting\.[a-z.]+\.read)$/;
export function loadConfig(env = process.env) {
    const home = path.join(os.homedir(), ".xero-aggregator");
    const scopes = env.XERO_SCOPES
        ? env.XERO_SCOPES.split(/[\s,]+/).filter(Boolean)
        : env.XERO_SCOPE_SET === "broad" ? BROAD_SCOPES : GRANULAR_SCOPES;
    const bad = scopes.filter((s) => !ALLOWED_SCOPE.test(s));
    if (bad.length)
        throw new Error(`Refusing non read-only Xero scopes: ${bad.join(", ")}`);
    if (!scopes.includes("offline_access"))
        scopes.push("offline_access");
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
    };
}
