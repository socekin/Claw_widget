# OpenClaw Widget Bridge

Minimal HTTP bridge for iOS widgets (or any client) to fetch a safe OpenClaw summary.

## What This Plugin Does

This plugin exposes one authenticated endpoint:

- `GET /widget/summary`

It returns:

- Gateway health status
- Usage summary (tokens + estimated USD cost)
- Daily usage points for charting (`date`, `tokens`, `totalCostUsd`)

It does **not** expose:

- Raw session transcripts
- User identifiers
- Internal channel/session APIs

## Architecture

```text
iOS Widget / Mobile App
        |
        | HTTPS + Bearer Token
        v
Cloudflare Tunnel (optional)
        |
        v
OpenClaw Gateway + Plugin Route (/widget/summary)
        |
        +-- openclaw gateway call health --json
        +-- openclaw gateway call usage.cost --json --params '{"days": N}'
```

## Requirements

- Linux server (or host) running OpenClaw Gateway
- `openclaw` CLI available in `PATH`
- Optional: Cloudflare Tunnel for public HTTPS URL

## Install (Link Mode)

```bash
openclaw plugins install -l ~/Claw-Widget
openclaw plugins list
```

## Configure

### 1) Generate and store API token

```bash
TOKEN_FILE="$HOME/.openclaw/widget-token.txt"
[ -f "$TOKEN_FILE" ] || (openssl rand -hex 32 > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE")
WIDGET_TOKEN="$(cat "$TOKEN_FILE")"
```

### 2) Write plugin config

```bash
openclaw config set plugins.entries.openclaw-widget-bridge.enabled true
openclaw config set plugins.entries.openclaw-widget-bridge.config.apiToken "$WIDGET_TOKEN"
openclaw config set plugins.entries.openclaw-widget-bridge.config.cliPath "$(command -v openclaw)"
openclaw config set plugins.entries.openclaw-widget-bridge.config.timeoutMs 8000
openclaw config set plugins.entries.openclaw-widget-bridge.config.usageDays 30
```

### 3) Restart gateway

```bash
openclaw gateway restart
openclaw gateway status
```

## How to Get Token and URL

### Get token (for clients)

```bash
WIDGET_TOKEN="$(openclaw config get plugins.entries.openclaw-widget-bridge.config.apiToken | tr -d '\"[:space:]')"
echo "$WIDGET_TOKEN"
```

### Get URL

Use one of these:

1. Local URL (same machine / private network)

```text
http://127.0.0.1:18789/widget/summary
```

2. Stable production URL (Cloudflare Named Tunnel)

Follow the full setup below to expose only `/widget/summary` via HTTPS.

#### Step A: Install and authenticate `cloudflared`

Install guide: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Then authenticate:

```bash
cloudflared tunnel login
```

This opens a browser flow and stores tunnel credentials on the server.

#### Step B: Create a named tunnel and DNS record

```bash
cloudflared tunnel create openclaw-widget
cloudflared tunnel route dns openclaw-widget widget.example.com
```

Replace `widget.example.com` with your real domain/subdomain in Cloudflare DNS.

#### Step C: Create `/etc/cloudflared/config.yml`

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /root/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: widget.example.com
    path: ^/widget/summary$
    service: http://127.0.0.1:18789
  - service: http_status:404
```

Notes:

- Keep the `path` rule strict so only `/widget/summary` is exposed.
- Replace `<TUNNEL_UUID>` with the value returned by `cloudflared tunnel create`.
- If your `cloudflared` user is not `root`, adjust `credentials-file` path.

#### Step D: Run as a service (recommended)

```bash
cloudflared service install
systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

#### Step E: Verify endpoint access

```bash
WIDGET_TOKEN="$(openclaw config get plugins.entries.openclaw-widget-bridge.config.apiToken | tr -d '\"[:space:]')"

curl -sS -H "Authorization: Bearer $WIDGET_TOKEN" \
  "https://widget.example.com/widget/summary?days=7" | jq
```

You should get a `200` JSON response with `ok: true`.

#### Step F: Basic production hardening checklist

- Keep only `widget.example.com` DNS proxied by Cloudflare.
- Do not expose `:18789` directly on public interfaces.
- Rotate widget token periodically.
- Restrict ingress path to `/widget/summary` only.

## Endpoint Reference

### `GET /widget/summary`

Headers:

- `Authorization: Bearer <apiToken>`

Query params:

- `days` (optional): integer `1-90`

### Example request

```bash
WIDGET_TOKEN="$(openclaw config get plugins.entries.openclaw-widget-bridge.config.apiToken | tr -d '\"[:space:]')"

curl -sS -H "Authorization: Bearer $WIDGET_TOKEN" \
  "http://127.0.0.1:18789/widget/summary?days=7" | jq
```

### Example success response

```json
{
  "ok": true,
  "updatedAt": 1771483190719,
  "health": {
    "status": "up",
    "latencyMs": 578,
    "checkedAt": 1771483159633
  },
  "usage": {
    "days": 7,
    "startDate": "2026-02-14",
    "endDate": "2026-02-20",
    "totalTokens": 123456,
    "totalCostUsd": 1.2345,
    "daily": [
      {
        "date": "2026-02-19",
        "tokens": 23456,
        "totalCostUsd": 0.2345
      }
    ],
    "updatedAt": 1771482216439
  }
}
```

### Error responses

- `401` + `{"ok":false,"error":"unauthorized"}`: missing/invalid token
- `405` + `{"ok":false,"error":"method_not_allowed"}`: non-GET request
- `500` + `{"ok":false,"error":"plugin_not_configured"}`: missing plugin token config

## Security and Privacy

- Use a long random token (32-byte hex or stronger).
- Store token with strict file permissions (`chmod 600`).
- Rotate token periodically and update all clients.
- Prefer HTTPS only (Tunnel / reverse proxy with TLS).
- Expose only `/widget/summary` in ingress rules.
- Do not log full authorization headers in proxies.
- Keep OpenClaw and cloudflared updated.
- Data minimization: this API returns only health + aggregated usage; no transcript payload is exposed.

## iOS Integration Notes

- Pull over HTTPS on a schedule (no WebSocket needed).
- Suggested refresh interval: `15-30 minutes`.
- Cache the last successful payload in App Group storage.
- On non-200 responses, show stale cache with an "outdated" hint.
- For charts, use `usage.daily[].date` as X-axis and `tokens` or `totalCostUsd` as Y-axis.

## Ops Notes

- `usage.cost` values are estimated from model pricing config and may differ from provider invoices.
- Large `days` windows and very frequent polling can increase CPU usage.
