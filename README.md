# Uptracker — Realtime Website Downtime Monitor

A clean, minimal, realtime website uptime/downtime tracker. No backend required. Runs on any free static hosting (GitHub Pages, Netlify, Vercel, Cloudflare Pages, etc.)

![Uptracker Screenshot](https://via.placeholder.com/900x500/0a0e1a/6ee7b7?text=Uptracker+Dashboard)

## Features

- **Realtime monitoring** — checks every 30s (configurable per site)
- **Response time tracking** — sparkline history of last 20 checks
- **Uptime percentage** — calculated from check history
- **Incident log** — full timeline of outages and recoveries
- **Toast notifications** — instant alerts when a site goes down or recovers
- **Add/remove sites** — monitor unlimited websites
- **Persistent storage** — sites saved to localStorage (survives page reload)
- **Dark theme** — clean, professional UI
- **Mobile responsive** — works on all screen sizes
- **Zero dependencies** — pure HTML/CSS/JS, no npm, no build tools

## Supabase Setup (Persistent Storage — Free)

By default Uptracker stores data in `localStorage` (browser only). To get **1-year persistent history** that survives cache clears and works across devices, set up Supabase in 5 minutes:

**1. Create a free Supabase project**
- Go to [supabase.com](https://supabase.com) → New Project (free tier, no credit card)

**2. Run the schema**
- Dashboard → SQL Editor → paste contents of `supabase_schema.sql` → Run

**3. Get your API keys**
- Dashboard → Settings → API
- Copy: **Project URL** and **anon public key**

**4. Add to config.js**
```js
// public/config.js
window.UPTRACKER_CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-key-here',
};
```

**5. Redeploy** — the ☁ Cloud badge will appear on all cards.

The anon key is safe to expose — Supabase Row Level Security (RLS) policies are already set up in the schema.

---

### GitHub Pages
1. Push to a GitHub repo
2. Go to **Settings → Pages → Deploy from branch → main / public**
3. Done — live at `https://yourusername.github.io/uptracker`

### Netlify
1. Drag & drop the `public/` folder to [netlify.com/drop](https://app.netlify.com/drop)
2. Done — instant URL

### Vercel
```bash
npx vercel --cwd public
```

### Cloudflare Pages
1. Connect repo in Cloudflare Pages dashboard
2. Set root directory to `public`
3. No build command needed

## Project Structure

```
uptracker/
├── public/
│   ├── index.html      # Main app shell
│   ├── style.css       # All styles (dark theme)
│   ├── app.js          # Monitor engine + UI logic
│   └── assets/
│       └── icons/
│           └── favicon.svg
└── README.md
```

## Monitored Sites (Default)

- [ROI Profit Academy](https://roiprofitacademy.in)

## Tech Stack

- Vanilla HTML5 / CSS3 / JavaScript (ES2020)
- Google Fonts (Inter + JetBrains Mono)
- Google Favicon API
- CORS proxies for cross-origin checks

## License

MIT
