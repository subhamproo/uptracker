/**
 * UPTRACKER — Server-Side Monitor (Netlify Scheduled Function)
 * Runs every 1 minute on Netlify's servers, 24/7
 *
 * ALERT LOGIC:
 * - alertMode 'offline' → Discord only when site status changes to DOWN
 * - alertMode 'both'    → Discord on EVERY check (online every 60s + instant offline)
 */

'use strict';

const https   = require('https');
const http    = require('http');
const { URL } = require('url');
const { schedule } = require('@netlify/functions');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GIST_ID       = process.env.GIST_ID;
const GIST_FILE     = 'uptracker_data.json';
const CHECK_TIMEOUT = 10000;
const MAX_CHECKS    = 5000;  // ~83 hours at 1/min
const MAX_INCIDENTS = 5000;

// ── HANDLER ──────────────────────────────────
const handler = async () => {
  if (!GITHUB_TOKEN || !GIST_ID) {
    console.error('[Uptracker] Missing GITHUB_TOKEN or GIST_ID');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  const data = await gistLoad();
  if (!data) return { statusCode: 500, body: 'Failed to load Gist' };

  const sites = data.sites || [];
  if (!sites.length) return { statusCode: 200, body: 'No sites configured' };

  data.checks    = data.checks    || {};
  data.incidents = data.incidents || {};

  // Run checks in parallel
  const results = await Promise.allSettled(sites.map(checkSite));

  const log = [];

  for (let i = 0; i < results.length; i++) {
    const site = sites[i];
    const id   = site.id;

    if (results[i].status !== 'fulfilled') {
      log.push(`${site.name}: check error`);
      continue;
    }

    const { status, ms, code } = results[i].value;

    data.checks[id]    = data.checks[id]    || [];
    data.incidents[id] = data.incidents[id] || [];

    // ── Store check ──────────────────────────
    data.checks[id].push({ ts: Date.now(), status, ms });
    if (data.checks[id].length > MAX_CHECKS) data.checks[id].shift();

    // ── Determine previous status ────────────
    // Use site.lastStatus (persisted from last run) as source of truth
    const prevStatus = site.lastStatus || null;
    const statusChanged = prevStatus !== status;

    // ── Log incident on status change ────────
    if (statusChanged) {
      const evt = status === 'up' ? '✅ Site came back online' : '🔴 Site went down';
      data.incidents[id].push({ ts: Date.now(), status, ms, code, event: evt });
      if (data.incidents[id].length > MAX_INCIDENTS) data.incidents[id].shift();
      console.log(`[INCIDENT] ${site.name}: ${prevStatus ?? 'new'} → ${status} (${ms}ms)`);
    }

    // ── Discord alerts ───────────────────────
    if (site.webhookUrl) {
      let shouldSend = false;
      let alertType  = 'status_change';

      if (site.alertMode === 'offline') {
        // Only when going DOWN (status change)
        shouldSend = statusChanged && status === 'down';
        alertType  = 'down';
      } else if (site.alertMode === 'both') {
        // Every single check — online ping every run + instant offline
        shouldSend = true;
        alertType  = status === 'down' ? 'down' : 'heartbeat';
      }

      if (shouldSend) {
        await sendDiscord(site, status, ms, code, data, alertType).catch(e =>
          console.warn(`[Discord] ${site.name}: ${e.message}`)
        );
      }
    }

    log.push(`${site.name}: ${status} (${ms}ms)${statusChanged ? ' [CHANGED]' : ''}`);

    // ── Update site record ───────────────────
    sites[i] = {
      ...site,
      lastStatus:  status,
      lastMs:      ms,
      lastCode:    code,
      lastChecked: new Date().toISOString(),
    };
  }

  data.sites   = sites;
  data.savedAt = new Date().toISOString();
  data.lastRun = new Date().toISOString();
  data.version = 4;

  await gistSave(data);

  const summary = log.join(' | ');
  console.log(`[Uptracker] ${summary}`);
  return { statusCode: 200, body: summary };
};

module.exports.handler = schedule('* * * * *', handler);

// ── SITE CHECK ────────────────────────────────
function checkSite(site) {
  return new Promise((resolve) => {
    const start  = Date.now();
    let settled  = false;

    const finish = (status, ms, code) => {
      if (settled) return;
      settled = true;
      resolve({ status, ms: Math.round(ms), code });
    };

    const kill = setTimeout(() => finish('down', CHECK_TIMEOUT, null), CHECK_TIMEOUT + 500);

    try {
      const u   = new URL(site.url);
      const lib = u.protocol === 'https:' ? https : http;

      const req = lib.request({
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     (u.pathname || '/') + (u.search || ''),
        method:   'HEAD',
        timeout:  CHECK_TIMEOUT,
        headers:  { 'User-Agent': 'Uptracker/4 (+https://uptimetracker.netlify.app)' },
      }, (res) => {
        clearTimeout(kill);
        res.resume();
        const elapsed = Date.now() - start;
        const code    = res.statusCode;
        // 2xx, 3xx, 4xx = site is responding = up. 5xx = server error = down
        finish(code < 500 ? 'up' : 'down', elapsed, code);
      });

      req.on('error',   () => { clearTimeout(kill); finish('down', Date.now() - start, null); });
      req.on('timeout', () => { clearTimeout(kill); req.destroy(); finish('down', CHECK_TIMEOUT, null); });
      req.end();
    } catch (e) {
      clearTimeout(kill);
      finish('down', Date.now() - start, null);
    }
  });
}

// ── GIST ─────────────────────────────────────
function ghRequest(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path:     `/gists/${GIST_ID}`,
      method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type':  'application/json',
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'Uptracker/4',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`GitHub API ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function gistLoad() {
  try {
    const resp = await ghRequest('GET');
    const raw  = resp.files?.[GIST_FILE]?.content;
    if (!raw) return { sites: [], checks: {}, incidents: {}, version: 4 };
    return JSON.parse(raw);
  } catch (e) {
    console.error('[gistLoad]', e.message);
    return null;
  }
}

async function gistSave(data) {
  await ghRequest('PATCH', {
    files: { [GIST_FILE]: { content: JSON.stringify(data, null, 2) } },
  });
}

// ── DISCORD ───────────────────────────────────
async function sendDiscord(site, status, ms, code, data, alertType) {
  const isDown    = status === 'down';
  const isHeartbeat = alertType === 'heartbeat';
  const id        = site.id;
  const allChecks = data.checks[id] || [];
  const upCount   = allChecks.filter(c => c.status === 'up').length;
  const upPct     = allChecks.length
    ? ((upCount / allChecks.length) * 100).toFixed(1) + '%'
    : '—';
  const outages   = (data.incidents[id] || []).filter(i => i.status === 'down').length;
  const domain    = (() => {
    try { return new URL(site.url).hostname.replace('www.', ''); }
    catch { return site.url; }
  })();
  const nowIST = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: true,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  // Title and color based on alert type
  let title, description, color;
  if (isHeartbeat) {
    title       = `💚 ${site.name} — ONLINE`;
    description = `**${site.name}** is responding normally. *(Periodic check)*`;
    color       = 0x10B981;
  } else if (isDown) {
    title       = `🚨 ${site.name} is DOWN`;
    description = `**${site.name}** is **unreachable**.\n> Confirmed by Netlify server check`;
    color       = 0xEF4444;
  } else {
    title       = `✅ ${site.name} is back ONLINE`;
    description = `**${site.name}** has **recovered** and is responding normally.`;
    color       = 0x10B981;
  }

  const payload = {
    username:   'Uptracker',
    avatar_url: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
    embeds: [{
      title,
      description,
      color,
      fields: [
        { name: '🌐 URL',        value: `[${domain}](${site.url})`,        inline: true  },
        { name: '📶 Status',     value: isDown ? '`OFFLINE`' : '`ONLINE`', inline: true  },
        { name: '⏱ Response',   value: ms ? `\`${ms}ms\`` : '`timeout`',  inline: true  },
        { name: '🔢 HTTP',      value: code ? `\`${code}\`` : '`—`',       inline: true  },
        { name: '📊 Uptime',    value: `\`${upPct}\``,                     inline: true  },
        { name: '📋 Outages',   value: `\`${outages} total\``,             inline: true  },
        { name: '🕐 Time (IST)',value: `\`${nowIST}\``,                    inline: false },
        { name: '🖥 Source',    value: '`Netlify server — 24/7`',          inline: true  },
      ],
      footer: {
        text: isHeartbeat
          ? `Uptracker • Heartbeat (Online & Offline mode)`
          : `Uptracker • every ${site.interval || 60}s`,
      },
      timestamp: new Date().toISOString(),
    }],
  };

  const body = JSON.stringify(payload);
  const u    = new URL(site.webhookUrl);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + (u.search || ''),
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Uptracker/4',
      },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}
