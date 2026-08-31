# Uptracker — Realtime Website Downtime Monitor

A professional, free website uptime tracker with **server-side monitoring**, **Discord alerts**, **per-site PIN protection**, and **automatic Cloudflare DNS failover** — entirely on free hosting.

---

## Features

| Feature | Details |
|---|---|
| 🖥 Server-side monitoring | Netlify scheduled function, runs every 60s, 24/7, no browser needed |
| ☁ Persistent cloud storage | GitHub Gist — survives cache clears, works across all devices |
| 📊 1-year history | Incident log with date filters: 24h / 7d / 30d / 90d / 1yr / all time |
| 🔔 Discord webhooks | Offline Only or Online & Offline (heartbeat on every check) |
| 🔐 Per-site PIN protection | 4-digit PIN per site, master PIN `381998` for admin override |
| 🔄 Cloudflare DNS Failover | **Free** — auto-switches DNS to maintenance page on downtime, auto-restores on recovery |
| 🛠 Hosted maintenance page | `/maintenance` — live status polling, auto-redirect when site recovers |
| 📱 Fully responsive | Mobile, tablet, desktop |
| ⚡ Zero build step | Pure HTML/CSS/JS — deploys on any static host |

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                    EVERY 60 SECONDS (server)                    │
│                                                                 │
│  Netlify Function                                               │
│       │                                                         │
│       ├── HEAD request → each site                              │
│       ├── Write result → GitHub Gist (persistent storage)       │
│       ├── Status changed to DOWN?                               │
│       │     ├── PATCH Cloudflare DNS → maintenance page         │
│       │     └── Send Discord alert 🔴                           │
│       └── Status changed to UP (was down)?                      │
│             ├── PATCH Cloudflare DNS → restore original         │
│             └── Send Discord alert ✅                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    VISITOR EXPERIENCE                           │
│                                                                 │
│  Site UP:   visitor → roiprofitacademy.in → real server         │
│                                                                 │
│  Site DOWN: visitor → roiprofitacademy.in → Cloudflare DNS      │
│                            (switched by Uptracker)              │
│                        → maintenance.html (our hosted page)     │
│                        → polls Gist every 30s for status        │
│                        → site recovers → auto-redirect back     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Cloudflare DNS Failover — Full Setup Guide (Free)

### What actually happens

Your domain (`roiprofitacademy.in`) uses an **A record** pointing to your hosting server IP.

When Uptracker detects the site is **down**:
1. Calls Cloudflare API → changes the A record to a **CNAME** pointing to `uptimetracker.netlify.app`
2. Cloudflare "CNAME flattening" resolves this at the root domain automatically (free feature)
3. Visitors now land on the Uptracker maintenance page instead of a broken site

When the site comes back **up**:
1. Calls Cloudflare API → restores the original **A record** with your real server IP
2. Traffic flows back to your server normally

Total failover time: **~2 minutes** (60s detection + 1s API + ~60s DNS propagation at TTL=60)

---

### Step 1 — Move DNS to Cloudflare (free, one-time)

