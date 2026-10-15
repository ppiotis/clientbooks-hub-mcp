import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { decrypt, encrypt } from "./crypto.js";

export interface Tenant { tenantId: string; tenantName: string }
export interface Connection {
  id: string; // Xero connection id of the first tenant authorised in this grant
  tenants: Tenant[];
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scopes: string[];
  connectedAt: string;
}
/** The ONLY thing persisted to disk: OAuth tokens and tenant ids/names. Never financial data. */
export interface TokenFile { version: 1; connections: Connection[] }

export class TokenStore {
  constructor(private file: string, private key: string | undefined) {}

  private requireKey(): string {
    if (!this.key) throw new Error("Set XERO_AGG_TOKEN_KEY (16+ chars, e.g. `openssl rand -base64 32`) so Xero tokens can be encrypted at rest.");
    return this.key;
  }

  async load(): Promise<TokenFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: [] };
      throw e;
    }
    const data = JSON.parse(decrypt(raw, this.requireKey())) as TokenFile;
    if (data.version !== 1 || !Array.isArray(data.connections)) throw new Error("Unrecognised token file");
    return data;
  }

  async save(data: TokenFile): Promise<void> {
    const blob = encrypt(JSON.stringify(data), this.requireKey());
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, blob, { mode: 0o600 });
    await rename(tmp, this.file);
    await chmod(this.file, 0o600);
  }
}
