# Uptracker — Realtime Website Downtime Monitor

A professional, free website uptime tracker with **server-side monitoring**, **Discord alerts**, **per-site PIN protection**, and **automatic Cloudflare DNS failover** — entirely on free hosting.

---

## Features

- 🖥 **Server-side monitoring** — Netlify scheduled function checks every 60s, 24/7, no browser needed
- ☁ **Persistent cloud storage** — GitHub Gist (free, survives cache clears, works across devices)
- 📊 **1-year history** — incident log with date filters (24h / 7d / 30d / 90d / 1yr / all time)
- 🔔 **Discord webhooks** — Offline Only or Online & Offline (heartbeat every check)
- 🔐 **Per-site PIN protection** — 4-digit PIN per site, master PIN `381998` for admin override
- 🔄 **Cloudflare DNS Failover (FREE)** — auto-switches DNS to maintenance page on downtime, restores when recovered
- 🛠 **Hosted maintenance page** — beautiful status page at `/maintenance` with live status polling and auto-redirect on recovery
- 📱 **Fully responsive** — works on all screen sizes
- ⚡ **Zero dependencies** — pure HTML/CSS/JS, no npm build step, works on any static host

---

## Architecture

```
Visitor
  │
  ▼
roiprofitacademy.in  ←── Cloudflare DNS (free)
  │                            │
  │   site UP: normal DNS      │   site DOWN: DNS switched to maintenance page
  │                            ▼
  │                   uptimetracker.netlify.app/maintenance
  │                            │
  ▼                            ▼
Real hosting server    Uptracker maintenance page
                       (polls Gist for live status,
                        auto-redirects when site recovers)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Background (every 60s):
Netlify Function → HEAD request to each site
                → writes result to GitHub Gist
                → if DOWN: PATCH Cloudflare DNS record
                → if UP (was down): PATCH DNS back
                → sends Discord alert
```

---

## Cloudflare DNS Failover Setup (Free — Step by Step)

### What it does
When Uptracker detects your site is **down**, it calls the Cloudflare API to switch your DNS record to point to our maintenance page. When your site **recovers**, it restores your DNS automatically. Visitors never see a broken page.

### Step 1 — Move DNS to Cloudflare (free)

