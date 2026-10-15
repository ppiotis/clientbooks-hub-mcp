import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { decrypt, encrypt } from "../src/crypto.js";
import { loadConfig } from "../src/config.js";
import { buildContext } from "../src/context.js";
import { pkcePair } from "../src/oauth.js";
import { LiveSource } from "../src/source.js";
import { fakeXero, rm, tmp } from "./helpers.js";

const KEY = "test-key-0123456789abcdef";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(rm));
function env(extra: Record<string, string> = {}) {
  const d = tmp();
  dirs.push(d);
  return { dir: d, env: { XERO_CLIENT_ID: "cid", XERO_AGG_TOKEN_FILE: path.join(d, "tokens.enc"), XERO_AGG_TOKEN_KEY: KEY, XERO_AGG_EXPORT_DIR: path.join(d, "exports"), XERO_AGG_AS_OF: "2026-09-30", XERO_AGG_SYNC_MINUTES: "0", ...extra } };
}
async function connect(ctx: ReturnType<typeof buildContext>) {
  const s = ctx.oauth.start();
  return ctx.oauth.complete({ redirect_url: `http://localhost:5173/oauth/callback?code=abc&state=${s.state}` });
}

describe("encryption at rest", () => {
  it("round-trips and rejects wrong key / tampering / short keys", () => {
    const blob = encrypt("secret-refresh-token", KEY);
    expect(blob).not.toContain("secret");
    expect(decrypt(blob, KEY)).toBe("secret-refresh-token");
    expect(() => decrypt(blob, "another-key-0123456789")).toThrow(/wrong XERO_AGG_TOKEN_KEY|tampered/);
    const parts = blob.split(".");
    parts[4] = Buffer.from("x" + Buffer.from(parts[4], "base64url").toString("latin1"), "latin1").toString("base64url");
    expect(() => decrypt(parts.join("."), KEY)).toThrow();
    expect(() => encrypt("x", "short")).toThrow(/16 characters/);
  });
});

describe("config", () => {
  it("defaults to granular read-only scopes with offline_access", () => {
    const c = loadConfig({});
    expect(c.scopes).toContain("offline_access");
    expect(c.scopes).toContain("accounting.invoices.read");
    expect(c.scopes.every((s) => !/\.(?!read)\w+$/.test(s) || ["openid", "profile", "email", "offline_access"].includes(s))).toBe(true);
    expect(loadConfig({ XERO_SCOPE_SET: "broad" }).scopes).toContain("accounting.transactions.read");
  });
  it("refuses write scopes", () => {
    expect(() => loadConfig({ XERO_SCOPES: "accounting.transactions offline_access" })).toThrow(/non read-only/);
    expect(() => loadConfig({ XERO_SCOPES: "payroll.employees" })).toThrow(/non read-only/);
  });
});

