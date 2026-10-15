import { appendFile, mkdir, readFile, chmod } from "node:fs/promises";
import path from "node:path";
import type { XeroSource } from "./source.js";
import type { Tenant } from "./tokens.js";

/**
 * Local append-only audit trail (JSON Lines, file mode 0600). Records WHAT was read (endpoint, tenant,
 * call count) and every write-back proposal / confirmation / refusal. Reads are metadata only (no
 * figures); proposals contain the journal lines the accountant asked for, because that is the point
 * of an audit trail. Never contains tokens.
 */
export interface AuditEntry { ts: string; event: string; tool?: string; tenant_id?: string; org?: string; [k: string]: unknown }

export class AuditLog {
  private ready?: Promise<void>;
  constructor(public file: string) {}
  async write(e: Omit<AuditEntry, "ts">): Promise<void> {
    if (!this.ready) this.ready = mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }).then(() => undefined);
    await this.ready;
    await appendFile(this.file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
    await chmod(this.file, 0o600).catch(() => undefined);
  }
  async read(filter: { tenant_id?: string; event?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    let raw = "";
    try { raw = await readFile(this.file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const rows = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as AuditEntry; } catch { return null; } }).filter((x): x is AuditEntry => !!x)
      .filter((r) => (!filter.tenant_id || r.tenant_id === filter.tenant_id) && (!filter.event || r.event === filter.event));
    return rows.slice(-(filter.limit ?? 50)).reverse();
  }
}

/** Wraps a source and counts GETs per tenant+endpoint, so each tool call can log exactly what it read. */
export class CountingSource implements XeroSource {
  counts = new Map<string, number>();
  constructor(public inner: XeroSource) {}
  get kind() { return this.inner.kind; }
  tenants(): Promise<Tenant[]> { return this.inner.tenants(); }
  async get(tenantId: string, resource: string, query?: Record<string, string>) {
    const k = `${tenantId}|${resource}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    return this.inner.get(tenantId, resource, query);
  }
  get post() { return this.inner.post?.bind(this.inner); }
  /** Returns and resets the counts since the last drain. */
  drain(): { tenant_id: string; resource: string; calls: number }[] {
    const out = [...this.counts].map(([k, calls]) => { const [tenant_id, resource] = k.split("|"); return { tenant_id, resource, calls }; });
    this.counts.clear();
    return out;
  }
}
