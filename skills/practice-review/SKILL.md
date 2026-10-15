---
name: practice-review
description: Run a cross-client practice review for an accountant using xero-aggregator - overdue invoices, payroll risk, client health and practice dashboard. Use for questions like "who owes money across my clients", "who might miss payroll", "which clients are in trouble", "practice revenue / DSO".
---

# Practice review across all clients

Pick the narrowest tool for the question; for "how is my practice doing?" run them in this order and give one short summary.

| Question | Tool |
|---|---|
| Overdue invoices across clients | `overdue_invoices` with `min_days` 30, 60 or 90 (strictly MORE than that many days) |
| Who is closest to missing payroll | `payroll_risk` (worst first; `closest_to_missing_payroll`) |
| Is client X OK / unusual patterns | `client_health` with `org` |
| Practice totals, average DSO | `practice_dashboard` (`months`, default 3) |
| Clients trending toward trouble | `clients_trending_trouble` |

How to present results:
- Always state the **as-of date** and that figures come from Xero at last sync.
- Money: quote per currency from `totals_by_currency` / `total_revenue_by_currency`. Never add different currencies together.
- Payroll: quote the `formula` line so the accountant can check it, and the `payroll_source`. If payroll was estimated from P&L wages, say so and offer `set_payroll_profile` with the real amount and date (held in memory only).
- Health scores: list each triggered rule with its points and detail. These are heuristics to prioritise attention, not a credit rating or advice. Bands: 80+ healthy, 60-79 watch, under 60 at risk.
- `min_days` only accepts 30, 60 or 90. For other thresholds, use 30 and filter `days_overdue` yourself.
- Org names can be partial ("northwind"). If a tool says the name matches several orgs, ask which one.

Do not draft or send chasers to clients' customers automatically; offer to draft them for the accountant to review.
