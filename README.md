<p align="center"><img src="logo.svg" width="96" alt="Xero Practice Aggregator logo"></p>

# Xero Practice Aggregator MCP

[![CI](https://github.com/ppiotis/xero-aggregator-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ppiotis/xero-aggregator-mcp/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

**One view across every client's Xero org, for accountants and bookkeepers.** Each client connects their own Xero organisation, read-only. Your agent can then answer practice-wide questions that Xero itself can't: *which clients have invoices more than 90 days overdue, who is closest to missing payroll, which clients are trending toward trouble, and what is my practice's total revenue and average DSO.* It also produces a **ready-to-send Excel month-end pack** per client.

This is **not** a general-purpose Xero plugin. It has no write access to Xero at all.

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

Three skills ship with the plugin and teach the agent how to use these tools: `connect-xero-orgs`, `practice-review` and `month-end-pack`.

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
    "xero-aggregator": {
      "command": "npx",
      "args": ["-y", "https://github.com/ppiotis/xero-aggregator-mcp/archive/refs/tags/v1.0.2.tar.gz"],
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
git clone https://github.com/ppiotis/xero-aggregator-mcp && cd xero-aggregator-mcp
npm ci && npm run build
export XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... XERO_AGG_TOKEN_KEY="$(openssl rand -base64 32)"
export XERO_REDIRECT_URI=https://your-host/oauth/callback MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export HOST=0.0.0.0 PORT=3000 XERO_AGG_TOKEN_FILE=/data/tokens.enc XERO_AGG_EXPORT_DIR=/data/exports
npm run start:http        # MCP endpoint: https://your-host/mcp, health: /health
```
Or use `docker build -t xero-aggregator . && docker run -p 3000:3000 -v xagg:/data -e ... xero-aggregator`. Put it behind HTTPS, and connect your MCP client to `https://your-host/mcp` with header `Authorization: Bearer $MCP_AUTH_TOKEN`. The server is single-practice: one deployment holds one practice's connections. Don't share an instance between practices.

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
| `MCP_AUTH_TOKEN` | none | Bearer token required on `/mcp` (HTTP mode). Always set this on a server |

## Xero app setup

1. Go to [developer.xero.com/app/manage](https://developer.xero.com/app/manage), then **New app**.
2. For local use choose **Mobile or desktop app** (PKCE, no secret). For a server choose **Web app** and set `XERO_CLIENT_SECRET`.
3. Set the redirect URI to exactly your `XERO_REDIRECT_URI`.
4. Copy the client id into `XERO_CLIENT_ID`.
5. Scopes requested (read-only, granular, as required for apps created on or after 2 March 2026):
   `openid profile email offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.banktransactions.read accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.reports.banksummary.read`.
   Older apps can use `XERO_SCOPE_SET=broad` (`accounting.transactions.read accounting.reports.read`), which works until Xero's 13 September 2027 deadline. If Xero's consent screen reports an invalid scope, set `XERO_SCOPES` explicitly.
6. To try it, connect Xero's **Demo Company** (in Xero: *My Xero → Try the Demo Company*), then ask the agent to "connect a client Xero org".

Xero limits each app to 60 calls per minute per org and 5 concurrent calls. The poller syncs orgs one at a time (about 7 calls per org), honours `Retry-After` on 429 responses, and refreshes tokens once on a 401.

## Security & privacy

- **Read-only.** The server only requests `.read` scopes; config that asks for anything else is rejected at startup. Every Xero API call is a `GET` (tested). The only non-GET is `DELETE /connections/{id}`, used by `disconnect_org` to revoke its own access.
- **Tokens only on disk.** The token file holds OAuth tokens plus tenant ids and names, encrypted with **AES-256-GCM** under a key derived by scrypt from `XERO_AGG_TOKEN_KEY`. It is written atomically with mode `0600`. A wrong key or a tampered file fails closed.
- **No financial data persisted.** Invoices, bills, contacts, balances and reports are normalized into an **in-memory cache only**, so a restart clears them. A test asserts that after a full sync the only file on disk is the encrypted token file, and that it contains no customer names or invoice numbers. The single exception is the month-end pack you explicitly ask for, written to `XERO_AGG_EXPORT_DIR` (filenames are slugged; path traversal is tested).
- **OAuth done properly.** Authorization code with PKCE S256, a single-use `state` that expires after 10 minutes, and **refresh-token rotation**: every refresh stores the new refresh token, and concurrent refreshes are de-duplicated so a rotated token is never reused. The client secret is sent via HTTP Basic only when configured.
- **HTTP mode.** `/mcp` requires `Authorization: Bearer $MCP_AUTH_TOKEN`, compared in constant time, with a 1 MB body limit. `/oauth/callback` is protected by the PKCE state, and it never echoes codes or tokens back.
- **No telemetry, no third parties.** The server only contacts `login.xero.com`, `identity.xero.com` and `api.xero.com`.
- **Secrets never go in chat.** Configure them as environment variables; the skills tell the agent never to ask for tokens.

## Reviewer test plan

Everything below runs in **demo mode** (the default `.mcp.json`), as an accountant opening the plugin for the first time. The data is as at **2026-09-30**, in GBP.

**1. "List my Xero clients."**
Expect `list_orgs` to show 2 orgs: **Harbour Bakery Ltd** (5 open invoices, 3 open bills, 2 bank accounts) and **Northwind Joinery Ltd** (6 open invoices, 4 open bills, 1 bank account), `mode: "demo"`.

**2. "Show me every invoice more than 30 days overdue across all my clients." Then "...and over 90?"**
Expect **6 invoices totalling £20,435.50**: Harbour Bakery 2 (£3,310.00), Northwind 4 (£17,125.50). The most overdue is **INV-B101, Oakridge Homes, 112 days, £6,800.00 due**. It's a part-paid £8,800 invoice, so check the amount due is used, not the total. Over 60 days: 4 invoices, £15,810.00. Over 90 days: **2 invoices (INV-B101, INV-B102), £11,050.00**, both Northwind. Draft and voided invoices in the fixtures (INV-A006, INV-B107) must not appear.

**3. "Which client is closest to missing payroll? Show the working."**
Expect **Northwind Joinery Ltd**, SHORTFALL: `coverage = (cash 7212.4 - bills due on or before 2026-10-25 9530) / payroll 12000 = -0.19`, headroom **-£14,317.60**. Harbour Bakery is ok: (28,420.35 - 4,150) / 9,000 = **2.70**. Then "Harbour's payroll is actually £20,000 on 8 October": expect coverage **1.31, tight** (only the £2,300 VAT bill falls before 8 Oct).

**4. "Make me Northwind's month-end pack."**
Expect an `.xlsx` named `northwind-joinery-ltd-month-end-2026-09-30.xlsx` with 3 sheets. Open it:
- *Aged Receivables*: 6 invoice rows, then a Total row of **Current 2,600.00 | 1-30 1,480.00 | 31-60 2,175.50 | 61-90 3,900.00 | 90+ 11,050.00 | Total 21,205.50**.
- *Bank Reconciliation*: Business Current Account, closing **7,212.40**, **7** unreconciled items, **6,495.24**.
- *P&L Snapshot*: Sep 26 income **23,300.00**, expenses **33,600.00**, net **-10,300.00**. The 6-month total net is **-900.00**.
For comparison, Harbour Bakery's pack shows an aged total of 8,150.00, 3 unreconciled items for 475.50, and a Sep net profit of 7,350.00.

**5. "Which of my clients are trending toward trouble, and why?"**
Expect only **Northwind Joinery Ltd, score 10/100, at risk**, with six reasons. 90+ receivables are 52.1% of the total (-15). Payroll coverage is -0.19 (-25). Sep expenses of 33,600 are a spike against a trailing mean of 26,080 (sd 192.35, **z = 39.09**) (-15). The director's loan account grew 5,200 → 7,800 → 10,400 → 14,100 (-15). Unreconciled items of 6,495.24 compare with cash of 7,212.40 (-10). Income fell 27,200 → 26,400 → 24,900 → 23,300 (-10). Harbour Bakery scores **100, healthy** (expense z-score 0.34).

**6. "Give me the practice dashboard."**
Expect 2 clients, **total revenue (last 3 months) £145,100.00** (Harbour 70,500 + Northwind 74,600), and **average DSO 18.4 days** (Harbour 10.6, Northwind 26.2). Asking for 6 months gives **£300,100.00**.

**7. Safety checks.**
"Make a pack for Ltd" should fail with "matches several orgs". `overdue_invoices` with `min_days: 45` should be rejected. "Disconnect Northwind" should be refused in demo mode. In live mode, `disconnect_org` previews first and acts only with `confirm=true`.

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
| `live-regressions.test.ts` | Bugs found against the real Xero API in v1.0.1/v1.0.2: live Bank Summary `accountID` attribute, whole-month P&L periods (incl. 30-day month-ends), mixed live + sample orgs |
| `integration.xero.test.ts` | Real Xero API, skipped unless credentials are set |

**Integration tests (real Xero).** These are skipped unless `XERO_CLIENT_ID` and `XERO_AGG_TOKEN_KEY` are set, together with either `XERO_REFRESH_TOKEN` or an `XERO_AGG_TOKEN_FILE` created by connecting via `connect_org_start`/`connect_org_complete`. Web apps also need `XERO_CLIENT_SECRET`. The tests sync every connected org (e.g. the Demo Company), check that the normalized model is internally consistent, and write a pack. They only use GET requests. Xero rotates the refresh token on every use, so keep `XERO_AGG_TOKEN_FILE` on a persistent path between runs. The Demo Company's data changes when Xero resets it, so these tests check invariants rather than fixed numbers.

**Mixed live + sample orgs.** Set `XERO_AGG_EXTRA_FIXTURES=<path to fixtures/>` (with real Xero credentials) to show your connected orgs alongside the two sample orgs, labelled "(sample)". Useful when you only have one real org, such as the Xero Demo Company, and want to try the cross-org tools. Sample orgs are read from disk and never sent to Xero.

**Verified live (v1.0.1, 15 Oct 2026).** Every tool was run over MCP against a real Xero Demo Company (Global). Overdue totals, ageing buckets, bank closing balance and P&L totals in the .xlsx pack matched the raw Xero API responses to the cent.

The fixtures are synthetic data in Xero API response shape, generated by `fixtures/generate.mjs`.

## Limitations

- "Unreconciled" uses Xero bank transactions with `IsReconciled=false`. The Accounting API does not expose unmatched bank statement lines.
- Payroll is estimated from P&L lines unless you set it, because Xero Payroll scopes are intentionally not requested.
- Reports cover the as-of month plus the 5 months before it. Expense z-scores therefore use up to 5 trailing months.
- Multi-currency orgs are reported in each org's base currency, and practice totals are kept per currency.

## Changelog

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
