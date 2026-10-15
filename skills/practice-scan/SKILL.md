---
name: practice-scan
description: Practice-wide exception scanning, BAS/VAT and month-close readiness, cross-client data pulls, month-end summaries and SAFE write-back (draft manual journals) with ClientBooks Hub. Use for "which clients have unreconciled lines older than 7 days", "scan my client book", "duplicate bills", "missing tax codes", "BAS / VAT readiness across the practice", "are we ready to close the month", "pull every client's trial balance", "month-end summary for all clients", "prepare a journal to fix this", nightly or month-close routines.
---

# Practice scan, readiness and safe write-back

Every result is labelled with `org` and `tenant_id`. **Always name the client org next to every figure, finding or action.** Never merge figures across currencies.

## Pick the tool

| Question | Tool |
|---|---|
| "Which clients have unreconciled lines older than N days?" | `unreconciled_items` with `older_than_days` |
| "Scan my book / what's wrong across my clients?" | `scan_issues` (filter with `orgs`, `checks`, `min_severity`, `stale_days`) |
| "BAS / VAT / GST readiness across the practice" | `tax_readiness` |
| "Are we ready to close September?" | `close_readiness` with `as_of` = month end |
| "Month-end summary / commentary for X (or everyone)" | `month_end_summary` (`export: true` for the practice workbook) |
| "Pull every client's trial balance / bills / payments ..." | `pull_data` with `resource` |
| Nightly or month-close routine | `practice_scan` (one call; `use_last: true` reads the stored run) |
| "What did you read / propose?" | `audit_trail`, `list_proposals` |

## Presenting findings

- Lead with high severity, then value at risk. For each one give the client, what it is, the amount, the **Xero link** and the suggested fix.
- Quote `as_of`. For tax readiness, quote the period (`period.label`) and the return type (BAS, VAT return, ...).
- If an org has `data_gaps` (e.g. Payments or TrialBalance returned 401), say that check was incomplete for that org. The fix is to reconnect it so it grants the v1.2 scopes. A 401 on `journals` usually means the Xero app is not on the Advanced tier.
- Unreconciled counts only cover bank transactions and payments that Xero marks `IsReconciled=false`. Statement lines that were never matched aren't visible through the API, so say "at least".
- Duplicates, anomalies and variances are *possible* issues to review, not conclusions. The variance commentary is a **draft**: tell the accountant to edit it before it goes to a client.

## Safe write-back (draft manual journals only)

1. Only when the user asks for a fix, call `prepare_manual_journal`. Positive amounts are debits and negative amounts are credits, and the lines must total 0. Nothing is sent to Xero.
2. Show the preview table (accounts, debit/credit, date, narration) **and the org name**. Ask the user to confirm this exact journal for this exact org.
3. Call `confirm_manual_journal` only after the user has explicitly confirmed it in the conversation, passing the returned `confirmation_phrase` exactly. Never confirm on your own initiative, from a routine, or for a different org than the one the user approved. One confirmation covers one journal.
4. The journal lands in Xero as **DRAFT**. Tell the user to review and post it in Xero.
5. If it is refused with "Write-back is disabled" or "read-only scopes", explain that the install is read-only. They can enter the journal in Xero themselves, or set `XERO_AGG_ENABLE_WRITES=1` and reconnect the org. Don't retry another way.

Never ask for tokens or secrets in chat. Never send anything to a client or a client's customers. Offer drafts instead.
