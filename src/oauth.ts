import { createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { Connection, Tenant, TokenStore } from "./tokens.js";

export const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
export const TOKEN_URL = "https://identity.xero.com/connect/token";
export const CONNECTIONS_URL = "https://api.xero.com/connections";
const PENDING_TTL_MS = 10 * 60_000;

export type FetchLike = typeof fetch;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

interface Pending { verifier: string; createdAt: number }

export class XeroOAuth {
  private pending = new Map<string, Pending>();
  private refreshing = new Map<string, Promise<Connection>>();

  constructor(private cfg: Config, private store: TokenStore, private fetchImpl: FetchLike = fetch) {}

  start(): { authorize_url: string; state: string; expires_in_seconds: number } {
    if (!this.cfg.clientId) throw new Error("XERO_CLIENT_ID is not set. Create a Xero app first (see README: Xero app setup).");
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("base64url");
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    this.pending.set(state, { verifier, createdAt: now });
    const u = new URL(AUTHORIZE_URL);
    u.search = new URLSearchParams({
      response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    return { authorize_url: u.toString(), state, expires_in_seconds: PENDING_TTL_MS / 1000 };
  }

  private async tokenRequest(params: Record<string, string>) {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const body = new URLSearchParams(params);
    if (this.cfg.clientSecret) headers.authorization = "Basic " + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    else body.set("client_id", this.cfg.clientId!);
    const res = await this.fetchImpl(TOKEN_URL, { method: "POST", headers, body });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Xero token endpoint returned ${res.status}: ${String(json.error ?? "unknown_error")}`);
    for (const k of ["access_token", "refresh_token", "expires_in"]) if (!json[k]) throw new Error(`Xero token response missing ${k}`);
    return json as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
  }

  /** Accepts the full redirect URL (or code + state) and stores the encrypted tokens. */
  async complete(input: { redirect_url?: string; code?: string; state?: string }): Promise<Connection> {
    let { code, state } = input;
    if (input.redirect_url) {
      const u = new URL(input.redirect_url);
      if (u.searchParams.get("error")) throw new Error(`Xero returned an error: ${u.searchParams.get("error")}`);
      code = u.searchParams.get("code") ?? undefined;
      state = u.searchParams.get("state") ?? undefined;
    }
    if (!code || !state) throw new Error("Need the redirect URL containing ?code=...&state=... (or both code and state)");
    const p = this.pending.get(state);
    if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) throw new Error("Unknown or expired state. Start again with connect_org_start.");
    this.pending.delete(state); // single use
    const tok = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri, code_verifier: p.verifier });
    return this.saveGrant(tok);
  }

  private async saveGrant(tok: { access_token: string; refresh_token: string; expires_in: number; scope?: string }): Promise<Connection> {
    const conns = await this.fetchImpl(CONNECTIONS_URL, { headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/json" } });
    if (!conns.ok) throw new Error(`Xero /connections returned ${conns.status}`);
    const list = (await conns.json()) as { id: string; tenantId: string; tenantName: string; tenantType: string }[];
    const tenants: Tenant[] = list.filter((c) => c.tenantType === "ORGANISATION").map((c) => ({ tenantId: c.tenantId, tenantName: c.tenantName }));
    if (!tenants.length) throw new Error("The Xero user did not authorise any organisation");
    const conn: Connection = {
      id: list[0].id, tenants, accessToken: tok.access_token, refreshToken: tok.refresh_token,
      expiresAt: Date.now() + Number(tok.expires_in) * 1000, scopes: (tok.scope ?? this.cfg.scopes.join(" ")).split(" "),
      connectedAt: new Date().toISOString(),
    };
    const data = await this.store.load();
    const ids = new Set(tenants.map((t) => t.tenantId));
    // Re-connecting an org replaces its previous grant.
    data.connections = data.connections
      .map((c) => ({ ...c, tenants: c.tenants.filter((t) => !ids.has(t.tenantId)) }))
      .filter((c) => c.tenants.length)
      .concat(conn);
    await this.store.save(data);
    return conn;
  }

  /** Imports an existing refresh token (e.g. for CI integration tests): refreshes it, discovers tenants, stores encrypted. */
  async importRefreshToken(refreshToken: string): Promise<Connection> {
    if (!this.cfg.clientId) throw new Error("XERO_CLIENT_ID is not set");
    const tok = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    return this.saveGrant(tok);
  }

  /** Returns a valid access token, refreshing (with refresh-token rotation) if within 60s of expiry. */
  async accessTokenFor(tenantId: string, force = false): Promise<string> {
    const data = await this.store.load();
    const conn = data.connections.find((c) => c.tenants.some((t) => t.tenantId === tenantId));
    if (!conn) throw new Error(`Tenant ${tenantId} is not connected`);
    if (!force && conn.expiresAt - Date.now() > 60_000) return conn.accessToken;
    let p = this.refreshing.get(conn.id);
    if (!p) {
      p = this.refresh(conn).finally(() => this.refreshing.delete(conn.id));
      this.refreshing.set(conn.id, p);
    }
    return (await p).accessToken;
  }

  private async refresh(conn: Connection): Promise<Connection> {
    const tok = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: conn.refreshToken });
    const data = await this.store.load();
    const target = data.connections.find((c) => c.id === conn.id);
    if (!target) throw new Error("Connection was removed during refresh");
    target.accessToken = tok.access_token;
    target.refreshToken = tok.refresh_token; // Xero rotates refresh tokens: the old one is now invalid.
    target.expiresAt = Date.now() + Number(tok.expires_in) * 1000;
    await this.store.save(data);
    return target;
  }

  async disconnect(tenantId: string): Promise<{ removed: boolean; revoked: boolean }> {
    const data = await this.store.load();
    const conn = data.connections.find((c) => c.tenants.some((t) => t.tenantId === tenantId));
    if (!conn) return { removed: false, revoked: false };
    let revoked = false;
    try {
      const token = await this.accessTokenFor(tenantId);
      const t = conn.tenants.find((x) => x.tenantId === tenantId);
      const list = await this.fetchImpl(CONNECTIONS_URL, { headers: { authorization: `Bearer ${token}` } });
      const match = ((await list.json()) as { id: string; tenantId: string }[]).find((c) => c.tenantId === t?.tenantId);
      if (match) revoked = (await this.fetchImpl(`${CONNECTIONS_URL}/${match.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).ok;
    } catch {
      revoked = false;
    }
    const fresh = await this.store.load();
    fresh.connections = fresh.connections.map((c) => ({ ...c, tenants: c.tenants.filter((t) => t.tenantId !== tenantId) })).filter((c) => c.tenants.length);
    await this.store.save(fresh);
    return { removed: true, revoked };
  }
}
