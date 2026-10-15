import { normalizeBankSummary, normalizeDirectorLoans, normalizeInvoices, normalizePnl, normalizeUnreconciled, } from "./normalize.js";
const pad = (n) => String(n).padStart(2, "0");
export function monthStart(iso) { return iso.slice(0, 8) + "01"; }
/** Last calendar day of the month containing iso (YYYY-MM-DD). */
export function monthEnd(iso) {
    const [y, m] = iso.slice(0, 7).split("-").map(Number);
    return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
export function todayIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/**
 * Xero builds MONTH comparatives by stepping both dates back a month, keeping the day number (clamped).
 * Anchored on a 30th (or Feb 28th), every prior 31-day month is cut to the 1st-30th (seen live: 30 Sep
 * as-of gave July as 1-30 Jul, losing 547.80 of income). So when the as-of month has fewer than 31 days we
 * anchor on the following month (always 31 days after a 30-day month or February), ask for one extra
 * period, and drop that future anchor column.
 */
export function pnlQuery(asOf) {
    const end = monthEnd(asOf);
    if (end.endsWith("-31"))
        return { query: { fromDate: monthStart(asOf), toDate: end, periods: "5", timeframe: "MONTH" }, shifted: false };
    const [y, m] = end.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const next = `${ny}-${pad(nm)}-01`;
    return { query: { fromDate: next, toDate: monthEnd(next), periods: "6", timeframe: "MONTH" }, shifted: true };
}
/** Drops the extra anchor month only if Xero actually returned it (7 columns); fixtures return 6. */
function dropAnchor(months) { return months.length === 7 ? months.slice(1) : months; }
async function allPages(src, tenantId, resource, key, query) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
        const data = await src.get(tenantId, resource, { ...query, page: String(page) });
        const list = data[key] ?? [];
        out.push(...list);
        if (list.length < 100)
            break;
    }
    return out;
}
export async function fetchOrg(src, tenantId, asOf) {
    const orgPayload = (await src.get(tenantId, "Organisation"));
    const org = orgPayload.Organisations?.[0] ?? {};
    const currency = String(org.BaseCurrency ?? "");
    const invoices = await allPages(src, tenantId, "Invoices", "Invoices", { Statuses: "AUTHORISED", pageSize: "100" });
    const contacts = await allPages(src, tenantId, "Contacts", "Contacts", { summaryOnly: "true", where: 'ContactStatus=="ACTIVE"' });
    const bankTx = await allPages(src, tenantId, "BankTransactions", "BankTransactions", { where: "IsReconciled==false" });
    const bankSummary = await src.get(tenantId, "Reports/BankSummary", { fromDate: monthStart(asOf), toDate: asOf });
    // Whole calendar months: Xero repeats the fromDate..toDate window for each comparison period, so a
    // mid-month toDate would turn every prior month into a half month (seen live against Demo Company).
    const pnlQ = pnlQuery(asOf);
    const pnlPayload = await src.get(tenantId, "Reports/ProfitAndLoss", pnlQ.query);
    const bs = await src.get(tenantId, "Reports/BalanceSheet", { date: asOf, periods: "5", timeframe: "MONTH" });
    const unrec = normalizeUnreconciled({ BankTransactions: bankTx });
    return {
        orgId: tenantId, name: String(org.Name ?? tenantId), currency, syncedAt: new Date().toISOString(), asOf,
        invoices: normalizeInvoices(tenantId, { Invoices: invoices }, currency),
        contacts: contacts.length,
        bank: normalizeBankSummary(bankSummary).map((b) => ({ ...b, unreconciledCount: unrec.get(b.id)?.count ?? 0, unreconciledAmount: unrec.get(b.id)?.amount ?? 0 })),
        pnl: pnlQ.shifted ? dropAnchor(normalizePnl(pnlPayload)) : normalizePnl(pnlPayload),
        directorLoans: normalizeDirectorLoans(bs),
    };
}
/** In-memory only cache of normalized data. Nothing here is ever written to disk. */
export class Cache {
    src;
    defaultAsOf;
    beforeSync;
    orgs = new Map();
    lastSync;
    running;
    timer;
    constructor(src, defaultAsOf, beforeSync) {
        this.src = src;
        this.defaultAsOf = defaultAsOf;
        this.beforeSync = beforeSync;
    }
    asOf(override) { return override ?? this.defaultAsOf ?? todayIso(); }
    sync(asOf) {
        if (!this.running)
            this.running = this.doSync(this.asOf(asOf)).finally(() => (this.running = undefined));
        return this.running;
    }
    async doSync(asOf) {
        if (this.beforeSync)
            await this.beforeSync();
        const tenants = await this.src.tenants();
        const res = { syncedAt: new Date().toISOString(), asOf, orgs: [] };
        const seen = new Set();
        for (const t of tenants) { // sequential: stays well inside Xero's 5-concurrent / 60-per-minute limits
            seen.add(t.tenantId);
            try {
                this.orgs.set(t.tenantId, await fetchOrg(this.src, t.tenantId, asOf));
                res.orgs.push({ orgId: t.tenantId, name: t.tenantName, ok: true });
            }
            catch (e) {
                res.orgs.push({ orgId: t.tenantId, name: t.tenantName, ok: false, error: e instanceof Error ? e.message : String(e) });
            }
        }
        for (const id of [...this.orgs.keys()])
            if (!seen.has(id))
                this.orgs.delete(id);
        this.lastSync = res;
        return res;
    }
    /** Ensures data exists for the requested as-of date. */
    async ensure(asOf) {
        const want = this.asOf(asOf);
        if (!this.lastSync || this.lastSync.asOf !== want)
            await this.sync(want);
        const list = [...this.orgs.values()];
        if (!list.length)
            throw new Error("No Xero organisations connected yet. Use connect_org_start to connect a client's org.");
        return list.sort((a, b) => a.name.localeCompare(b.name));
    }
    startPolling(minutes) {
        this.stopPolling();
        if (minutes <= 0)
            return;
        this.timer = setInterval(() => void this.sync().catch(() => undefined), minutes * 60_000);
        this.timer.unref();
    }
    stopPolling() { if (this.timer)
        clearInterval(this.timer); this.timer = undefined; }
    forget(orgId) { this.orgs.delete(orgId); }
}
