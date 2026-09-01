# Uptracker — Cloudflare Worker

Provides **instant** (< 1 second) redirect to maintenance page when your site is down.

## How it works

```
Visitor requests proh.top
        ↓
Cloudflare Edge (0ms) runs this Worker
        ↓
Worker checks cached site status (30s cache)
        ↓
Status = DOWN  → 302 redirect to maintenance page (instant)
Status = UP    → pass request through to your server
```

## Deploy Steps

### Step 1 — Create the Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **Workers & Pages** → **Create Application** → **Create Worker**
3. Name it `uptracker-worker`
4. Click **Deploy** (with default code for now)
5. Click **Edit Code** → paste the contents of `worker.js` → **Save and Deploy**

### Step 2 — Set Environment Variables

In the Worker settings → **Variables** → **Add variable**:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | Your GitHub PAT (gist scope) |
| `GIST_ID` | `6460a6dfda90fbea4aae70f0ef973bfb` |
| `GIST_FILE` | `uptracker_data.json` |
| `SITE_URL` | `https://proh.top` |
| `SITE_NAME` | `PROH TOP` |
| `MAINTENANCE` | `https://uptimetracker.netlify.app/maintenance` |

Mark `GITHUB_TOKEN` as **Secret**.

### Step 3 — Add Route

1. Go to **Websites** → click your domain (`proh.top`)
2. Click **Workers Routes** → **Add Route**
3. Route: `proh.top/*`
4. Worker: `uptracker-worker`
5. Click **Save**

### Step 4 — Test

Visit `proh.top` — it passes through normally.

To test failover: temporarily set `lastStatus: "down"` in your Gist, visit the site — you'll be redirected to the maintenance page within 30 seconds (cache TTL).

## How it differs from DNS failover

| Method | Detection | Redirect | Requires |
|---|---|---|---|
| DNS Failover | 60s (Netlify check) | 60s DNS propagation | CF API token |
| **Cloudflare Worker** | **30s (cache TTL)** | **Instant (0ms)** | **GitHub token only** |

The Worker is better because:
- No DNS propagation delay (instant 302 redirect)
- No CF API token needed (just GitHub token)
- Works even if Netlify function is slow
- Runs on Cloudflare's global edge (every PoP worldwide)
