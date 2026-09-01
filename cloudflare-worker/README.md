# Uptracker — Cloudflare Worker (Multi-Domain)

One Worker handles ALL your domains. No separate worker needed per domain.

## How it works

```
Request to proh.top (or ANY domain with a route)
        ↓
Worker reads hostname from request
        ↓
Fetches Gist → finds site matching hostname (30s cache)
        ↓
lastStatus = "down"  →  302 redirect to maintenance page
lastStatus = "up"    →  pass through to real server
```

## Setup (one time only)

### Step 1 — Deploy the Worker

1. Cloudflare → Workers & Pages → Create application → Hello World
2. Name it `uptracker-worker`
3. Click Deploy → then Edit Code
4. Replace ALL code with contents of `worker.js`
5. Save and Deploy

### Step 2 — Set Environment Variables

Workers Settings → Variables → Add variable:

| Variable | Value | Secret? |
|---|---|---|
| `GITHUB_TOKEN` | Your GitHub PAT (gist scope) | ✅ Yes |
| `GIST_ID` | `6460a6dfda90fbea4aae70f0ef973bfb` | No |
| `MAINTENANCE` | `https://uptimetracker.netlify.app/maintenance` | No |

**Note:** `SITE_URL` and `SITE_NAME` are no longer needed — the worker auto-detects from the hostname.

### Step 3 — Add routes for each domain

For EACH domain you want protected:

1. Go to **Cloudflare → Websites → [your domain] → Workers Routes**
2. Click **Add Route**

| Route | Worker |
|---|---|
| `yourdomain.com/*` | `uptracker-worker` |
| `www.yourdomain.com/*` | `uptracker-worker` |

Repeat for every domain. Same worker, different routes. Done.

---

## Adding a New Domain

Just:
1. Add the site in Uptracker dashboard (+ Add Site)
2. Add route in Cloudflare for that domain → `uptracker-worker`

That's it. No Worker code changes needed.

---

## Custom Maintenance Page per Site

In Uptracker → Edit site → **Maintenance Page URL** field.
If set, the Worker uses that URL instead of the default one.
Each site can have its own branded maintenance page.

---

## How the Health Monitor bypasses the Worker

Our Netlify server function sends `X-Uptracker-Check: health-monitor` header.
The Worker sees this and passes directly to the real origin — so the monitor
gets the actual server status, not the redirect.

This prevents the false positive where the Worker's 302 redirect looked like
the site was "up" to the monitor.

---

## Cache

The Worker caches the full Gist data for 30 seconds across all domains.
So if you have 10 domains, the Worker only fetches the Gist once per 30s,
not 10 times. Efficient and within GitHub API rate limits.

---

## Domains currently configured

| Domain | Route added? |
|---|---|
| proh.top | ✅ |
| www.proh.top | ✅ |
| roiprofitacademy.in | Add route when ready |

## Troubleshooting

**Worker not redirecting even though site is down:**
- Check that `lastStatus` in Gist is `"down"` (open Uptracker dashboard)
- Check the 30s cache — may take up to 30s after status changes
- Check Worker env vars are saved correctly

**Monitor showing false "up" when site is down:**
- Make sure you deployed Worker v3 with the bypass header check
- The monitor header `X-Uptracker-Check` must be recognized by Worker
