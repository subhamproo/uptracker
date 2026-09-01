/**
 * UPTRACKER — Cloudflare Worker v2
 * Instant redirect to maintenance page when site is detected as DOWN
 *
 * IMPORTANT: Update this code in Cloudflare Dashboard → Workers → uptracker-worker → Edit Code
 *
 * Environment Variables (Workers Settings → Variables):
 *   GITHUB_TOKEN  = your GitHub PAT (gist scope) — mark as Secret
 *   GIST_ID       = 6460a6dfda90fbea4aae70f0ef973bfb
 *   SITE_URL      = https://proh.top
 *   SITE_NAME     = PROH TOP
 *   MAINTENANCE   = https://uptimetracker.netlify.app/maintenance
 *
 * Routes (Cloudflare → your domain → Workers Routes):
 *   proh.top/*        → uptracker-worker
 *   www.proh.top/*    → uptracker-worker
 */

const GIST_FILE       = 'uptracker_data.json';
const STATUS_CACHE_TTL = 30; // seconds
const BYPASS_HEADER   = 'X-Uptracker-Check'; // monitor sends this to bypass worker

export default {
  async fetch(request, env, ctx) {
    const { GITHUB_TOKEN, GIST_ID, SITE_URL, MAINTENANCE } = env;
    const maintenanceUrl = MAINTENANCE || 'https://uptimetracker.netlify.app/maintenance';

    // ── BYPASS: Uptracker health monitor check ────────
    // Our Netlify monitor sends X-Uptracker-Check header
    // Pass directly to origin so we get real server status
    if (request.headers.get(BYPASS_HEADER)) {
      return fetch(request);
    }

    // ── Only intercept GET/HEAD from real browsers ────
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fetch(request);
    }

    // ── Check cached status ───────────────────────────
    const cacheKey = `uptracker-status-${GIST_ID}`;
    const cache    = caches.default;
    const cached   = await cache.match(`https://cache.uptracker/${cacheKey}`);

    let isDown   = false;
    let siteId   = null;
    let siteName = '';

    if (cached) {
      const data = await cached.json();
      isDown   = data.isDown;
      siteId   = data.siteId;
      siteName = data.siteName || '';
    } else {
      try {
        const gistRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept:        'application/vnd.github.v3+json',
            'User-Agent':  'Uptracker-Worker/2.0',
          },
        });

        if (gistRes.ok) {
          const gist = await gistRes.json();
          const raw  = gist.files?.[GIST_FILE]?.content;

          if (raw) {
            const data = JSON.parse(raw);
            const site = data.sites?.find(s =>
              s.url?.replace(/\/$/, '') === SITE_URL?.replace(/\/$/, '')
            );

            isDown   = site?.lastStatus === 'down';
            siteId   = site?.id   || '';
            siteName = site?.name || '';

            // Cache result
            const cacheResp = new Response(JSON.stringify({ isDown, siteId, siteName }), {
              headers: {
                'Content-Type':  'application/json',
                'Cache-Control': `public, max-age=${STATUS_CACHE_TTL}`,
              },
            });
            ctx.waitUntil(cache.put(`https://cache.uptracker/${cacheKey}`, cacheResp));
          }
        }
      } catch (e) {
        // Can't check status → pass through to origin (fail open)
        console.error('[Uptracker Worker] Status check failed:', e.message);
        return fetch(request);
      }
    }

    // ── DOWN → redirect to maintenance ───────────────
    if (isDown) {
      const url    = new URL(request.url);
      const params = new URLSearchParams({
        url:  SITE_URL || url.origin,
        name: env.SITE_NAME || siteName || url.hostname,
        ...(siteId ? { id: siteId } : {}),
      });

      return new Response(null, {
        status: 302,
        headers: {
          Location:        `${maintenanceUrl}?${params}`,
          'Cache-Control': 'no-store, no-cache',
          'X-Uptracker':   'failover-active',
        },
      });
    }

    // ── UP → pass through to origin ──────────────────
    return fetch(request);
  },
};
