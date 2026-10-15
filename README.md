<p align="center"><img src="logo.svg" width="96" alt="ClientBooks Hub logo"></p>

# ClientBooks Hub MCP

[![CI](https://github.com/ppiotis/clientbooks-hub-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ppiotis/clientbooks-hub-mcp/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

**One view across every client's books, for accountants and bookkeepers. Works with Xero.** Each client connects their own Xero organisation, read-only. Your agent can then answer practice-wide questions that Xero itself can't: *which clients have invoices more than 90 days overdue, who is closest to missing payroll, which clients are trending toward trouble, and what is my practice's total revenue and average DSO.* It also produces a **ready-to-send Excel month-end pack** per client.

v1.2 adds **practice-scale exception scanning** (unreconciled lines older than N days, duplicate bills/payments, missing tax codes, GST/VAT anomalies, missing receipts, large variances, suspense balances, stale drafts, lock dates, overdue tax), **BAS/VAT and month-close readiness across every client in one call**, cross-client **data pulls** (invoices, bills, bank transactions, payments, journals, contacts, accounts, P&L, balance sheet, trial balance, aged AR/AP), multi-client **month-end summaries with draft variance commentary**, an **audit trail**, and **human-in-the-loop write-back**: draft manual journals only, two-step prepare/confirm naming the org, and off unless you opt in.

This is **not** a general-purpose Xero plugin. By default it is read-only. The only write it can ever make is a **DRAFT** manual journal, and only when `XERO_AGG_ENABLE_WRITES=1` is set, the org was connected with the manual-journals scope, and the user confirmed that exact journal for that exact org.

## Why

A practice with 40 clients has 40 Xero logins and no cross-client view. Spotting the client who will bounce payroll next week means opening every org. This server polls every connected org on a schedule, normalizes invoices, bills, contacts, bank balances and reports into one cross-org model **held in memory**, and runs transparent, explainable rules over it. Every number it reports comes with the formula or rule that produced it.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `list_orgs` | Connected orgs, sync status, currency, counts. Start here. | no |
| `connect_org_start` | Creates a Xero OAuth2 sign-in link (authorization code + PKCE, read-only scopes) | no |
| `connect_org_complete` | Exchanges the code from Xero's redirect, stores **only the tokens**, encrypted | tokens file |
| `sync_now` | Re-fetches all orgs into the in-memory cache (also runs on a timer) | no |
| `overdue_invoices` | Sales invoices more than **30, 60 or 90** days overdue across all clients, per org and per currency | no |
| `payroll_risk` | Ranks orgs by how close they are to missing payroll, with the formula shown | no |
| `set_payroll_profile` | Override an org's payroll amount and date (memory only) | memory |
| `month_end_pack` | `.xlsx` for one client: Aged Receivables, Bank Reconciliation, P&L Snapshot | export folder |
| `client_health` | 0-100 score from transparent rules (expense spike z-score, growing director loan, ...) | no |
| `practice_dashboard` | Total revenue across clients (by currency), average DSO, health band per client | no |
| `clients_trending_trouble` | Clients under a health threshold, worst first, with reasons | no |
| `disconnect_org` | Revokes the Xero connection and deletes its tokens (preview, then `confirm=true`) | tokens file |
| **v1.2 practice-scale** | | |
| `pull_data` | One resource from every org (or named orgs), each row tagged with org + tenant id: invoices, bills, credit_notes, bank_transactions, payments, manual_journals, journals, contacts, accounts, tax_rates, profit_and_loss, balance_sheet, trial_balance, bank_summary, aged_receivables, aged_payables | no |
| `scan_issues` | Exception scan across the book (14 checks, below). Each finding: org, tenant id, severity, value at risk, Xero deep link, suggested fix | no |
| `unreconciled_items` | "Which clients have unreconciled lines older than N days?" in one call | no |
| `tax_readiness` | BAS / VAT / GST readiness per client for the period just ended: ready / needs review / not ready, with blockers and warnings | no |
| `close_readiness` | 10-point month-close checklist per client with a 0-100 score | no |
| `month_end_summary` | One or many clients: cash, AR and AP snapshots, P&L vs prior month, **draft** variance commentary, exception list, close score; `export=true` writes a practice workbook | export folder |
| `practice_scan` | Whole-book routine (nightly / month-close): re-sync, all checks, ranked digest; `use_last` returns the last run | no |
| `prepare_manual_journal` | Step 1 of write-back: validates a journal (balanced, accounts exist, not a bank account, after lock date), stores it locally, returns a preview and a confirmation phrase naming the org. Sends nothing | audit log |
| `confirm_manual_journal` | Step 2: with the exact phrase, creates it in Xero as **DRAFT**. Refused unless writes are enabled and the org granted the scope | Xero (DRAFT only) |
| `list_proposals` | Pending / used / expired journal proposals | no |
| `audit_trail` | Local log of every read (endpoint + org + call count), proposal, confirmation, refusal and scheduled scan | no |

Four skills ship with the plugin and teach the agent how to use these tools: `connect-xero-orgs`, `practice-review`, `month-end-pack` and `practice-scan` (exceptions, BAS/VAT readiness, close, safe write-back).

### Issue checks (`scan_issues`)

| Check | Flags | Severity |
|---|---|---|
| `unreconciled_bank` | Bank transactions with `IsReconciled=false` older than `stale_days` (default 7, `XERO_AGG_STALE_DAYS`) | high if >30 days or ≥1,000, else medium |
| `unreconciled_payment` | Invoice/bill payments not reconciled after `stale_days` | medium |
| `duplicate_invoice` | Same type + contact + amount, and same number/reference within 14 days or any within 3 days. Recurring charges (3+ identical in the window: rent, subscriptions) only count if same number within 3 days | high for bills, medium for invoices |
| `duplicate_payment` | Two payments of the same amount on the same invoice within 14 days; same-contact same-amount bank transactions within 3 days (recurring ones excluded) | high / medium |
| `missing_tax_code` | Invoice, bill or bank lines with no tax rate | high if the org is tax-registered |
| `tax_anomaly` | Income coded NONE/BAS Excluded; tax amount not matching the rate; tax code different from the account default | medium / low |
| `missing_attachment` | Bills and spend-money ≥ `attachment_threshold` (500) with `HasAttachments=false` | medium ≥2,000, else low |
| `large_variance` | P&L line in the last **complete** month vs its 3-month average, ≥ `variance_pct` (50%) and ≥ `variance_min_amount` (1,000) | high ≥200% |
| `stale_draft` | Draft/submitted invoices and bills, and draft manual journals, older than 30 days | low / medium |
| `suspense_balance` | Trial balance accounts named suspense / clearing / uncategorised with a balance | high |
| `lock_date` | No period lock date, or lock date before the end of last month | medium if none or ≥3 months behind |
| `negative_bank` | Overdrawn bank account (cards excluded) | medium |
| `overdue_payables` | Bills more than 60 days overdue | medium |
| `overdue_tax_liability` | Unpaid bills to HMRC / ATO / IRD / SARS / IRS / CRA past due | high |

Deep links use `https://go.xero.com/organisationlogin/default.aspx?shortcode=<org>&redirecturl=...`, so clicking one opens the right org first.

**BAS/VAT readiness** looks at the tax period that has just ended (the one ending on `as_of`, otherwise the last one before it; quarterly unless Xero says monthly). Blockers: missing tax codes, unreconciled bank lines in the period, suspense balances. Warnings: tax-code anomalies, duplicates, missing receipts, unreconciled payments, drafts dated in the period. It does not prepare or file the return.

### Safe write-back (opt-in)

1. `prepare_manual_journal` validates the journal and returns a preview plus a phrase like `POST DRAFT 3f9a1c2e TO Kookaburra Coffee Co Pty Ltd`. Nothing is sent. The proposal is logged and expires in 30 minutes.
2. The agent shows the preview, and the user approves that journal for that org.
3. `confirm_manual_journal` with the exact phrase creates it in Xero with `Status: DRAFT` (it is not in the ledger until someone posts it inside Xero). It is single use. Wrong phrase, expired, used, writes disabled, or a read-only grant are all refused and logged.

To enable: set `XERO_AGG_ENABLE_WRITES=1`, which adds `accounting.manualjournals` (or `accounting.transactions` with `XERO_SCOPE_SET=broad`) to the requested scopes. Then **reconnect each org** you want to write to, because existing grants stay read-only. No other write scope is ever accepted.

### Audit trail

`XERO_AGG_AUDIT_FILE` (default `~/.xero-aggregator/audit.jsonl`, mode 0600, append-only JSON Lines) records each tool's reads (endpoint, tenant id, call count, **no figures**), every proposal (with its lines and reason), confirmation, refusal, the Xero journal id created, and scheduled scans. Read it with `audit_trail`.

### The rules, in full

**Ageing.** Days overdue = as-of date minus due date. Buckets: Current (not yet due), 1-30, 31-60, 61-90, 90+. Only `AUTHORISED` invoices with an amount still due are included, and part-payments count at the amount still due. `overdue_invoices` with `min_days: 30` means *more than* 30 days.

**Payroll risk.**
```
coverage = (cash in all bank accounts - bills due on or before next payroll date) / payroll amount
headroom = cash - those bills - payroll amount
```
Below 1.0 is a **SHORTFALL**, 1.0 to 1.5 is **tight**, and anything higher is **ok**. Cash is the closing balance from Xero's Bank Summary. The payroll amount defaults to the average of the P&L lines named wages, salaries, payroll, PAYE, pension or super over the last 3 months. The next payroll date defaults to the next 25th. Use `set_payroll_profile` to supply the real figures; the read-only scopes deliberately exclude Xero Payroll.

**Health score.** Starts at 100 and loses points for each rule that fires:

| Rule | Points |
|---|---|
| More than 10% of receivables are 90+ days overdue | -15 |
| Payroll coverage < 1.0 | -25 |
| Payroll coverage 1.0 to 1.5 | -10 |
| Expense spike: latest month's total expenses z-score >= 2.0 against the trailing months (sample std dev, needs 3+ trailing months) | -15 |
| Growing director loan: the absolute balance of any balance-sheet account named like "Director ... Loan / Current Account" rose in each of the last 3 months | -15 |
| DSO > 60 days | -10 |
| Unreconciled bank items > 10% of cash | -10 |
| Income fell in each of the last 3 months | -10 |

A score of 80 or more is **healthy**, 60-79 is **watch**, and under 60 is **at risk**. These are prioritisation heuristics, not credit ratings or advice.

**DSO** = receivables outstanding / P&L income for the last 3 months × days in those months. The practice average is the simple mean across clients. **Revenue** is P&L income, summed **per currency**; different currencies are never added together.

## Install

Requires Node 20+.

### Try it in 30 seconds (demo mode, no Xero account)

The default `.mcp.json` runs with `XERO_AGG_DEMO=1`. Two fixture orgs (*Harbour Bakery Ltd* and *Northwind Joinery Ltd*, both synthetic, GBP, as at 2026-09-30) are served through the same normalization code as live data. Add the plugin and ask "list my Xero clients".

### Local, with real Xero orgs

```json
{
  "mcpServers": {
    "clientbooks-hub": {
      "command": "npx",
      "args": ["-y", "https://github.com/ppiotis/clientbooks-hub-mcp/archive/refs/tags/v1.2.0.tar.gz"],
      "env": {
        "XERO_CLIENT_ID": "your-xero-app-client-id",
        "XERO_AGG_TOKEN_KEY": "output of: openssl rand -base64 32",
        "XERO_REDIRECT_URI": "http://localhost:5173/oauth/callback"
      }
    }
  }
}
```
Locally nothing listens on the redirect URI. After approving in Xero, the browser shows a "can't connect" page; copy that page's full URL and give it to the agent, which passes it to `connect_org_complete`. The code in that URL is single-use, expires in minutes, and is useless without the PKCE verifier held by your server.

### Server (Streamable HTTP)

```bash
git clone https://github.com/ppiotis/clientbooks-hub-mcp && cd clientbooks-hub-mcp
npm ci && npm run build
export XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... XERO_AGG_TOKEN_KEY="$(openssl rand -base64 32)"
export XERO_REDIRECT_URI=https://your-host/oauth/callback MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export HOST=0.0.0.0 PORT=3000 XERO_AGG_TOKEN_FILE=/data/tokens.enc XERO_AGG_EXPORT_DIR=/data/exports
npm run start:http        # MCP endpoint: https://your-host/mcp, health: /health
```
Or use `docker build -t clientbooks-hub . && docker run -p 3000:3000 -v xagg:/data -e ... clientbooks-hub`. Put it behind HTTPS, and connect your MCP client to `https://your-host/mcp` with header `Authorization: Bearer $MCP_AUTH_TOKEN`. The server is single-practice: one deployment holds one practice's connections. Don't share an instance between practices.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `XERO_CLIENT_ID` | none | Xero app client id (live mode) |
| `XERO_CLIENT_SECRET` | none | Only for Xero "Web app" type. Omit for PKCE-only apps |
| `XERO_REDIRECT_URI` | `http://localhost:5173/oauth/callback` | Must exactly match the app's redirect URI |
| `XERO_AGG_TOKEN_KEY` | none | **Required in live mode.** 16+ chars; encrypts the token file |
| `XERO_AGG_TOKEN_FILE` | `~/.xero-aggregator/tokens.enc` | Encrypted token store |
| `XERO_AGG_EXPORT_DIR` | `~/.xero-aggregator/exports` | Where month-end packs are written |
| `XERO_AGG_SYNC_MINUTES` | `60` | Poll interval; `0` disables the timer |
| `XERO_SCOPE_SET` | granular | Set `broad` for Xero apps created before 2 March 2026 |
| `XERO_SCOPES` | none | Explicit scope list; anything not `*.read` (plus OIDC/offline_access) is refused |
| `XERO_AGG_DEMO` | off | `1` serves the bundled fixtures |
| `XERO_AGG_ENABLE_WRITES` | off | `1` allows DRAFT manual journals (adds the manual-journals scope; reconnect orgs) |
| `XERO_AGG_AUDIT_FILE` | `~/.xero-aggregator/audit.jsonl` | Local audit trail |
| `XERO_AGG_STALE_DAYS` | `7` | Default age for "unreconciled older than N days" |
| `XERO_AGG_SCAN_MINUTES` | `0` (off) | In-process schedule: re-sync and re-scan the whole book every N minutes (`practice_scan use_last=true` reads it) |
| `XERO_AGG_DAILY_LIMIT` | `5000` | Local per-org daily call cap; lower it to match your Xero plan tier |
| `MCP_AUTH_TOKEN` | none | Bearer token required on `/mcp` (HTTP mode). Always set this on a server |

## Xero app setup

1. Go to [developer.xero.com/app/manage](https://developer.xero.com/app/manage), then **New app**.
2. For local use choose **Mobile or desktop app** (PKCE, no secret). For a server choose **Web app** and set `XERO_CLIENT_SECRET`.
3. Set the redirect URI to exactly your `XERO_REDIRECT_URI`.
4. Copy the client id into `XERO_CLIENT_ID`.
5. Scopes requested (read-only, granular, as required for apps created on or after 2 March 2026):
   `openid profile email offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.banktransactions.read accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.reports.banksummary.read accounting.payments.read accounting.manualjournals.read accounting.reports.trialbalance.read accounting.reports.aged.read`. The last four are new in v1.2 (payments, manual journals, trial balance, aged reports); orgs connected with v1.1 keep working, and the checks that need them report a `data_gaps` entry until the org is reconnected. With `XERO_AGG_ENABLE_WRITES=1`, `accounting.manualjournals` is added.
   Older apps can use `XERO_SCOPE_SET=broad` (`accounting.transactions.read accounting.reports.read`), which works until Xero's 13 September 2027 deadline. If Xero's consent screen reports an invalid scope, set `XERO_SCOPES` explicitly.
6. To try it, connect Xero's **Demo Company** (in Xero: *My Xero → Try the Demo Company*), then ask the agent to "connect a client Xero org".

**Many orgs, one login.** On Xero's consent screen an adviser can tick several organisations at once; every ticked org is stored under the same grant, and all tools then work across all of them in one session with no re-authentication. Before each sync the server re-reads `GET /connections` (at most every 15 minutes) to pick up renamed orgs and drop revoked ones; it never adds orgs on its own. Every result carries the org name and tenant id. Xero's partner-only *Bulk Connections* flow (connect hundreds of orgs at once) needs Xero partner approval and is not used.

**Rate limits.** Every call goes through a per-org limiter: at most 5 concurrent, 60 per rolling minute, and a daily cap (5,000, or `XERO_AGG_DAILY_LIMIT`). It reads `X-DayLimit-Remaining`, waits for `Retry-After` on a 429 (minute limit), and stops cleanly when Xero reports the daily limit. Scans fan out across 3 orgs at a time. Tokens refresh 60 s before expiry (rotating refresh tokens, de-duplicated) and once on a 401.

## Security & privacy

- **Read-only by default.** The server only requests `.read` scopes; config that asks for anything else is rejected at startup unless `XERO_AGG_ENABLE_WRITES=1`, and even then only the manual-journals scope is accepted. Every sync and scan call is a `GET` (tested). The only non-GETs are `DELETE /connections/{id}` (`disconnect_org` revoking its own access) and, when opted in, a `PUT /ManualJournals` with `Status: DRAFT` from `confirm_manual_journal` after an exact, org-naming confirmation (tested: prepare never writes, and the tenant header matches the proposal).
- **Tokens only on disk.** The token file holds OAuth tokens plus tenant ids and names, encrypted with **AES-256-GCM** under a key derived by scrypt from `XERO_AGG_TOKEN_KEY`. It is written atomically with mode `0600`. A wrong key or a tampered file fails closed.
- **No financial data persisted.** Invoices, bills, contacts, balances and reports are normalized into an **in-memory cache only**, so a restart clears them. A test asserts that after a full sync the only file on disk is the encrypted token file, and that it contains no customer names or invoice numbers. The audit log stores call counts, not figures, plus the journal lines you asked to propose. The other exceptions are the month-end packs you explicitly ask for, written to `XERO_AGG_EXPORT_DIR` (filenames are slugged; path traversal is tested).
- **OAuth done properly.** Authorization code with PKCE S256, a single-use `state` that expires after 10 minutes, and **refresh-token rotation**: every refresh stores the new refresh token, and concurrent refreshes are de-duplicated so a rotated token is never reused. The client secret is sent via HTTP Basic only when configured.
- **HTTP mode.** `/mcp` requires `Authorization: Bearer $MCP_AUTH_TOKEN`, compared in constant time, with a 1 MB body limit. `/oauth/callback` is protected by the PKCE state, and it never echoes codes or tokens back.
- **No telemetry, no third parties.** The server only contacts `login.xero.com`, `identity.xero.com` and `api.xero.com`.
- **Secrets never go in chat.** Configure them as environment variables; the skills tell the agent never to ask for tokens.

## Reviewer test plan

Everything below runs in **demo mode** (the default `.mcp.json`), as an accountant opening the plugin for the first time. The data is as at **2026-09-30**. Two UK orgs are in GBP, and v1.2 adds **Kookaburra Coffee Co Pty Ltd** (AUD, GST-registered, BAS quarterly), which is full of planted month-end problems.

**1. "List my Xero clients."**
Expect `list_orgs` to show 3 orgs: **Harbour Bakery Ltd** (5 open invoices, 3 open bills, 2 bank accounts), **Kookaburra Coffee Co Pty Ltd** (4, 5, 1) and **Northwind Joinery Ltd** (6, 4, 1), `mode: "demo"`.

**2. "Show me every invoice more than 30 days overdue across all my clients." Then "...and over 90?"**
Expect **7 invoices: £20,435.50 and A$4,400.00**, never added together. In GBP: Harbour Bakery 2 (£3,310.00), Northwind 4 (£17,125.50). In AUD: Kookaburra KC-1001, 61 days. The most overdue is **INV-B101, Oakridge Homes, 112 days, £6,800.00 due**. It's a part-paid £8,800 invoice, so check the amount due is used, not the total. Over 60 days: 5 invoices, £15,810.00 + A$4,400.00. Over 90 days: **2 invoices (INV-B101, INV-B102), £11,050.00**, both Northwind. Draft and voided invoices in the fixtures (INV-A006, INV-B107) must not appear.

**3. "Which client is closest to missing payroll? Show the working."**
Expect **Kookaburra Coffee Co Pty Ltd**, SHORTFALL: `(cash 12340.55 - bills due by 2026-10-25 20895) / payroll 5200 = -1.65`. The duplicate Bean Brokers bill (A$5,500) is part of the problem, and `scan_issues` flags it. Next is **Northwind Joinery Ltd**, SHORTFALL: `coverage = (cash 7212.4 - bills due on or before 2026-10-25 9530) / payroll 12000 = -0.19`, headroom **-£14,317.60**. Harbour Bakery is ok: (28,420.35 - 4,150) / 9,000 = **2.70**. Then "Harbour's payroll is actually £20,000 on 8 October": expect coverage **1.31, tight** (only the £2,300 VAT bill falls before 8 Oct).

**4. "Make me Northwind's month-end pack."**
Expect an `.xlsx` named `northwind-joinery-ltd-month-end-2026-09-30.xlsx` with 3 sheets. Open it:
- *Aged Receivables*: 6 invoice rows, then a Total row of **Current 2,600.00 | 1-30 1,480.00 | 31-60 2,175.50 | 61-90 3,900.00 | 90+ 11,050.00 | Total 21,205.50**.
- *Bank Reconciliation*: Business Current Account, closing **7,212.40**, **7** unreconciled items, **6,495.24**.
- *P&L Snapshot*: Sep 26 income **23,300.00**, expenses **33,600.00**, net **-10,300.00**. The 6-month total net is **-900.00**.
For comparison, Harbour Bakery's pack shows an aged total of 8,150.00, 3 unreconciled items for 475.50, and a Sep net profit of 7,350.00.

**5. "Which of my clients are trending toward trouble, and why?"**
Expect **Northwind Joinery Ltd, score 10/100, at risk**, then **Kookaburra, 50** (payroll coverage, expense spike z = 9.58, unreconciled > 10% of cash). Northwind has six reasons. 90+ receivables are 52.1% of the total (-15). Payroll coverage is -0.19 (-25). Sep expenses of 33,600 are a spike against a trailing mean of 26,080 (sd 192.35, **z = 39.09**) (-15). The director's loan account grew 5,200 → 7,800 → 10,400 → 14,100 (-15). Unreconciled items of 6,495.24 compare with cash of 7,212.40 (-10). Income fell 27,200 → 26,400 → 24,900 → 23,300 (-10). Harbour Bakery scores **100, healthy** (expense z-score 0.34).

**6. "Give me the practice dashboard."**
Expect 3 clients, **total revenue (last 3 months) £145,100.00** (Harbour 70,500 + Northwind 74,600) **and A$52,500.00**, with **average DSO 18.9 days** (Harbour 10.6, Kookaburra 19.9, Northwind 26.2). Asking for 6 months gives **£300,100.00 and A$100,400.00**.

**7. Safety checks.**
"Make a pack for Ltd" should fail with "matches several orgs". `overdue_invoices` with `min_days: 45` should be rejected. "Disconnect Northwind" should be refused in demo mode. In live mode, `disconnect_org` previews first and acts only with `confirm=true`.

**8. "Which clients have unreconciled lines older than 7 days?"**
`unreconciled_items`: all three. Northwind has 7 lines (£6,495.24, oldest 3 Sep), Harbour 3 (£475.50) and Kookaburra 2 bank lines (A$2,620) plus 1 payment (A$1,100). With `older_than_days: 30`, only Kookaburra's A$1,980 Officeworks spend (51 days) is left.

**9. "Scan my client book for problems."**
`scan_issues`: **31 findings**, worth £14,537.41 and A$29,709.87 at risk. Kookaburra has 18, including: duplicate bill BB-7781 (A$5,500, high); KC-0990 paid twice (A$1,100); KC-1003 with no tax code (A$2,000); KC-1004 income coded BAS Excluded (A$330 GST); TEL-0925 GST 45 instead of 30; Suspense A$734.20; Repairs up 645%; ATO BAS bill 33 days overdue (A$2,950); a draft July accrual journal; KC-1005 draft for 41 days; three spends with no receipt; and the lock date stuck at 31 Mar. Northwind also shows "Materials up 72%".

**10. "Show me BAS/VAT readiness across the practice."** Then **"Are we ready to close September?"**
`tax_readiness` for Jul-Sep 2026: all three are **not ready**. Kookaburra's BAS has 4 blockers (missing tax code, 2 unreconciled lines, suspense), and both UK VAT returns are blocked by unreconciled lines. `close_readiness` scores Kookaburra 0, Northwind 70 and Harbour 80.

**11. "Prepare a journal clearing Kookaburra's suspense to rent."**
`prepare_manual_journal` (899 Dr 734.20 / 469 Cr 734.20) returns a preview and a phrase naming Kookaburra. `confirm_manual_journal` is **refused** ("Write-back is disabled") in the default install. With `XERO_AGG_ENABLE_WRITES=1` in demo mode it is **simulated** and shows the exact DRAFT payload. An unbalanced journal, an unknown account, a bank account, or a date on or before the 31 Mar lock date are all rejected.

**Live mode (optional).** Create a Xero app as above, set `XERO_CLIENT_ID` and `XERO_AGG_TOKEN_KEY`, and remove `XERO_AGG_DEMO`. Then ask "connect a client Xero org", approve the Demo Company, paste the redirect URL, and ask "list my Xero clients".

## Tests

```bash
npm ci
npm test                    # build + all suites
npm run test:integration    # real Xero API, see below
```

| Suite | Covers |
|---|---|
| `normalize.test.ts` | Xero date formats, numbers, invoice status filtering, part-payments, report parsing (P&L, Bank Summary, Balance Sheet), unreconciled grouping |
| `analytics.test.ts` | Ageing buckets and boundaries, cross-org overdue (incl. mixed currency), payroll formula and overrides, health rules, DSO, dashboard |
| `security-oauth.test.ts` | AES-GCM round-trip, wrong key, tampering, `0600` mode, PKCE S256, single-use state, Basic auth, rotation persisted, concurrent-refresh de-dup, read-only scope enforcement, live code path against recorded responses (GET-only, nothing financial on disk), 401/429 handling, revoke on disconnect |
| `xlsx.test.ts` | Opens the generated workbooks and checks sheet names, every row, the bucket totals (and that they equal the column sums), bank rec and P&L totals, and path traversal |
| `e2e.test.ts` | The reviewer scenarios above, over **stdio** and **Streamable HTTP** (plus 401s, `/health` and a forged OAuth callback) |
| `practice.test.ts` | v1.2: every planted issue found with exact values and links, configurable stale days, tax period and BAS/close readiness, all 16 `pull_data` resources, month-end workbook, `practice_scan`/`use_last`, write-back (validation, phrase must name the org, single use, simulated in demo, refused for read-only grants, live DRAFT `PUT` with the right tenant), audit file 0600, write scopes opt-in, `/connections` rename/revoke (never adds), rate limiter (5 concurrent, 60/min per tenant, daily cap, Retry-After, day-limit header), and false positives found live (recurring rent/cleaning/parking, part-month variance) |
| `live-regressions.test.ts` | Bugs found against the real Xero API in v1.0.1/v1.0.2: live Bank Summary `accountID` attribute, whole-month P&L periods (incl. 30-day month-ends), mixed live + sample orgs |
| `integration.xero.test.ts` | Real Xero API, skipped unless credentials are set |

**Integration tests (real Xero).** These are skipped unless `XERO_CLIENT_ID` and `XERO_AGG_TOKEN_KEY` are set, together with either `XERO_REFRESH_TOKEN` or an `XERO_AGG_TOKEN_FILE` created by connecting via `connect_org_start`/`connect_org_complete`. Web apps also need `XERO_CLIENT_SECRET`. The tests sync every connected org (e.g. the Demo Company), check that the normalized model is internally consistent, and write a pack. They only use GET requests. Xero rotates the refresh token on every use, so keep `XERO_AGG_TOKEN_FILE` on a persistent path between runs. The Demo Company's data changes when Xero resets it, so these tests check invariants rather than fixed numbers.

**Mixed live + sample orgs.** Set `XERO_AGG_EXTRA_FIXTURES=<path to fixtures/>` (with real Xero credentials) to show your connected orgs alongside the three sample orgs, labelled "(sample)". Useful when you only have one real org, such as the Xero Demo Company, and want to try the cross-org tools. Sample orgs are read from disk and never sent to Xero.

**Verified live (v1.0.1, 15 Oct 2026).** Every tool was run over MCP against a real Xero Demo Company (Global). Overdue totals, ageing buckets, bank closing balance and P&L totals in the .xlsx pack matched the raw Xero API responses to the cent.

**Verified live (v1.2.0, 15 Oct 2026).** Every read tool ran against the Demo Company (Global): see the changelog for what live testing changed. Write-back was only tested up to `prepare` live. No journal was sent to Xero.

The fixtures are synthetic data in Xero API response shape, generated by `fixtures/generate.mjs` (two UK orgs) and `fixtures/generate-v12.mjs` (Kookaburra, plus charts of accounts, tax rates, payments, manual journals and trial balances).

## Limitations

- "Unreconciled" uses Xero bank transactions and payments with `IsReconciled=false`. The public Accounting API does not expose imported bank statement lines that have not been matched or coded yet (Xero's bank-statement feeds are partner-only), so the real reconcile backlog can be larger than reported.
- `journals` (the full system journal) needs Xero's Advanced tier plus use-case approval. Without it, `pull_data` reports a 401/403 for that resource. Manual journals, the trial balance and payments use ordinary scopes.
- Xero's Aged Receivables/Payables reports take one contact at a time, so aged AR/AP are computed from open invoices and bills (they reconcile to the balance sheet, as verified live).
- Missing-document checks rely on Xero's `HasAttachments` flag. Documents kept in another system (Dext, Hubdoc) won't be seen.
- BAS/VAT readiness is a data-quality check. It does not prepare or file the return, and it assumes calendar-aligned periods.
- `XERO_AGG_SCAN_MINUTES` schedules scans only while the server process runs. For a dependable nightly scan, use your agent's routine/scheduler to call `practice_scan`.
- Payroll is estimated from P&L lines unless you set it, because Xero Payroll scopes are intentionally not requested.
- Reports cover the as-of month plus the 5 months before it. Expense z-scores therefore use up to 5 trailing months.
- Multi-currency orgs are reported in each org's base currency, and practice totals are kept per currency.

## Changelog

- **1.2.0**: Practice-scale release. Adds 11 tools: `pull_data`, `scan_issues` (14 checks), `unreconciled_items`, `tax_readiness`, `close_readiness`, `month_end_summary`, `practice_scan`, `prepare_manual_journal`, `confirm_manual_journal`, `list_proposals` and `audit_trail`. Also adds the `practice-scan` skill and the Kookaburra Coffee Co sample org. Per-org rate limiter (5 concurrent, 60/min, daily cap, Retry-After, `X-DayLimit-Remaining`); `/connections` refresh before syncs; local audit trail; opt-in DRAFT-only write-back. New read scopes: payments, manual journals, trial balance and aged reports. Fixed: the default scope list was being mutated in place. Live testing against the Demo Company changed three things. Recurring charges (monthly rent, weekly cleaning, daily parking) are no longer reported as duplicates, which cut findings from 66 to 23. Variances now use the last complete month, not the part month. BAS/VAT readiness now checks the period that just ended, not the open one. Demo totals now include the AUD org (see the reviewer plan).
- **1.1.0**: Renamed from xero-aggregator-mcp to ClientBooks Hub (repo now clientbooks-hub-mcp; the old GitHub URL redirects). Xero does not allow its name in third-party product names, so the product is now described as working with Xero. Logo is now a 1:1 square with a solid background plate. Env vars (`XERO_*`, `XERO_AGG_*`) and the default token folder `~/.xero-aggregator` are unchanged, so existing connections keep working.
- **1.0.2**: Fix from a second round of live testing. For a month-end on a 30-day month (or February), Xero cut every prior 31-day month in the P&L comparison to the 1st-30th, so the September pack under-reported 6-month income by 547.80. The P&L is now anchored on the next 31-day month and the extra column dropped. Regression test added.
- **1.0.1**: Fixes from live Xero testing. Bank accounts now pick up the `accountID` attribute live Xero returns, so unreconciled items are matched to the right account. P&L is requested for whole calendar months, because a mid-month as-of date made Xero compare half-months. Adds `XERO_AGG_EXTRA_FIXTURES` mixed mode. The integration test now cleans up its exported pack.
- **1.0.0**: First release.

## Development

```bash
npm ci && npm run build && npm test
npm run fixtures   # regenerate demo fixtures
```

## License

MIT © 2026 Paris Piotis
