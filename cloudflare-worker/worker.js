/**
 * UPTRACKER — Cloudflare Worker v3 (Multi-Domain)
 * ─────────────────────────────────────────────────
 * ONE worker handles ALL your domains automatically.
 * No config needed per domain — just add a Route.
 *
 * HOW IT WORKS:
 *   1. Request arrives at any domain with this worker attached
 *   2. Worker reads request hostname (e.g. "proh.top")
 *   3. Worker fetches Gist → finds site matching that hostname
 *   4. If site.lastStatus === 'down' → redirect to maintenance page
 *   5. If site.lastStatus === 'up'   → pass through to real server
 *
 * SETUP (one time only):
 * ─────────────────────────────────────────────────
 * 1. Cloudflare → Workers & Pages → uptracker-worker → Edit Code
 *    Paste this entire file → Save and Deploy
 *
 * 2. Worker Settings → Variables → add:
 *    GITHUB_TOKEN  = your GitHub PAT (gist scope)  ← mark as Secret
 *    GIST_ID       = 6460a6dfda90fbea4aae70f0ef973bfb
 *    MAINTENANCE   = https://uptimetracker.netlify.app/maintenance
 *
 * 3. For EACH domain you want protected:
 *    Go to Cloudflare → Websites → [your domain] → Workers Routes
 *    Add route: yourdomain.com/*    → uptracker-worker
 *    Add route: www.yourdomain.com/* → uptracker-worker
 *    (That's it — no other config needed per domain)
 *
 * CUSTOM MAINTENANCE PAGE PER SITE:
 *    Set "Maintenance Page URL" in the Uptracker edit modal
 *    Worker reads site.maintenanceUrl from Gist if set
 *
 * BYPASS HEADER (used by Uptracker health monitor):
 *    Requests with X-Uptracker-Check header bypass the worker
 *    so the monitor gets the real origin status, not the redirect
 */

'use strict';

const GIST_FILE        = 'uptracker_data.json';
const CACHE_TTL        = 30;   // seconds — how long to cache Gist status
const BYPASS_HEADER    = 'X-Uptracker-Check';
const DEFAULT_MAINTENANCE = 'https://uptimetracker.netlify.app/maintenance';

export default {
  async fetch(request, env, ctx) {
    // ── 1. Bypass for health monitor ─────────────────
    // Uptracker's Netlify function sends this header
    // so it gets the real origin response, not our redirect
    if (request.headers.get(BYPASS_HEADER)) {
      return fetch(request);
    }

    // ── 2. Only intercept GET/HEAD ────────────────────
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fetch(request);
    }

    const { GITHUB_TOKEN, GIST_ID } = env;

    if (!GITHUB_TOKEN || !GIST_ID) {
      // Worker not configured — pass through
      return fetch(request);
    }

    // ── 3. Detect current domain ──────────────────────
    const reqUrl   = new URL(request.url);
    const hostname = reqUrl.hostname.replace(/^www\./, ''); // strip www

    // ── 4. Check cached Gist data ─────────────────────
    const cacheKey = `uptracker-v3-${GIST_ID}`;
    const cache    = caches.default;
    let   gistData = null;

    const cached = await cache.match(`https://cache.uptracker/${cacheKey}`);
    if (cached) {
      try { gistData = await cached.json(); } catch {}
    }

    if (!gistData) {
      // Fetch fresh from GitHub Gist
      try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept:        'application/vnd.github.v3+json',
            'User-Agent':  'Uptracker-Worker/3.0',
          },
        });

        if (!res.ok) throw new Error(`Gist ${res.status}`);

        const json = await res.json();
        const raw  = json.files?.[GIST_FILE]?.content;
        if (!raw) throw new Error('Empty Gist');

        gistData = JSON.parse(raw);

        // Cache full Gist data for CACHE_TTL seconds
        const cacheResp = new Response(JSON.stringify(gistData), {
          headers: {
            'Content-Type':  'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
          },
        });
        ctx.waitUntil(cache.put(`https://cache.uptracker/${cacheKey}`, cacheResp));

      } catch (e) {
        // Can't load Gist → fail open (pass through to origin)
        console.error('[Uptracker] Gist load failed:', e.message);
        return fetch(request);
      }
    }

    // ── 5. Find site matching current hostname ────────
    const site = findSiteForHostname(gistData.sites || [], hostname);

    if (!site) {
      // No site configured for this domain → pass through
      return fetch(request);
    }

    // ── 6. Check site status ──────────────────────────
    const isDown = site.lastStatus === 'down';

    if (!isDown) {
      // Site is UP → pass through to real server
      return fetch(request);
    }

    // ── 7. Site is DOWN → redirect to maintenance ─────
    const maintenanceBase = site.maintenanceUrl
      || env.MAINTENANCE
      || DEFAULT_MAINTENANCE;

    const params = new URLSearchParams({
      url:  site.url,
      name: site.name || hostname,
      id:   site.id   || '',
    });

    const redirectUrl = `${maintenanceBase}?${params.toString()}`;

    console.log(`[Uptracker] ${hostname} is DOWN → redirecting to maintenance`);

    return new Response(null, {
      status:  302,
      headers: {
        Location:        redirectUrl,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Uptracker':   'failover-active',
        'X-Uptracker-Site': site.name || hostname,
      },
    });
  },
};

// ── HELPERS ──────────────────────────────────────
/**
 * Find the Uptracker site matching the current request hostname.
 * Tries multiple matching strategies:
 *  1. Exact URL match (https://proh.top === https://proh.top)
 *  2. Hostname match (proh.top matches https://proh.top or https://www.proh.top)
 */
function findSiteForHostname(sites, hostname) {
  if (!sites?.length || !hostname) return null;

  for (const site of sites) {
    if (!site.url) continue;
    try {
      const siteHostname = new URL(site.url).hostname.replace(/^www\./, '');
      if (siteHostname === hostname) return site;
    } catch {}
  }
  return null;
}
