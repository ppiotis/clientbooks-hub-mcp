import { appendFile, mkdir, readFile, chmod } from "node:fs/promises";
import path from "node:path";
export class AuditLog {
    file;
    ready;
    constructor(file) {
        this.file = file;
    }
    async write(e) {
        if (!this.ready)
            this.ready = mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }).then(() => undefined);
        await this.ready;
        await appendFile(this.file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
        await chmod(this.file, 0o600).catch(() => undefined);
    }
    async read(filter = {}) {
        let raw = "";
        try {
            raw = await readFile(this.file, "utf8");
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
        }
        const rows = raw.split("\n").filter(Boolean).map((l) => { try {
            return JSON.parse(l);
        }
        catch {
            return null;
        } }).filter((x) => !!x)
            .filter((r) => (!filter.tenant_id || r.tenant_id === filter.tenant_id) && (!filter.event || r.event === filter.event));
        return rows.slice(-(filter.limit ?? 50)).reverse();
    }
}
/** Wraps a source and counts GETs per tenant+endpoint, so each tool call can log exactly what it read. */
export class CountingSource {
    inner;
    counts = new Map();
    constructor(inner) {
        this.inner = inner;
    }
    get kind() { return this.inner.kind; }
    tenants() { return this.inner.tenants(); }
    async get(tenantId, resource, query) {
        const k = `${tenantId}|${resource}`;
        this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
        return this.inner.get(tenantId, resource, query);
    }
    get post() { return this.inner.post?.bind(this.inner); }
    /** Returns and resets the counts since the last drain. */
    drain() {
        const out = [...this.counts].map(([k, calls]) => { const [tenant_id, resource] = k.split("|"); return { tenant_id, resource, calls }; });
        this.counts.clear();
        return out;
    }
}