1. Go to [cloudflare.com](https://cloudflare.com) → Create free account
2. Click **Add a Site** → enter your domain → select **Free plan**
3. Cloudflare will scan your existing DNS records
4. Go to your domain registrar (GoDaddy, Namecheap, etc.) → update nameservers to Cloudflare's provided nameservers
5. Wait 5–30 minutes for propagation

### Step 2 — Create an API Token

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use template: **Edit zone DNS**
4. Under Zone Resources: select **Specific zone** → choose your domain
5. Click **Continue to summary** → **Create Token**
6. **Copy the token** (shown only once)

### Step 3 — Get your Zone ID and DNS Record ID

**Zone ID:**
- Cloudflare Dashboard → your domain → **Overview** tab → scroll down → **Zone ID** (right side)

**DNS Record ID:**
- Go to your domain's **DNS** tab in Cloudflare
- Find the A or CNAME record for your root domain (e.g. `roiprofitacademy.in` → points to your server IP or hosting CNAME)
- You need the record's ID — get it via API:

```bash
curl https://api.cloudflare.com/client/v4/zones/YOUR_ZONE_ID/dns_records \
  -H "Authorization: Bearer YOUR_API_TOKEN" | python -m json.tool
```

Look for the record matching your domain. Copy its `"id"` field.

**Or use the "Test Connection" button in Uptracker** — it auto-fills the record name, type and original value for you.

### Step 4 — Configure in Uptracker

1. Open Uptracker → click ✏️ edit on your site
2. Scroll to **Cloudflare DNS Failover** section
3. Toggle it **ON**
4. Fill in:
   - **API Token** — the token from Step 2
   - **Zone ID** — from Step 3
   - **DNS Record ID** — from Step 3
   - **Record Name** — your domain (e.g. `roiprofitacademy.in`)
   - **Record Type** — `CNAME` (recommended) or `A`
   - **Original DNS Value** — click **"Test Connection"** to auto-fill this
   - **Maintenance URL** — leave blank to use our hosted page, or enter your own
5. Click **Test Connection** — confirms your token is valid and reads current DNS value
6. Click **Save Changes**

### Step 5 — Test it

The next time your site goes offline, Cloudflare DNS will automatically switch within ~60 seconds. Visitors will see your maintenance page instead of a broken error.

---

## Maintenance Page

Hosted at: `https://uptimetracker.netlify.app/maintenance`

**Features:**
- Shows your site name, favicon, and current status
- Polls Gist every 30s for live status updates
- Progress bar showing uptime history
- When site recovers: shows "Back Online!" with 5-second countdown then auto-redirects visitors to your real site

**Query parameters (added automatically by Uptracker):**
```
?id=site_id&name=Site+Name&url=https://yoursite.com
```

**Custom maintenance page:** You can use your own URL in the settings — any URL works, Uptracker will point DNS there during outages.

---

## Storage (GitHub Gist)

All data lives in a single private GitHub Gist as JSON:

```json
{
  "sites": [{
    "id": "site_...",
    "name": "ROI Profit Academy",
    "url": "https://roiprofitacademy.in",
    "interval": 30,
    "webhookUrl": "https://discord.com/api/webhooks/...",
    "alertMode": "both",
    "pinHash": "a1b2c3d4",
    "cfEnabled": true,
    "cfZoneId": "...",
    "cfRecordId": "...",
    "cfOriginalContent": "your-server.hosting.com",
    "cfFailoverActive": false
  }],
  "checks":    { "site_id": [{ "ts": 1234, "status": "up", "ms": 340 }] },
  "incidents": { "site_id": [{ "ts": 1234, "status": "down", "event": "..." }] }
}
```

---

## PIN Security

Each site is protected by a 4-digit PIN set when adding the site.

| Action | Requires |
|---|---|
| Edit settings | Site PIN or master PIN |
| Delete site | Site PIN or master PIN |
| Change PIN | Current PIN or master PIN |
| All actions | Master PIN `381998` always works |

PINs are hashed (djb2) before storage — never stored in plaintext.

---

## Deploy (Free Hosting)

### Netlify (recommended)
1. Fork/push to GitHub
2. Connect to Netlify → auto-deploys on every push
3. Set environment variables in **Site config → Environment variables:**

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | Your GitHub PAT (gist scope) |
| `GIST_ID` | Your Gist ID |

4. The scheduled function (`netlify/functions/monitor.js`) runs automatically every minute

### GitHub Pages
```
Settings → Pages → Deploy from branch main / public folder
```
Note: GitHub Pages does not run the scheduled function. Use Netlify for full server-side monitoring.

---

## Project Structure

```
uptracker/
├── public/
│   ├── index.html          # Dashboard
│   ├── maintenance.html    # Hosted maintenance page
│   ├── style.css           # All styles
│   ├── app.js              # Dashboard UI + Gist client
│   ├── config.js           # Generated at build — GitHub token + Gist ID
│   └── assets/icons/favicon.svg
├── netlify/
│   └── functions/
│       └── monitor.js      # Scheduled function — checks, DNS failover, Discord
├── netlify.toml            # Netlify build config + headers
├── build.js                # Generates config.js from env vars
├── package.json
└── README.md
```

---

## FAQ

**Q: Does Cloudflare DNS failover work on the free plan?**
Yes. Cloudflare's free plan includes full DNS API access with no API call limits. DNS TTL minimum is 1 minute on free plan, so failover happens within ~60–120 seconds of detection.

**Q: What if I can't move my DNS to Cloudflare?**
The rest of Uptracker still works fully — monitoring, Discord alerts, incident history, PIN protection. DNS failover is optional.

**Q: How long does DNS failover take?**
- Detection: up to 60 seconds (server checks every minute)
- DNS API call: ~1 second
- DNS propagation: 60 seconds (TTL=60, Cloudflare's minimum on free plan)
- **Total: ~2 minutes worst case**

**Q: Will the maintenance page auto-redirect when my site recovers?**
Yes — it polls the Gist every 30 seconds, detects the `lastStatus: "up"` change, shows a 5-second countdown, then `window.location.replace()` to your real site.

**Q: Is the GitHub token safe in config.js?**
The token has only `gist` scope — it can only read/write your private Gist. It cannot access repositories, make commits, or do anything else. It's safe to include in a deployed static site.

---

## License

MIT