describe("OAuth2 PKCE + refresh rotation", () => {
  it("S256 challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
  it("authorize URL carries PKCE, state and read-only scopes", () => {
    const { env: e } = env();
    const ctx = buildContext(e, fakeXero().impl);
    const u = new URL(ctx.oauth.start().authorize_url);
    expect(u.origin + u.pathname).toBe("https://login.xero.com/identity/connect/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("scope")!.split(" ").every((s) => s.endsWith(".read") || ["openid", "profile", "email", "offline_access"].includes(s))).toBe(true);
  });
  it("exchanges code with verifier, stores only encrypted tokens, state is single-use", async () => {
    const { env: e, dir } = env();
    const fx = fakeXero();
    const ctx = buildContext(e, fx.impl);
    const s = ctx.oauth.start();
    const url = `http://localhost:5173/oauth/callback?code=abc&state=${s.state}`;
    const conn = await ctx.oauth.complete({ redirect_url: url });
    expect(conn.tenants.map((t) => t.tenantName)).toEqual(["Harbour Bakery Ltd", "Northwind Joinery Ltd"]);
    const body = new URLSearchParams(String(fx.calls[0].init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(body.get("client_id")).toBe("cid"); // public PKCE client: no secret
    await expect(ctx.oauth.complete({ redirect_url: url })).rejects.toThrow(/Unknown or expired state/);
    const raw = readFileSync(e.XERO_AGG_TOKEN_FILE, "utf8");
    expect(raw).not.toContain("at-1");
    expect(raw).not.toContain("rt-1");
    expect(statSync(e.XERO_AGG_TOKEN_FILE).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["tokens.enc"]);
  });
  it("uses HTTP Basic when a client secret is configured", async () => {
    const { env: e } = env({ XERO_CLIENT_SECRET: "shh" });
    const fx = fakeXero();
    await connect(buildContext(e, fx.impl));
    expect(new Headers(fx.calls[0].init!.headers).get("authorization")).toBe("Basic " + Buffer.from("cid:shh").toString("base64"));
  });
  it("rejects bad redirects", async () => {
    const { env: e } = env();
    const ctx = buildContext(e, fakeXero().impl);
    await expect(ctx.oauth.complete({ redirect_url: "http://localhost/cb?error=access_denied" })).rejects.toThrow(/access_denied/);
    await expect(ctx.oauth.complete({ redirect_url: "http://localhost/cb?code=x&state=forged" })).rejects.toThrow(/state/);
  });
  it("refreshes near expiry, persists the ROTATED refresh token, de-duplicates concurrent refreshes", async () => {
    const { env: e } = env();
    const fx = fakeXero();
    const ctx = buildContext(e, fx.impl);
    await connect(ctx);
    const data = await ctx.store.load();
    data.connections[0].expiresAt = Date.now() - 1;
    await ctx.store.save(data);
    const [a, b] = await Promise.all([ctx.oauth.accessTokenFor("tid-bakery"), ctx.oauth.accessTokenFor("tid-joinery")]);
    expect(a).toBe("at-2");
    expect(b).toBe("at-2");
    const refreshCalls = fx.calls.filter((c) => c.url.includes("/connect/token") && String(c.init!.body).includes("refresh_token"));
    expect(refreshCalls).toHaveLength(1);
    expect(String(refreshCalls[0].init!.body)).toContain("refresh_token=rt-1");
    expect((await ctx.store.load()).connections[0].refreshToken).toBe("rt-2");
  });
  it("requires a token key before storing anything", async () => {
    const { env: e } = env({ XERO_AGG_TOKEN_KEY: "" });
    const ctx = buildContext(e, fakeXero().impl);
    await expect(connect(ctx)).rejects.toThrow(/XERO_AGG_TOKEN_KEY/);
  });
});

describe("live code path against recorded responses", () => {
  it("syncs both orgs, keeps financial data in memory only", async () => {
    const { env: e, dir } = env();
    const fx = fakeXero();
    const ctx = buildContext(e, fx.impl);
    await connect(ctx);
    const res = await ctx.cache.sync();
    expect(res.orgs.every((o) => o.ok)).toBe(true);
    expect(ctx.cache.orgs.get("tid-joinery")!.invoices.filter((i) => i.kind === "receivable")).toHaveLength(6);
    const apiCalls = fx.calls.filter((c) => c.url.includes("api.xro"));
    expect(apiCalls.every((c) => new Headers(c.init!.headers).get("xero-tenant-id"))).toBe(true);
    expect(apiCalls.every((c) => (c.init?.method ?? "GET") === "GET")).toBe(true);
    expect(apiCalls.some((c) => c.url.includes("Statuses=AUTHORISED"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["tokens.enc"]); // nothing financial on disk
    expect(readFileSync(e.XERO_AGG_TOKEN_FILE, "utf8")).not.toMatch(/Oakridge|INV-B101/);
  });
  it("retries once on 401 with a forced refresh, honours Retry-After on 429", async () => {
    const { env: e } = env();
    const fx = fakeXero();
    let first401 = true, first429 = true;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("Organisation") && first401) { first401 = false; return new Response("{}", { status: 401 }); }
      if (u.includes("Contacts") && first429) { first429 = false; return new Response("{}", { status: 429, headers: { "retry-after": "0" } }); }
      return fx.impl(input, init);
    }) as typeof fetch;
    const ctx = buildContext(e, impl);
    await connect(ctx);
    const live = new LiveSource(ctx.store, ctx.oauth, impl);
    expect(((await live.get("tid-bakery", "Organisation")) as { Organisations: unknown[] }).Organisations).toHaveLength(1);
    expect(((await live.get("tid-bakery", "Contacts")) as { Contacts: unknown[] }).Contacts.length).toBeGreaterThan(0);
    expect(fx.calls.filter((c) => String(c.init?.body ?? "").includes("grant_type=refresh_token"))).toHaveLength(1);
  });
  it("disconnect revokes the Xero connection and removes tokens", async () => {
    const { env: e } = env();
    const fx = fakeXero();
    const ctx = buildContext(e, fx.impl);
    await connect(ctx);
    expect(await ctx.oauth.disconnect("tid-joinery")).toEqual({ removed: true, revoked: true });
    expect(fx.calls.some((c) => c.init?.method === "DELETE" && c.url.endsWith("/connections/conn-1"))).toBe(true);
    expect((await ctx.source.tenants()).map((t) => t.tenantName)).toEqual(["Harbour Bakery Ltd"]);
  });
  it("token file tampering is detected", async () => {
    const { env: e } = env();
    const ctx = buildContext(e, fakeXero().impl);
    await connect(ctx);
    writeFileSync(e.XERO_AGG_TOKEN_FILE, readFileSync(e.XERO_AGG_TOKEN_FILE, "utf8").slice(0, -4) + "AAAA");
    await expect(ctx.store.load()).rejects.toThrow(/decrypt/);
  });
});

describe("refresh-token import", () => {
  it("imports a refresh token and stores the rotated one", async () => {
    const { env: e } = env();
    const ctx = buildContext(e, fakeXero().impl);
    const conn = await ctx.oauth.importRefreshToken("seed-rt");
    expect(conn.tenants).toHaveLength(2);
    expect((await ctx.store.load()).connections[0].refreshToken).toBe("rt-1");
  });
});
