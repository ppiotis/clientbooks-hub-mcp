import { round2 } from "./normalize.js";
export const DAY = 86_400_000;
export function daysBetween(fromIso, toIso) {
    return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / DAY);
}
export const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"];
export function bucketOf(daysOverdue) {
    if (daysOverdue <= 0)
        return "current";
    if (daysOverdue <= 30)
        return "1-30";
    if (daysOverdue <= 60)
        return "31-60";
    if (daysOverdue <= 90)
        return "61-90";
    return "90+";
}
const sum = (xs) => round2(xs.reduce((a, b) => a + b, 0));
export function agedReceivables(o) {
    const rows = o.invoices.filter((i) => i.kind === "receivable").map((i) => {
        const days = daysBetween(i.dueDate, o.asOf);
        return { ...i, daysOverdue: Math.max(0, days), bucket: bucketOf(days) };
    }).sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number));
    const totals = Object.fromEntries(BUCKETS.map((b) => [b, sum(rows.filter((r) => r.bucket === b).map((r) => r.amountDue))]));
    return { rows, totals, total: sum(rows.map((r) => r.amountDue)) };
}
export function overdueAcross(orgs, minDays) {
    const items = orgs.flatMap((o) => agedReceivables(o).rows.filter((r) => r.daysOverdue > minDays).map((r) => ({
        org: o.name, invoice: r.number, contact: r.contact, due_date: r.dueDate, days_overdue: r.daysOverdue, amount_due: r.amountDue, currency: r.currency,
    }))).sort((a, b) => b.days_overdue - a.days_overdue);
    const byCurrency = {};
    for (const i of items)
        byCurrency[i.currency] = round2((byCurrency[i.currency] ?? 0) + i.amount_due);
    const byOrg = orgs.map((o) => {
        const mine = items.filter((i) => i.org === o.name);
        return { org: o.name, count: mine.length, amount_due: sum(mine.map((i) => i.amount_due)), currency: o.currency };
    }).filter((x) => x.count > 0);
    return { min_days_overdue: minDays, count: items.length, totals_by_currency: byCurrency, by_org: byOrg, invoices: items };
}
export function nextPayrollDate(asOf, day = 25) {
    const [y, m, d] = asOf.split("-").map(Number);
    const pad = (n) => String(n).padStart(2, "0");
    if (d < day)
        return `${y}-${pad(m)}-${pad(day)}`;
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    return `${ny}-${pad(nm)}-${pad(day)}`;
}
export function payrollRisk(o, profile = {}) {
    const cash = sum(o.bank.map((b) => b.closingBalance));
    const recent = o.pnl.slice(0, 3).map((m) => m.payroll);
    const estimated = recent.length ? round2(recent.reduce((a, b) => a + b, 0) / recent.length) : 0;
    const payroll = profile.amount ?? estimated;
    const payrollDate = profile.nextDate ?? nextPayrollDate(o.asOf);
    const committed = o.invoices.filter((i) => i.kind === "payable" && i.dueDate <= payrollDate);
    const committedBills = sum(committed.map((i) => i.amountDue));
    const available = round2(cash - committedBills);
    const coverage = payroll > 0 ? round2(available / payroll) : null;
    return {
        org: o.name, currency: o.currency, cash, committed_bills: committedBills, committed_bill_count: committed.length,
        payroll_amount: payroll, payroll_source: profile.amount !== undefined ? "set_payroll_profile" : "average wages/salaries lines, last 3 P&L months",
        next_payroll_date: payrollDate, headroom: round2(available - payroll), coverage_ratio: coverage,
        status: coverage === null ? "no payroll found" : coverage < 1 ? "SHORTFALL" : coverage < 1.5 ? "tight" : "ok",
        formula: `coverage = (cash ${cash} - bills due on or before ${payrollDate} ${committedBills}) / payroll ${payroll} = ${coverage}; headroom = ${available} - ${payroll} = ${round2(available - payroll)}`,
    };
}
export function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
export function sampleSd(xs) { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); }
/** DSO = receivables outstanding / income for the last 3 P&L months x days in those months. */
export function dso(o) {
    const ar = sum(o.invoices.filter((i) => i.kind === "receivable").map((i) => i.amountDue));
    const months = o.pnl.slice(0, 3);
    const income = sum(months.map((m) => m.income));
    const days = monthDays(o.asOf, months.length);
    return { receivables: ar, income_last_3_months: income, days_in_period: days, dso_days: income > 0 ? Math.round((ar / income) * days * 10) / 10 : null };
}
function monthDays(asOf, n) {
    let [y, m] = asOf.split("-").map(Number);
    let total = 0;
    for (let i = 0; i < n; i++) {
        total += new Date(Date.UTC(y, m, 0)).getUTCDate();
        m -= 1;
        if (m === 0) {
            m = 12;
            y -= 1;
        }
    }
    return total;
}
export const RULES = {
    overdue90: { points: 15, text: "More than 10% of receivables are over 90 days overdue" },
    payrollShort: { points: 25, text: "Payroll coverage below 1.0 (cannot cover next payroll after committed bills)" },
    payrollTight: { points: 10, text: "Payroll coverage between 1.0 and 1.5" },
    expenseSpike: { points: 15, text: "Latest month expenses z-score >= 2.0 vs trailing months (sample std dev, needs 3+ trailing months)" },
    directorLoan: { points: 15, text: "Director loan balance (absolute) grew in each of the last 3 months" },
    dso: { points: 10, text: "DSO above 60 days" },
    unreconciled: { points: 10, text: "Unreconciled bank items exceed 10% of cash" },
    revenueDecline: { points: 10, text: "Income fell in each of the last 3 months" },
};
export function health(o, profile) {
    const flags = [];
    const add = (k, detail) => flags.push({ rule: RULES[k].text, points: RULES[k].points, detail });
    const aged = agedReceivables(o);
    if (aged.total > 0 && aged.totals["90+"] / aged.total > 0.1)
        add("overdue90", `${aged.totals["90+"]} of ${aged.total} (${Math.round((aged.totals["90+"] / aged.total) * 1000) / 10}%) is 90+ days`);
    const p = payrollRisk(o, profile);
    if (p.coverage_ratio !== null && p.coverage_ratio < 1)
        add("payrollShort", `coverage ${p.coverage_ratio}`);
    else if (p.coverage_ratio !== null && p.coverage_ratio < 1.5)
        add("payrollTight", `coverage ${p.coverage_ratio}`);
    let expenseZ = null;
    if (o.pnl.length >= 4) {
        const trailing = o.pnl.slice(1).map((m) => m.expenses);
        const sd = sampleSd(trailing);
        expenseZ = sd > 0 ? Math.round(((o.pnl[0].expenses - mean(trailing)) / sd) * 100) / 100 : null;
        if (expenseZ !== null && expenseZ >= 2)
            add("expenseSpike", `${o.pnl[0].label} expenses ${o.pnl[0].expenses} vs trailing mean ${round2(mean(trailing))} (sd ${round2(sd)}), z = ${expenseZ}`);
    }
    for (const dl of o.directorLoans) {
        const b = dl.balances.map(Math.abs);
        if (b.length >= 4 && b[0] > b[1] && b[1] > b[2] && b[2] > b[3])
            add("directorLoan", `${dl.name}: ${b[3]} -> ${b[2]} -> ${b[1]} -> ${b[0]}`);
    }
    const d = dso(o);
    if (d.dso_days !== null && d.dso_days > 60)
        add("dso", `DSO ${d.dso_days} days`);
    const unrec = sum(o.bank.map((b) => b.unreconciledAmount));
    if (p.cash > 0 ? unrec / p.cash > 0.1 : unrec > 0)
        add("unreconciled", `${unrec} unreconciled vs cash ${p.cash}`);
    const inc = o.pnl.map((m) => m.income);
    if (inc.length >= 4 && inc[0] < inc[1] && inc[1] < inc[2] && inc[2] < inc[3])
        add("revenueDecline", `${inc[3]} -> ${inc[2]} -> ${inc[1]} -> ${inc[0]}`);
    const score = Math.max(0, 100 - flags.reduce((a, f) => a + f.points, 0));
    return { org: o.name, score, band: score >= 80 ? "healthy" : score >= 60 ? "watch" : "at risk", flags, metrics: { expense_z_score: expenseZ, payroll_coverage: p.coverage_ratio, dso_days: d.dso_days, unreconciled_amount: unrec } };
}
export function practiceDashboard(orgs, months, profiles) {
    const per = orgs.map((o) => {
        const ms = o.pnl.slice(0, months);
        return { org: o.name, currency: o.currency, revenue: sum(ms.map((m) => m.income)), months_available: ms.length, dso_days: dso(o).dso_days, health: health(o, profiles.get(o.orgId)) };
    });
    const revenueByCurrency = {};
    for (const p of per)
        revenueByCurrency[p.currency] = round2((revenueByCurrency[p.currency] ?? 0) + p.revenue);
    const dsos = per.map((p) => p.dso_days).filter((x) => x !== null);
    return {
        clients: orgs.length, months,
        total_revenue_by_currency: revenueByCurrency,
        average_dso_days: dsos.length ? Math.round(mean(dsos) * 10) / 10 : null,
        dso_note: "Simple average of each client's DSO (receivables / last-3-month income x days).",
        per_client: per.map((p) => ({ org: p.org, currency: p.currency, revenue: p.revenue, months_available: p.months_available, dso_days: p.dso_days, health_score: p.health.score, band: p.health.band })),
    };
}
export function trendingTrouble(orgs, profiles, threshold = 80) {
    const list = orgs.map((o) => health(o, profiles.get(o.orgId))).filter((h) => h.score < threshold).sort((a, b) => a.score - b.score);
    return { threshold, count: list.length, clients: list.map((h) => ({ org: h.org, score: h.score, band: h.band, reasons: h.flags.map((f) => `${f.rule} (-${f.points}): ${f.detail}`) })) };
}
