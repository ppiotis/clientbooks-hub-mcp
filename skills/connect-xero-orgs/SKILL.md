---
name: connect-xero-orgs
description: How to connect, list, re-sync and disconnect client Xero organisations with the ClientBooks Hub tools. Use when the user wants to add a client's Xero org, sees "no organisations connected", or asks why data looks stale.
---

# Connecting client Xero orgs

ClientBooks Hub is **read-only** by default (the only possible write is an opt-in DRAFT manual journal; see the practice-scan skill). Each client (or the accountant, if they are an adviser user on the client's Xero) approves the connection in Xero's own consent screen.

1. `list_orgs` first. If `mode` is `demo`, three sample orgs are already there (Harbour Bakery, Kookaburra Coffee, Northwind Joinery); tell the user it is demo data and that live mode needs `XERO_CLIENT_ID` and `XERO_AGG_TOKEN_KEY` (README > Xero app setup).
2. To add an org: `connect_org_start` → give the user the `authorize_url`. Say plainly: "This opens Xero. Choose the client organisation and click Allow. It only grants read access."
3. After they approve, the browser lands on the redirect URL. If the server runs over HTTP, the `/oauth/callback` page finishes it automatically. Otherwise ask them to paste the full URL they landed on (even if the page shows an error), then call `connect_org_complete` with it.
4. The sign-in link expires after 10 minutes and works once. On "Unknown or expired state", start again.
5. One Xero approval can cover several orgs: tell the accountant to tick every client org they have adviser access to on Xero's consent screen. Each appears separately in `list_orgs` with its `org_id` (tenant id), and every tool then works across all of them without signing in again.
6. If an org was renamed or the client revoked access in Xero, `list_orgs` with `refresh_connections: true` re-reads Xero's connections list and updates/drops it. It never adds orgs; new ones always go through steps 2-3.
7. If the user wants write-back (draft journals), `XERO_AGG_ENABLE_WRITES=1` must be set and the org reconnected; `connect_org_start` shows `write_back_enabled`.

Data freshness: data is re-synced every `poll_interval_minutes`. If the user says figures are stale or they just posted something in Xero, call `sync_now`. If an org shows `synced: false`, quote its `error`; a 401/403 usually means the client removed access, so they should reconnect.

Disconnecting: `disconnect_org` with `confirm=false` first, show the preview, and only call with `confirm=true` after the user says yes.

Never ask the user to paste client secrets, access tokens or refresh tokens into the chat. Those belong in environment variables.
