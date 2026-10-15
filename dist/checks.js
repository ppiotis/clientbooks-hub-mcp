/** Practice-wide data-quality and month-end checks. Pure functions over pulled data; unit tested. */
import { daysBetween } from "./analytics.js";
import { num, round2, xeroDate } from "./normalize.js";
import { deepLink, flattenReport } from "./pull.js";
export const CHECKS = ["unreconciled_bank", "unreconciled_payment", "duplicate_invoice", "duplicate_payment", "missing_tax_code", "tax_anomaly", "missing_attachment",
    "large_variance", "stale_draft", "suspense_balance", "lock_date", "negative_bank", "overdue_payables", "overdue_tax_liability"];
const SEV_RANK = { high: 3, medium: 2, low: 1 };
export const DEFAULT_SCAN = { staleDays: 7, attachmentThreshold: 500, varianceMinAmount: 1000, variancePct: 50, draftAgeDays: 30 };
const LIVE = (s) => s !== "DELETED" && s !== "VOIDED";
const d = (x) => xeroDate(x?.DateString) ?? xeroDate(x?.Date) ?? "";
const dueOf = (x) => xeroDate(x?.DueDateString) ?? xeroDate(x?.DueDate) ?? "";
const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s\-_/#.]+/g, "");
const TAX_AUTHORITY = /^(hmrc|hm revenue|ato|australian taxation|ird|inland revenue|sars|irs|cra|revenue canada)/i;
const INCOME_TYPES = new Set(["REVENUE", "SALES", "OTHERINCOME"]);
const NO_TAX = new Set(["NONE", "BASEXCLUDED", "NOTAX", "EXEMPTEXPENSES"]);
const SUSPENSE = /(suspense|clearing|uncategori[sz]ed|unknown|ask my accountant)/i;
export function taxRegistered(det) {
    return Boolean(det.meta.taxNumber) || det.taxRates.some((r) => num(r.EffectiveRate) > 0 && r.Status !== "DELETED");
}
export function scanOrg(det, snap, opt = DEFAULT_SCAN) {
    const { meta, asOf } = det;
    const cur = meta.currency;
    const out = [];
    const want = (c) => !opt.checks?.length || opt.checks.includes(c);
    const base = { org: meta.name, tenant_id: det.tenantId, currency: cur };
    const age = (iso) => (iso ? daysBetween(iso, asOf) : 0);
    const invKind = (i) => (i.Type === "ACCPAY" ? "bill" : "invoice");
    const docName = (i) => `${i.Type === "ACCPAY" ? "Bill" : "Invoice"} ${i.InvoiceNumber || i.Reference || i.InvoiceID}`;
    const accounts = new Map(det.accounts.map((a) => [String(a.Code), a]));
    const rates = new Map(det.taxRates.map((r) => [String(r.TaxType), num(r.EffectiveRate)]));
    const registered = taxRegistered(det);
    // 1. Unreconciled bank transactions / payments older than N days
    if (want("unreconciled_bank"))
        for (const t of det.bankTx) {
            if (t.IsReconciled !== false || !LIVE(t.Status))
                continue;
            const days = age(d(t));
            if (days <= opt.staleDays)
                continue;
            const amt = Math.abs(num(t.Total));
            out.push({ ...base, check: "unreconciled_bank", severity: days > 30 || amt >= 1000 ? "high" : "medium", date: d(t),
                title: `Unreconciled ${t.Type === "RECEIVE" ? "receipt" : "payment"} ${days} days old`, detail: `${t.BankAccount?.Name ?? "Bank"}: ${t.Contact?.Name ? `${t.Contact.Name} ` : ""}${round2(amt)} on ${d(t)}${t.Reference ? ` (ref ${t.Reference})` : ""}`,
                value_at_risk: round2(amt), reference: { type: "BankTransaction", id: t.BankTransactionID }, xero_link: deepLink(meta, "bank_transaction", t.BankTransactionID),
                suggested_fix: "Match it to the bank statement line in Reconcile, or delete it if it was entered twice." });
        }
    if (want("unreconciled_payment"))
        for (const p of det.payments) {
            if (p.IsReconciled !== false || !LIVE(p.Status ?? "AUTHORISED"))
                continue;
            const days = age(d(p));
            if (days <= opt.staleDays)
                continue;
            out.push({ ...base, check: "unreconciled_payment", severity: "medium", date: d(p), title: `Invoice payment not reconciled (${days} days)`,
                detail: `${round2(num(p.Amount))} against ${p.Invoice?.InvoiceNumber ?? "an invoice"} (${p.Invoice?.Contact?.Name ?? ""}) on ${d(p)}`, value_at_risk: round2(num(p.Amount)),
                reference: { type: "Payment", id: p.PaymentID, number: p.Invoice?.InvoiceNumber }, xero_link: deepLink(meta, "payment", p.PaymentID),
                suggested_fix: "Find the matching statement line; if there is none the payment may be a duplicate or recorded on the wrong date." });
        }
    // 2. Potential duplicate invoices / bills
    // Same contact + amount repeating 3+ times in the window is a recurring charge (rent, subscriptions,
    // weekly cleaning, daily parking), not a duplicate. Seen live in Demo Company; suppressed unless the
    // copies are within 3 days AND carry the same number/reference.
    const recurring = (list, key) => {
        const m = new Map();
        for (const x of list)
            m.set(key(x), (m.get(key(x)) ?? 0) + 1);
        return (x) => (m.get(key(x)) ?? 0) >= 3;
    };
    if (want("duplicate_invoice")) {
        const live = det.invoices.filter((i) => LIVE(i.Status));
        const isRecurring = recurring(live, (i) => `${i.Type}|${i.Contact?.ContactID}|${round2(num(i.Total))}`);
        const seen = new Set();
        for (let a = 0; a < live.length; a++)
            for (let b = a + 1; b < live.length; b++) {
                const x = live[a], y = live[b];
                if (x.Type !== y.Type || x.Contact?.ContactID !== y.Contact?.ContactID || round2(num(x.Total)) !== round2(num(y.Total)))
                    continue;
                const sameNo = norm(x.InvoiceNumber) && norm(x.InvoiceNumber) === norm(y.InvoiceNumber);
                const sameRef = norm(x.Reference) && norm(x.Reference) === norm(y.Reference);
                const gap = Math.abs(daysBetween(d(x), d(y)));
                const match = isRecurring(x) ? (sameNo || sameRef) && gap <= 3 : ((sameNo || sameRef) && gap <= 14) || gap <= 3;
                if (!match || seen.has(y.InvoiceID))
                    continue;
                seen.add(y.InvoiceID);
                const later = d(y) >= d(x) ? y : x, first = later === y ? x : y;
                out.push({ ...base, check: "duplicate_invoice", severity: x.Type === "ACCPAY" ? "high" : "medium", date: d(later),
                    title: `Possible duplicate ${x.Type === "ACCPAY" ? "bill" : "invoice"}: ${x.Contact?.Name} ${round2(num(x.Total))}`,
                    detail: `${docName(first)} (${d(first)}, ${first.Status}) and ${docName(later)} (${d(later)}, ${later.Status}): same contact and amount${sameNo ? ", same number" : sameRef ? ", same reference" : ""}, ${gap} day(s) apart`,
                    value_at_risk: round2(num(later.Total)), reference: { type: x.Type === "ACCPAY" ? "Bill" : "Invoice", id: later.InvoiceID, number: later.InvoiceNumber },
                    xero_link: deepLink(meta, invKind(later), later.InvoiceID), suggested_fix: `Compare with ${docName(first)}; if it is the same document, void the later one before it is paid${x.Type === "ACCPAY" ? " (double-payment risk)" : ""}.` });
            }
    }
    // 3. Potential duplicate payments / bank transactions
    if (want("duplicate_payment")) {
        const pays = det.payments.filter((p) => LIVE(p.Status ?? "AUTHORISED"));
        for (let a = 0; a < pays.length; a++)
            for (let b = a + 1; b < pays.length; b++) {
                const x = pays[a], y = pays[b];
                if (!x.Invoice?.InvoiceID || x.Invoice.InvoiceID !== y.Invoice?.InvoiceID || round2(num(x.Amount)) !== round2(num(y.Amount)))
                    continue;
                if (Math.abs(daysBetween(d(x), d(y))) > 14)
                    continue;
                out.push({ ...base, check: "duplicate_payment", severity: "high", date: d(y), title: `Same payment recorded twice on ${x.Invoice.InvoiceNumber}`,
                    detail: `${round2(num(x.Amount))} on ${d(x)} and again on ${d(y)} against ${x.Invoice.InvoiceNumber} (${x.Invoice.Contact?.Name ?? ""})`, value_at_risk: round2(num(y.Amount)),
                    reference: { type: "Payment", id: y.PaymentID, number: x.Invoice.InvoiceNumber }, xero_link: deepLink(meta, "payment", y.PaymentID),
                    suggested_fix: "Check the bank statement: if only one receipt arrived, remove the unreconciled payment (the invoice will then show as overpaid/credit until fixed)." });
            }
        const txs = det.bankTx.filter((t) => LIVE(t.Status));
        const txRecurring = recurring(txs, (t) => `${t.Type}|${t.Contact?.ContactID}|${round2(num(t.Total))}`);
        for (let a = 0; a < txs.length; a++)
            for (let b = a + 1; b < txs.length; b++) {
                const x = txs[a], y = txs[b];
                if (x.Type !== y.Type || x.Contact?.ContactID !== y.Contact?.ContactID || !x.Contact?.ContactID || round2(num(x.Total)) !== round2(num(y.Total)))
                    continue;
                const sameRef = norm(x.Reference) && norm(x.Reference) === norm(y.Reference);
                if (Math.abs(daysBetween(d(x), d(y))) > 3 || (txRecurring(x) && !sameRef))
                    continue;
                out.push({ ...base, check: "duplicate_payment", severity: "medium", date: d(y), title: `Possible duplicate ${y.Type === "SPEND" ? "spend" : "receive"} money: ${y.Contact.Name} ${round2(num(y.Total))}`,
                    detail: `Bank transactions on ${d(x)} and ${d(y)} with same contact and amount`, value_at_risk: round2(num(y.Total)), reference: { type: "BankTransaction", id: y.BankTransactionID },
                    xero_link: deepLink(meta, "bank_transaction", y.BankTransactionID), suggested_fix: "If the statement shows one transaction, delete the unreconciled copy." });
            }
    }
    // 4/5. Tax codes on lines (invoices, bills, bank transactions)
    const lineDocs = [
        ...det.invoices.filter((i) => ["AUTHORISED", "PAID", "SUBMITTED"].includes(i.Status)).map((i) => ({ doc: i, kind: invKind(i), id: i.InvoiceID, label: docName(i) })),
        ...det.bankTx.filter((t) => LIVE(t.Status)).map((t) => ({ doc: t, kind: "bank_transaction", id: t.BankTransactionID, label: `Bank ${t.Type === "SPEND" ? "spend" : "receive"} ${t.Contact?.Name ?? ""} ${d(t)}` })),
    ];
    for (const { doc, kind, id, label } of lineDocs) {
        if (doc.LineAmountTypes === "NoTax")
            continue;
        for (const l of doc.LineItems ?? []) {
            const amt = round2(Math.abs(num(l.LineAmount)));
            const acc = accounts.get(String(l.AccountCode ?? ""));
            const where = { reference: { type: kind === "bank_transaction" ? "BankTransaction" : kind === "bill" ? "Bill" : "Invoice", id, number: doc.InvoiceNumber }, xero_link: deepLink(meta, kind, id), date: d(doc) };
            if (!l.TaxType) {
                if (want("missing_tax_code"))
                    out.push({ ...base, ...where, check: "missing_tax_code", severity: registered ? "high" : "medium", title: `Missing tax code on ${label}`,
                        detail: `Line "${l.Description ?? ""}" (${l.AccountCode ?? "no account"}) ${amt} has no tax rate`, value_at_risk: amt,
                        suggested_fix: `Set the tax rate${acc?.TaxType ? ` (account ${acc.Code} defaults to ${acc.TaxType})` : ""} before the ${meta.country === "AU" ? "BAS" : "VAT/GST return"} is prepared.` });
                continue;
            }
            if (!want("tax_anomaly") || !registered)
                continue;
            if (acc && INCOME_TYPES.has(acc.Type) && NO_TAX.has(l.TaxType)) {
                const r = rates.get(String(acc.TaxType)) ?? 0;
                out.push({ ...base, ...where, check: "tax_anomaly", severity: "medium", title: `Income coded ${l.TaxType} on ${label}`,
                    detail: `Sales line ${amt} on ${acc.Code} ${acc.Name} uses ${l.TaxType} (account default ${acc.TaxType}); output tax may be understated`, value_at_risk: round2(amt * r / 100) || amt,
                    suggested_fix: `Confirm the supply really is outside the scope of tax; otherwise recode to ${acc.TaxType}.` });
                continue;
            }
            const rate = rates.get(String(l.TaxType));
            if (rate !== undefined && doc.LineAmountTypes === "Exclusive" && l.TaxAmount !== undefined) {
                const expected = round2(num(l.LineAmount) * rate / 100);
                const diff = round2(Math.abs(expected - num(l.TaxAmount)));
                if (diff > 0.05 && diff > Math.abs(expected) * 0.01) {
                    out.push({ ...base, ...where, check: "tax_anomaly", severity: "medium", title: `Tax amount doesn't match rate on ${label}`,
                        detail: `${l.TaxType} at ${rate}% on ${round2(num(l.LineAmount))} should be ${expected}, Xero shows ${round2(num(l.TaxAmount))}`, value_at_risk: diff,
                        suggested_fix: "Check the supplier document: correct the tax amount (or the rate) so the return matches the source document." });
                    continue;
                }
            }
            if (acc?.TaxType && acc.TaxType !== l.TaxType && !(NO_TAX.has(acc.TaxType) && NO_TAX.has(l.TaxType))) {
                out.push({ ...base, ...where, check: "tax_anomaly", severity: "low", title: `Unusual tax code on ${label}`,
                    detail: `${l.AccountCode} ${acc.Name} normally uses ${acc.TaxType}, this line uses ${l.TaxType}`, value_at_risk: 0, suggested_fix: "Confirm the tax treatment is intentional." });
            }
        }
    }
    // 6. Missing source documents (attachments) on spends/bills above a threshold
    if (want("missing_attachment")) {
        const docs = [...det.invoices.filter((i) => i.Type === "ACCPAY" && ["AUTHORISED", "PAID"].includes(i.Status)).map((i) => ({ x: i, kind: "bill", id: i.InvoiceID, label: docName(i) })),
            ...det.bankTx.filter((t) => t.Type === "SPEND" && LIVE(t.Status)).map((t) => ({ x: t, kind: "bank_transaction", id: t.BankTransactionID, label: `Spend money ${t.Contact?.Name ?? ""} ${d(t)}` }))];
        for (const { x, kind, id, label } of docs) {
            const amt = Math.abs(num(x.Total));
            if (x.HasAttachments !== false || amt < opt.attachmentThreshold)
                continue;
            out.push({ ...base, check: "missing_attachment", severity: amt >= 2000 ? "medium" : "low", date: d(x), title: `No receipt/invoice attached: ${label}`, detail: `${round2(amt)} with no attachment in Xero`,
                value_at_risk: round2(amt), reference: { type: kind === "bill" ? "Bill" : "BankTransaction", id, number: x.InvoiceNumber }, xero_link: deepLink(meta, kind, id),
                suggested_fix: "Request the source document from the client (needed to support the tax claim) and attach it in Xero." });
        }
    }
    // 7. Large / unusual P&L variances: latest month vs average of the 3 before
    const closed = snap ? closedMonths(snap) : [];
    if (want("large_variance") && closed.length >= 4) {
        const [latest, ...prior] = closed;
        const names = [...new Set(latest.lines.map((l) => `${l.section}|${l.name}`))];
        for (const key of names) {
            const [section, name] = key.split("|");
            const val = (m) => m.lines.filter((l) => l.section === section && l.name === name).reduce((s, l) => s + l.amount, 0);
            const now = val(latest), avg = prior.slice(0, 3).reduce((s, m) => s + val(m), 0) / 3;
            const change = now - avg, pct = avg ? (change / Math.abs(avg)) * 100 : (now ? 100 : 0);
            if (Math.abs(change) < opt.varianceMinAmount || Math.abs(pct) < opt.variancePct)
                continue;
            out.push({ ...base, check: "large_variance", severity: Math.abs(pct) >= 200 ? "high" : "medium", title: `${name} ${change > 0 ? "up" : "down"} ${Math.round(Math.abs(pct))}% in ${latest.label}`,
                detail: `${section} line ${name}: ${round2(now)} in ${latest.label} vs 3-month average ${round2(avg)}`, value_at_risk: round2(Math.abs(change)),
                reference: { type: "ProfitAndLoss line", number: name }, suggested_fix: change > 0 && section !== "Income" ? "Check for miscoding (capital items, prepayments) or a duplicate bill, and ask the client for an explanation." : "Check for missing invoices/accruals or a timing difference, and ask the client for an explanation." });
        }
    }
    // 8. Stale drafts (unapproved invoices/bills, unposted manual journals)
    if (want("stale_draft")) {
        for (const i of det.invoices.filter((x) => x.Status === "DRAFT" || x.Status === "SUBMITTED")) {
            const days = age(d(i));
            if (days <= opt.draftAgeDays)
                continue;
            out.push({ ...base, check: "stale_draft", severity: "low", date: d(i), title: `${docName(i)} still ${i.Status.toLowerCase()} after ${days} days`, detail: `${i.Contact?.Name ?? ""} ${round2(num(i.Total))}: not in the ledger, AR/AP or tax return`,
                value_at_risk: round2(num(i.Total)), reference: { type: i.Type === "ACCPAY" ? "Bill" : "Invoice", id: i.InvoiceID, number: i.InvoiceNumber }, xero_link: deepLink(meta, invKind(i), i.InvoiceID),
                suggested_fix: "Approve it if it is real, otherwise delete it." });
        }
        for (const j of det.manualJournals.filter((x) => x.Status === "DRAFT")) {
            const days = age(d(j));
            if (days <= opt.draftAgeDays)
                continue;
            const amt = (j.JournalLines ?? []).filter((l) => num(l.LineAmount) > 0).reduce((s, l) => s + num(l.LineAmount), 0);
            out.push({ ...base, check: "stale_draft", severity: "medium", date: d(j), title: `Draft manual journal not posted (${days} days)`, detail: `"${j.Narration ?? ""}" dated ${d(j)}, ${round2(amt)}`,
                value_at_risk: round2(amt), reference: { type: "ManualJournal", id: j.ManualJournalID }, xero_link: deepLink(meta, "manual_journal", j.ManualJournalID),
                suggested_fix: "Post it if the adjustment is still needed for that period, otherwise void/delete the draft." });
        }
    }
    // 9. Suspense / clearing balances
    if (want("suspense_balance") && det.trialBalance) {
        for (const r of flattenReport(det.trialBalance).rows) {
            if (r.summary || !SUSPENSE.test(r.account))
                continue;
            const bal = round2(num(r.values[0]) - num(r.values[1]));
            if (!bal)
                continue;
            out.push({ ...base, check: "suspense_balance", severity: "high", title: `${r.account} has a balance of ${Math.abs(bal)}`, detail: `Trial balance at ${asOf}: ${bal > 0 ? "debit" : "credit"} ${Math.abs(bal)}`,
                value_at_risk: Math.abs(bal), reference: { type: "Account", id: r.account_id, number: r.account }, xero_link: r.account_id ? deepLink(meta, "account", r.account_id) : undefined,
                suggested_fix: "Clear it to the correct accounts before month-end (often needs a manual journal: use prepare_manual_journal)." });
        }
    }
    // 10. Period lock date
    if (want("lock_date")) {
        const [y, m] = asOf.split("-").map(Number);
        const prevEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); // end of month before as-of month
        const lock = meta.lockDate;
        if (!lock || lock < prevEnd) {
            const behind = lock ? Math.round(daysBetween(lock, prevEnd) / 30) : null;
            out.push({ ...base, check: "lock_date", severity: !lock || (behind ?? 0) >= 3 ? "medium" : "low", title: lock ? `Lock date ${lock} is ${behind} month(s) behind` : "No period lock date set",
                detail: `Closed periods up to ${prevEnd} can still be edited${lock ? ` (locked to ${lock})` : ""}`, value_at_risk: 0, reference: { type: "Organisation setting", number: "Lock dates" },
                xero_link: deepLink(meta, "settings", ""), suggested_fix: `After review, set the lock date to ${prevEnd} (Settings > Advanced > Financial settings).` });
        }
    }
    // 11-13. Negative bank, very overdue bills, overdue tax liabilities
    if (want("negative_bank") && snap)
        for (const b of snap.bank.filter((x) => x.closingBalance < 0 && !/(card|amex|visa|mastercard|credit)/i.test(x.name))) {
            out.push({ ...base, check: "negative_bank", severity: "medium", title: `${b.name} overdrawn`, detail: `Closing balance ${b.closingBalance} at ${asOf}`, value_at_risk: Math.abs(b.closingBalance),
                reference: { type: "BankAccount", id: b.id, number: b.name }, xero_link: deepLink(meta, "bank_account", b.id), suggested_fix: "Confirm against the bank statement (could be missing receipts or an unrecorded transfer)." });
        }
    for (const i of det.invoices.filter((x) => x.Type === "ACCPAY" && x.Status === "AUTHORISED" && num(x.AmountDue) > 0)) {
        const days = age(dueOf(i));
        const tax = TAX_AUTHORITY.test(String(i.Contact?.Name ?? ""));
        if (tax && days > 0 && want("overdue_tax_liability")) {
            out.push({ ...base, check: "overdue_tax_liability", severity: "high", date: dueOf(i), title: `${i.Contact.Name} liability ${days} days overdue`, detail: `${docName(i)} ${round2(num(i.AmountDue))} was due ${dueOf(i)}: penalties and interest may apply`,
                value_at_risk: round2(num(i.AmountDue)), reference: { type: "Bill", id: i.InvoiceID, number: i.InvoiceNumber }, xero_link: deepLink(meta, "bill", i.InvoiceID),
                suggested_fix: "Confirm whether it was paid (then record the payment) or arrange payment / a payment plan." });
        }
        else if (!tax && days > 60 && want("overdue_payables")) {
            out.push({ ...base, check: "overdue_payables", severity: "medium", date: dueOf(i), title: `${docName(i)} ${days} days overdue`, detail: `${i.Contact?.Name ?? ""} ${round2(num(i.AmountDue))} due ${dueOf(i)}`,
                value_at_risk: round2(num(i.AmountDue)), reference: { type: "Bill", id: i.InvoiceID, number: i.InvoiceNumber }, xero_link: deepLink(meta, "bill", i.InvoiceID),
                suggested_fix: "Check whether it was paid outside Xero or is disputed; otherwise flag the supplier risk to the client." });
        }
    }
    const min = opt.minSeverity ? SEV_RANK[opt.minSeverity] : 0;
    return out.filter((f) => SEV_RANK[f.severity] >= min).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.value_at_risk - a.value_at_risk);
}
/** P&L months newest first, dropping the as-of month when as_of is mid-month (a part month is not a variance). */
export function closedMonths(snap) {
    const [y, m] = snap.asOf.split("-").map(Number);
    const isMonthEnd = snap.asOf === new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return isMonthEnd ? snap.pnl : snap.pnl.slice(1);
}
export function summarise(findings) {
    const by = (k) => findings.reduce((m, f) => ((m[k(f)] = (m[k(f)] ?? 0) + 1), m), {});
    const risk = {};
    for (const f of findings)
        risk[f.currency] = round2((risk[f.currency] ?? 0) + f.value_at_risk);
    return { total: findings.length, by_severity: by((f) => f.severity), by_check: by((f) => f.check), value_at_risk_by_currency: risk };
}
/** The tax period being prepared: the one ending on as_of, otherwise the last one that ended before it (calendar-aligned). */
export function taxPeriod(asOf, period) {
    const [y, m] = asOf.split("-").map(Number);
    const months = period === "MONTHLY" ? 1 : period === "TWOMONTHS" ? 2 : period === "SIXMONTHLY" ? 6 : period === "ANNUALLY" ? 12 : 3;
    let startM = Math.floor((m - 1) / months) * months; // 0-based month index, may go negative (prior year)
    if (new Date(Date.UTC(y, startM + months, 0)).toISOString().slice(0, 10) > asOf)
        startM -= months;
    const from = new Date(Date.UTC(y, startM, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(y, startM + months, 0)).toISOString().slice(0, 10);
    return { from, to, label: `${from} to ${to}` };
}
const RETURN_NAME = { AU: "BAS", GB: "VAT return", NZ: "GST return", ZA: "VAT201", IE: "VAT3", CA: "GST/HST return", SG: "GST F5" };
/** BAS / VAT / GST readiness for the tax period containing asOf. */
export function taxReadiness(det, findings) {
    const p = taxPeriod(det.asOf, det.meta.taxPeriod);
    const inP = (f) => !f.date || (f.date >= p.from && f.date <= p.to);
    const pick = (c) => findings.filter((f) => c.includes(f.check) && inP(f));
    const blockers = [...pick(["missing_tax_code", "unreconciled_bank", "suspense_balance"])];
    const warnings = [...pick(["tax_anomaly", "duplicate_invoice", "duplicate_payment", "missing_attachment", "unreconciled_payment"]),
        ...findings.filter((f) => f.check === "stale_draft" && f.date && f.date >= p.from && f.date <= p.to)];
    const notes = [];
    const registered = taxRegistered(det);
    if (!registered)
        notes.push("No tax number and no non-zero tax rates: org looks not registered for VAT/GST.");
    if (registered && !det.meta.taxNumber)
        notes.push("Tax registration number is not recorded in Xero (Settings > Financial settings).");
    if (!det.meta.lockDate || det.meta.lockDate < new Date(Date.parse(p.from + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10))
        notes.push(`Lock date ${det.meta.lockDate ?? "not set"}: earlier filed periods are still editable.`);
    if (det.gaps.length)
        notes.push(`Some data could not be read (${det.gaps.map((g) => g.resource).join(", ")}), so this check is incomplete.`);
    const status = !registered ? "not registered" : blockers.length ? "not ready" : warnings.length ? "needs review" : "ready";
    const sum = (xs) => round2(xs.reduce((s, f) => s + f.value_at_risk, 0));
    return { org: det.meta.name, tenant_id: det.tenantId, return_type: RETURN_NAME[det.meta.country] ?? "sales tax return", basis: det.meta.taxBasis ?? null, period: p, status,
        blockers: blockers.length, warnings: warnings.length, value_at_risk: sum([...blockers, ...warnings]), currency: det.meta.currency, notes,
        items: [...blockers.map((f) => ({ level: "blocker", ...brief(f) })), ...warnings.map((f) => ({ level: "warning", ...brief(f) }))] };
}
export function brief(f) { return { check: f.check, severity: f.severity, title: f.title, value: f.value_at_risk, link: f.xero_link, fix: f.suggested_fix }; }
/** Month-close readiness checklist for one org. */
export function closeReadiness(det, findings) {
    const has = (c, pred = () => true) => findings.filter((f) => f.check === c && pred(f));
    const [y, m] = det.asOf.split("-").map(Number);
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    const items = [
        { item: "Bank reconciled (no stale unreconciled lines)", hits: has("unreconciled_bank") },
        { item: "Invoice payments reconciled", hits: has("unreconciled_payment") },
        { item: "No suspense / clearing balances", hits: has("suspense_balance") },
        { item: "Every line has a tax code", hits: has("missing_tax_code") },
        { item: "No likely duplicates", hits: [...has("duplicate_invoice"), ...has("duplicate_payment")] },
        { item: "No stale drafts / unposted journals", hits: has("stale_draft") },
        { item: "Large variances explained", hits: has("large_variance") },
        { item: "Source documents attached", hits: has("missing_attachment", (f) => !f.date || f.date >= monthStart) },
        { item: "Tax liabilities paid on time", hits: has("overdue_tax_liability") },
        { item: "Prior period locked", hits: has("lock_date") },
    ].map((x) => ({ item: x.item, ok: x.hits.length === 0, issues: x.hits.length, value: round2(x.hits.reduce((s, f) => s + f.value_at_risk, 0)) }));
    const passed = items.filter((i) => i.ok).length;
    const score = Math.round((passed / items.length) * 100);
    return { org: det.meta.name, tenant_id: det.tenantId, as_of: det.asOf, score, status: score === 100 ? "ready to close" : score >= 70 ? "nearly ready" : "not ready", passed, of: items.length, checklist: items };
}
