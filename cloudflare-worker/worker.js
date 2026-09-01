/**
 * UPTRACKER — Cloudflare Worker
 * Instant redirect to maintenance page when site is detected as DOWN
 *
 * Deploy this worker on your domain (proh.top / roiprofitacademy.in)
 * in Cloudflare Dashboard → Workers & Pages → Create Worker
 *
 * Set these environment variables in the Worker settings:
 *   GITHUB_TOKEN  = your GitHub PAT (gist scope)
 *   GIST_ID       = 6460a6dfda90fbea4aae70f0ef973bfb
 *   SITE_URL      = https://proh.top  (the site this worker is for)
 *   MAINTENANCE   = https://uptimetracker.netlify.app/maintenance
 *
 * Then add a Route in Cloudflare → Websites → your domain → Workers Routes:
 *   Route: proh.top/*
 *   Worker: uptracker-worker
 */

const GIST_FILE = 'uptracker_data.json';

// Cache status for 30 seconds to avoid hammering GitHub API
const STATUS_CACHE_TTL = 30; // seconds

export default {
  async fetch(request, env, ctx) {
    const { GITHUB_TOKEN, GIST_ID, SITE_URL, MAINTENANCE } = env;
    const maintenanceUrl = MAINTENANCE || 'https://uptimetracker.netlify.app/maintenance';

    // Skip non-GET requests (POST, API calls etc) — pass through directly
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fetch(request);
    }

    // Check cached status first (Cloudflare KV or Cache API)
    const cacheKey = `uptracker-status-${GIST_ID}`;
    const cache    = caches.default;
    const cached   = await cache.match(`https://cache.uptracker/${cacheKey}`);

    let isDown = false;
    let siteId = null;

    if (cached) {
      // Use cached status
      const data = await cached.json();
      isDown = data.isDown;
      siteId = data.siteId;
    } else {
      // Fetch fresh status from GitHub Gist
      try {
        const gistRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept:        'application/vnd.github.v3+json',
            'User-Agent':  'Uptracker-Worker/1.0',
          },
        });

        if (gistRes.ok) {
          const gist    = await gistRes.json();
          const raw     = gist.files?.[GIST_FILE]?.content;
          if (raw) {
            const data  = JSON.parse(raw);
            const site  = data.sites?.find(s => s.url === SITE_URL || s.url === SITE_URL + '/');
            isDown      = site?.lastStatus === 'down';
            siteId      = site?.id;
            const siteName = site?.name || '';

            // Cache the result for STATUS_CACHE_TTL seconds
            const cacheResponse = new Response(JSON.stringify({ isDown, siteId, siteName }), {
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${STATUS_CACHE_TTL}`,
              },
            });
            ctx.waitUntil(cache.put(`https://cache.uptracker/${cacheKey}`, cacheResponse));
          }
        }
      } catch (e) {
        // If we can't check status, pass through to origin (fail open)
        console.error('Uptracker Worker status check failed:', e.message);
        return fetch(request);
      }
    }

    // If site is DOWN → redirect to maintenance page
    if (isDown) {
      const url      = new URL(request.url);
      const params   = new URLSearchParams({
        url:  SITE_URL,
        name: env.SITE_NAME || url.hostname,
        ...(siteId ? { id: siteId } : {}),
      });
      const redirect = `${maintenanceUrl}?${params.toString()}`;

      return new Response(null, {
        status:  302,
        headers: {
          Location:        redirect,
          'Cache-Control': 'no-store',
          'X-Uptracker':   'failover-active',
        },
      });
    }

    // Site is UP → pass request through to origin
    return fetch(request);
  },
};
