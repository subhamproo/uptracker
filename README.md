# Uptracker — Realtime Website Downtime Monitor

A clean, minimal, realtime website uptime tracker. Persistent server-side storage via **GitHub Gist** (free, no database needed). Runs on any static host.

## Features

- **Realtime monitoring** — checks every 30s (configurable per site)
- **☁ Cloud storage** — all data saved to a private GitHub Gist (survives cache clears, works across devices)
- **1-year history** — browse incidents by Last 24h / 7d / 30d / 90d / 1 year / All time
- **Response time sparklines** — last 20 checks visualized
- **Uptime percentage** — calculated from full check history
- **Incident log** — full timeline of outages and recoveries grouped by date
- **Discord webhook alerts** — per site, Offline Only or Online & Offline modes
- **Add/remove sites** — unlimited websites
- **Dark theme** — clean, professional UI
- **Mobile responsive**
- **Zero dependencies** — pure HTML/CSS/JS, no npm, no build tools

## Storage Architecture

```
Browser → GitHub Gist API (PATCH) → private Gist JSON file
                                          ↓
                               uptracker_data.json
                               {
                                 sites:     [...],
                                 checks:    { siteId: [...] },
                                 incidents: { siteId: [...] }
                               }
```

- Every check result is stored (up to 2000 per site for sparklines/stats)
- Every status change (incident) is stored (up to 5000 per site ≈ 1+ years)
- Writes are debounced — batched every 3 seconds to avoid rate limits
- localStorage mirrors the Gist as an instant offline cache

## Configuration

Edit `public/config.js`:

```js
window.UPTRACKER_CONFIG = {
  GITHUB_TOKEN: 'ghp_your_token_here',  // PAT with gist scope only
  GIST_ID:      'your_gist_id_here',
  GIST_FILE:    'uptracker_data.json',
};
```

**To create a new Gist storage:**
1. Go to [github.com/settings/tokens/new](https://github.com/settings/tokens/new)
2. Check only `gist` scope → Generate token
3. Create a Gist at [gist.github.com](https://gist.github.com) with any content
4. Copy the Gist ID from the URL

## Deploy (Free Hosting)

### Netlify
Drag & drop the `public/` folder to [netlify.com/drop](https://app.netlify.com/drop)

### GitHub Pages
Settings → Pages → Deploy from `main` branch, folder `/public`

### Vercel
```bash
npx vercel --cwd public
```

## Project Structure

```
uptracker/
├── public/
│   ├── index.html      # App shell
│   ├── style.css       # Dark theme styles
│   ├── app.js          # Monitor engine + Gist storage layer
│   ├── config.js       # Your GitHub token + Gist ID
│   └── assets/icons/favicon.svg
├── netlify.toml        # Publish directory config
└── README.md
```

## License

MIT