1. Go to [cloudflare.com](https://cloudflare.com) → create a free account
2. Click **Add a Site** → enter your domain → select **Free plan**
3. Cloudflare scans your existing DNS records automatically
4. Log into your **domain registrar** (GoDaddy, Namecheap, etc.) → change nameservers to the two Cloudflare provides
5. Wait 5–30 minutes for propagation

> Your existing DNS records (A records, MX, etc.) are imported automatically. Nothing breaks.

---

### Step 2 — Create a Cloudflare API Token

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Click **Use template** next to **"Edit zone DNS"**
4. Set **Zone Resources** → Include → **Specific zone** → select your domain
5. Leave Client IP Filtering and TTL empty
6. Click **Continue to summary** → **Create Token**
7. **Copy the token immediately** — it's shown only once

The token only has permission to edit DNS on that one domain. Nothing else.

---

### Step 3 — Find your Zone ID and DNS Record ID

**Zone ID** — Cloudflare Dashboard → click your domain → **Overview** tab → scroll to bottom right → copy **Zone ID**

**DNS Record ID** — run this in terminal (replace with your values):

```bash
curl "https://api.cloudflare.com/client/v4/zones/YOUR_ZONE_ID/dns_records" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

Look for the `A` record matching your root domain. Copy its `"id"` value.

**Or just use the "Test Connection" button in Uptracker** — it calls the API for you and auto-fills all fields including the original IP.

---

### Step 4 — Configure in Uptracker

1. Open Uptracker → click ✏️ edit on your site (enter PIN if set)
2. Scroll to **Cloudflare DNS Failover** section
3. Toggle the switch **ON**
4. Fill in:

| Field | What to enter |
|---|---|
| API Token | Token from Step 2 |
| Zone ID | From Step 3 or Cloudflare dashboard |
| DNS Record ID | From Step 3 (the A record for your root domain) |
| Record Name | Your domain e.g. `roiprofitacademy.in` |
| Record Type | `A` (if your hosting uses an IP address) |
| Original DNS Value | Your server IP e.g. `103.49.70.235` |
| Maintenance URL | Leave blank to use our page, or enter your own URL |

5. Click **Test Connection** — validates your token and auto-fills the record details
6. Click **Save Changes**

---

### Step 5 — Verify it works

The next time your hosting goes down, within ~2 minutes:
- Cloudflare DNS switches to point to the maintenance page
- Visitors see a professional maintenance page instead of a browser error
- The maintenance page polls live status every 30s
- When hosting recovers, DNS restores automatically and visitors are redirected

---

## Maintenance Page

Hosted at `https://uptimetracker.netlify.app/maintenance`

- Shows site name, favicon, current status badge
- Uptime percentage and last response time from server checks
- Polls GitHub Gist every 30s for live status updates
- When site recovers → "Back Online! Redirecting in 5s…" → `window.location.replace()` to real site

**URL format (added automatically):**
```
https://uptimetracker.netlify.app/maintenance?id=SITE_ID&name=Site+Name&url=https://yoursite.com
```

**Custom maintenance URL:** You can enter any URL in the settings. During downtime, Cloudflare DNS will point to whatever you specify.

---

## Discord Alerts

Two modes per site:

| Mode | When alerts fire |
|---|---|
| **Offline Only** | Once when site goes DOWN |
| **Online & Offline** | On DOWN, on recovery, AND a heartbeat on every server check |

Alert embeds include: URL, status, response time, HTTP code, uptime %, outage count, IST timestamp, DNS failover status.

---

## PIN Security

Each site gets a 4-digit PIN when added. The PIN gates editing and deletion.

| Action | Requires |
|---|---|
| Edit site settings | Site PIN **or** master PIN |
| Delete site | Site PIN **or** master PIN |
| Change PIN | Current site PIN **or** master PIN |
| Override anything | Master PIN `381998` |

PINs are hashed with djb2 before storage — never stored as plaintext.

**For sites added before the PIN feature:** no PIN is set. The edit button opens directly. Use "Change PIN" inside the edit modal (enter master PIN as current PIN) to add protection.

---

## Storage Schema (GitHub Gist)

All data is one JSON file in a private Gist:

```json
{
  "version": 4,
  "savedAt": "2026-08-31T...",
  "sites": [
    {
      "id":               "site_1234_abcde",
      "name":             "ROI Profit Academy",
      "url":              "https://roiprofitacademy.in",
      "interval":         30,
      "webhookUrl":       "https://discord.com/api/webhooks/...",
      "alertMode":        "both",
      "pinHash":          "a1b2c3d4",

      "cfEnabled":        true,
      "cfApiToken":       "cfut_...",
      "cfZoneId":         "67966e6893f243b57726a65f1e3d262f",
      "cfRecordId":       "38242dd2bef59b346ffb87963eebc822",
      "cfRecordName":     "roiprofitacademy.in",
      "cfRecordType":     "A",
      "cfOriginalContent":"103.49.70.235",
      "cfOriginalType":   "A",
      "cfOriginalTtl":    1,
      "cfProxied":        true,
      "cfMaintenanceUrl": "",
      "cfFailoverActive": false,

      "lastStatus":    "up",
      "lastMs":        340,
      "lastCode":      200,
      "lastChecked":   "2026-08-31T..."
    }
  ],
  "checks": {
    "site_1234_abcde": [
      { "ts": 1234567890, "status": "up", "ms": 340 }
    ]
  },
  "incidents": {
    "site_1234_abcde": [
      { "ts": 1234567890, "status": "down", "ms": 10000, "code": null, "event": "🔴 Site went down" }
    ]
  }
}
```

---

## Deployment

### Netlify (recommended — includes server-side monitoring)

1. Push repo to GitHub
2. Connect to [netlify.com](https://netlify.com) → New site from Git
3. Build settings are in `netlify.toml` — no changes needed
4. Add environment variables: **Site config → Environment variables**

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token with `gist` scope only |
| `GIST_ID` | Your Gist ID (created manually or auto-created on first deploy) |

5. Deploy — the scheduled function runs every 60 seconds automatically

### GitHub Pages (static only — no server monitoring)

Settings → Pages → Deploy from branch `main` / folder `/public`

Without a scheduled function, monitoring only runs while the browser tab is open. Use Netlify for 24/7 coverage.

---

## Project Structure

```
uptracker/
├── public/
│   ├── index.html           # Main dashboard
│   ├── maintenance.html     # Hosted maintenance/status page
│   ├── style.css            # All styles (dark theme)
│   ├── app.js               # Dashboard logic + Gist read/write + PIN engine
│   ├── config.js            # ⚠ Generated at build (gitignored) — holds token + Gist ID
│   ├── config.example.js    # Template for config.js
│   └── assets/icons/
│       └── favicon.svg
├── netlify/
│   └── functions/
│       └── monitor.js       # Scheduled function: checks + DNS failover + Discord
├── build.js                 # Generates config.js from Netlify env vars at build time
├── netlify.toml             # Build command + function directory + cache headers
├── package.json             # @netlify/functions dependency
└── README.md
```

---

## FAQ

**Q: Does Cloudflare DNS failover really work on the free plan?**
Yes. The free plan has full DNS API access, unlimited API calls, and supports CNAME flattening at the root domain. The only limitation is TTL — minimum 60 seconds, which means worst-case failover is ~2 minutes.

**Q: My domain uses an A record, not CNAME. Does it still work?**
Yes. Uptracker detects the record type. On failover, it temporarily switches the A record to a CNAME pointing to the maintenance page (Cloudflare flattens this transparently). On recovery, it restores the original A record with your real IP.

**Q: What if Cloudflare is also down?**
Failover won't activate, but the monitoring and Discord alerts still work. This is extremely rare — Cloudflare has 99.99%+ uptime.

**Q: How long does the full failover take?**

| Stage | Time |
|---|---|
| Detection (server check) | up to 60s |
| Cloudflare API call | ~1s |
| DNS propagation (TTL=60) | ~60s |
| **Total worst case** | **~2 minutes** |

**Q: Will my SEO be affected?**
The maintenance page uses `<meta name="robots" content="noindex, nofollow">` so search engines won't index it. Your real pages stay indexed.

**Q: Is my Cloudflare API token safe?**
It's stored in the GitHub Gist (private, accessible only with your GitHub token). The CF token only has Edit DNS permission on one specific zone — it cannot access billing, settings, or any other Cloudflare feature.

**Q: Is my GitHub token safe in `config.js`?**
The token has `gist` scope only — it can read/write your private Gist and nothing else. It cannot access repositories, create commits, or modify anything outside that Gist.

---

## License

MIT
