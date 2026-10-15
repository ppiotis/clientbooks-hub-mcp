---
name: connect-xero-orgs
description: How to connect, list, re-sync and disconnect client Xero organisations with the xero-aggregator tools. Use when the user wants to add a client's Xero org, sees "no organisations connected", or asks why data looks stale.
---

# Connecting client Xero orgs

The aggregator only ever has **read-only** access. Each client (or the accountant, if they are an adviser user on the client's Xero) approves the connection in Xero's own consent screen.

1. `list_orgs` first. If `mode` is `demo`, two fixture orgs are already there; tell the user it is demo data and that live mode needs `XERO_CLIENT_ID` and `XERO_AGG_TOKEN_KEY` (README > Xero app setup).
2. To add an org: `connect_org_start` → give the user the `authorize_url`. Say plainly: "This opens Xero. Choose the client organisation and click Allow. It only grants read access."
3. After they approve, the browser lands on the redirect URL. If the server runs over HTTP, the `/oauth/callback` page finishes it automatically. Otherwise ask them to paste the full URL they landed on (even if the page shows an error), then call `connect_org_complete` with it.
4. The sign-in link expires after 10 minutes and works once. On "Unknown or expired state", start again.
5. One Xero approval can cover several orgs; each appears separately in `list_orgs`.

Data freshness: data is re-synced every `poll_interval_minutes`. If the user says figures are stale or they just posted something in Xero, call `sync_now`. If an org shows `synced: false`, quote its `error`; a 401/403 usually means the client removed access, so they should reconnect.

Disconnecting: `disconnect_org` with `confirm=false` first, show the preview, and only call with `confirm=true` after the user says yes.

Never ask the user to paste client secrets, access tokens or refresh tokens into the chat. Those belong in environment variables.
