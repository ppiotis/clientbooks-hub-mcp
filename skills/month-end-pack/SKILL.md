---
name: month-end-pack
description: Produce and explain a client's Excel month-end pack (aged receivables, bank reconciliation status, P&L snapshot) with ClientBooks Hub. Use when the accountant asks for a month-end pack, client pack, or an Excel export for a client.
---

# Month-end pack

1. Resolve the client with `list_orgs` if the name is unclear.
2. For a closed month use `as_of` = the last day of that month (e.g. `2026-09-30`). Otherwise it is "as at today".
3. Call `sync_now` first if the accountant has just finished reconciling in Xero.
4. Call `month_end_pack` with `org` (and `as_of`). It writes one `.xlsx` with three sheets:
   - **Aged Receivables**: one row per open sales invoice, amount in its bucket (Current, 1-30, 31-60, 61-90, 90+), and a Total row.
   - **Bank Reconciliation**: per bank account, Xero closing balance, unreconciled item count and amount.
   - **P&L Snapshot**: each P&L line for the latest month and the period total, then total income, expenses and net profit.
5. Reply with the file path and the headline numbers from `summary` (aged total and 90+ amount, unreconciled count/amount, latest-month net profit) so the accountant can sanity-check before sending.

Caveats to mention when relevant:
- "Unreconciled" means Xero bank transactions not yet reconciled. Statement lines that have not been imported or coded are not visible through Xero's API, so the accountant should still glance at the Xero reconcile screen.
- The file contains client financial data. It is written only to the configured export folder, and the user is responsible for sharing it securely.
- One pack per client per call. For several clients, call once per client.

For several clients at once, or for draft variance commentary, exception lists and AR/AP/cash snapshots, use `month_end_summary` (with `orgs` omitted for the whole book, and `export: true` for one practice workbook). The commentary is a draft for the accountant to edit.
