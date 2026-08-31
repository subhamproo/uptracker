/**
 * UPTRACKER — Server-Side Monitor (Netlify Scheduled Function)
 * Runs every 1 minute on Netlify's servers, 24/7
 *
 * FEATURES:
 * - Site health checks (HEAD request, 10s timeout)
 * - GitHub Gist persistence (checks, incidents, site state)
 * - Discord alerts (offline-only or every-check heartbeat)
 * - Cloudflare DNS Failover (free plan API)
 *   → On DOWN: switches DNS CNAME to maintenance page URL
 *   → On UP:   restores DNS CNAME to original value
 */

'use strict';

const https   = require('https');
const http    = require('http');
const { URL } = require('url');
const { schedule } = require('@netlify/functions');

// ── CONFIG FROM ENV VARS ──────────────────────
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GIST_ID       = process.env.GIST_ID;
const GIST_FILE     = 'uptracker_data.json';

// Cloudflare token from env var — NEVER stored in Gist or sent to browser
// Set CF_TOKEN in Netlify environment variables dashboard
const CF_TOKEN_ENV  = process.env.CF_TOKEN || null;

// Maintenance page base URL — where Cloudflare will redirect traffic when site is down
const CHECK_TIMEOUT = 10000;
const MAX_CHECKS    = 5000;
const MAX_INCIDENTS = 5000;

const MAINTENANCE_BASE = 'uptimetracker.netlify.app';
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

  const results = await Promise.allSettled(sites.map(checkSite));
  const log     = [];

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

    // ── Store check result ────────────────────────────
    data.checks[id].push({ ts: Date.now(), status, ms });
    if (data.checks[id].length > MAX_CHECKS) data.checks[id].shift();

    // ── Detect status change ──────────────────────────
    const prevStatus    = site.lastStatus || null;
    const statusChanged = prevStatus !== status;

    // ── Log incident ──────────────────────────────────
    if (statusChanged) {
      const evt = status === 'up' ? '✅ Site came back online' : '🔴 Site went down';
      data.incidents[id].push({ ts: Date.now(), status, ms, code, event: evt });
      if (data.incidents[id].length > MAX_INCIDENTS) data.incidents[id].shift();
      console.log(`[INCIDENT] ${site.name}: ${prevStatus ?? 'new'} → ${status} (${ms}ms)`);
    }

    // ── Cloudflare DNS Failover ────────────────────────
    // Triggers on status change only (not every check)
    if (statusChanged && site.cfEnabled && site.cfZoneId && site.cfRecordId) {
      // Token priority:
      // 1. Per-site env var: CF_TOKEN_siteid (e.g. CF_TOKEN_site_1788168353097_yssiy)
      // 2. Global env var: CF_TOKEN (works if all sites are on same CF account)
      // 3. Legacy: site.cfApiToken stored in Gist (NOT recommended - gets revoked)
      const siteEnvKey = `CF_TOKEN_${site.id}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const cfToken    = process.env[siteEnvKey] || CF_TOKEN_ENV || site.cfApiToken || null;

      if (!cfToken) {
        console.warn(`[CF] ${site.name}: No CF token. Set CF_TOKEN in Netlify env vars.`);
      } else {
      if (status === 'down') {
        const failoverRecord = {
          type:    'CNAME',
          name:    site.cfRecordName,
          content: MAINTENANCE_BASE,
          ttl:     60,
          proxied: true,
        };

        sites[i] = { ...site, cfOriginalType: site.cfRecordType || 'A', cfOriginalTtl: site.cfOriginalTtl || 1 };

        const cfResult = await cfUpdateRecord(cfToken, site.cfZoneId, site.cfRecordId, failoverRecord);
        if (cfResult.success) {
          console.log(`[CF-FAILOVER] ${site.name}: DNS → maintenance page`);
          sites[i] = { ...sites[i], cfFailoverActive: true };
        } else {
          console.warn(`[CF-FAILOVER] ${site.name}: FAILED — ${cfResult.error}`);
        }

      } else if (status === 'up' && site.cfFailoverActive) {
        const originalType    = site.cfOriginalType    || site.cfRecordType || 'A';
        const originalContent = site.cfOriginalContent || '';

        if (!originalContent) {
          console.warn(`[CF-RESTORE] ${site.name}: No original value stored`);
        } else {
          const restoreRecord = {
            type:    originalType,
            name:    site.cfRecordName,
            content: originalContent,
            ttl:     site.cfOriginalTtl || 1,
            proxied: !!site.cfProxied,
          };

          const cfResult = await cfUpdateRecord(cfToken, site.cfZoneId, site.cfRecordId, restoreRecord);
          if (cfResult.success) {
            console.log(`[CF-RESTORE] ${site.name}: DNS → ${originalContent} (${originalType})`);
            sites[i] = { ...sites[i], cfFailoverActive: false };
          } else {
            console.warn(`[CF-RESTORE] ${site.name}: FAILED — ${cfResult.error}`);
          }
        }
      }
      } // end cfToken block
    }

    // ── Discord alerts ─────────────────────────────────
    if (site.webhookUrl) {
      let shouldSend = false;
      let alertType  = 'status_change';

      if (site.alertMode === 'offline') {
        // Only on DOWN status change
        shouldSend = statusChanged && status === 'down';
        alertType  = 'down';
      } else if (site.alertMode === 'both') {
        shouldSend = true;
        if (status === 'down') {
          alertType = 'down';
        } else if (statusChanged && prevStatus === 'down') {
          // Was down, now up → recovery alert (priority over heartbeat)
          alertType = 'recovery';
        } else {
          alertType = 'heartbeat';
        }
      }

      if (shouldSend) {
        const failoverNote = (site.cfEnabled && statusChanged)
          ? (status === 'down'
              ? '\n> 🔄 DNS failover activated — visitors redirected to maintenance page'
              : '\n> ✅ DNS failover deactivated — traffic restored to your server')
          : '';
        await sendDiscord(site, status, ms, code, data, alertType, failoverNote).catch(e =>
          console.warn(`[Discord] ${site.name}: ${e.message}`)
        );
      }
    }

    log.push(`${site.name}: ${status} (${ms}ms)${statusChanged ? ' [CHANGED]' : ''}${site.cfEnabled && statusChanged ? ' [CF-DNS]' : ''}`);

    // ── Update site record ──────────────────────────────
    sites[i] = {
      ...(sites[i] || site),   // preserve any cfFailoverActive changes from above
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

// ── SITE CHECK ────────────────────────────────────────────────────────
function checkSite(site) {
  return new Promise((resolve) => {
    const start   = Date.now();
    let settled   = false;
    const finish  = (status, ms, code) => {
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
        const code = res.statusCode;
        finish(code < 500 ? 'up' : 'down', Date.now() - start, code);
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

// ── CLOUDFLARE DNS API ────────────────────────────────────────────────
/**
 * Update a DNS record via Cloudflare's free-tier API
 * PATCH /zones/{zone_id}/dns_records/{record_id}
 *
 * @param {string} apiToken - Cloudflare API token (Edit DNS zone permission)
 * @param {string} zoneId   - Zone ID (found in CF dashboard Overview page)
 * @param {string} recordId - DNS record ID (from CF API list records)
 * @param {object} record   - { type, name, content, ttl, proxied }
 * @returns {{ success: boolean, error?: string }}
 */
function cfUpdateRecord(apiToken, zoneId, recordId, record) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(record);
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path:     `/client/v4/zones/${zoneId}/dns_records/${recordId}`,
      method:   'PATCH',
      headers:  {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':    'Uptracker/4',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (body.success) {
            resolve({ success: true });
          } else {
            const err = body.errors?.[0]?.message || 'Unknown CF error';
            resolve({ success: false, error: err });
          }
        } catch (e) {
          resolve({ success: false, error: `Parse error: ${e.message}` });
        }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

/**
 * Get current value of a DNS record (used to auto-save cfOriginalContent)
 */
function cfGetRecord(apiToken, zoneId, recordId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path:     `/client/v4/zones/${zoneId}/dns_records/${recordId}`,
      method:   'GET',
      headers:  {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Uptracker/4',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (body.success) resolve(body.result);
          else reject(new Error(body.errors?.[0]?.message || 'CF error'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function buildMaintenanceUrl(site) {
  const params = new URLSearchParams({
    id:   site.id,
    name: site.name,
    url:  site.url,
  });
  const base = site.maintenanceUrl || `https://${MAINTENANCE_BASE}/maintenance`;
  return `${base}?${params.toString()}`;
}

// ── GIST ──────────────────────────────────────────────────────────────
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
        if (res.statusCode >= 400) return reject(new Error(`GitHub API ${res.statusCode}: ${raw.slice(0,200)}`));
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

// ── DISCORD ───────────────────────────────────────────────────────────
const ROLE_PING = '<@&1543965727550341211>'; // Role to ping on every alert

async function sendDiscord(site, status, ms, code, data, alertType, extraNote = '') {
  const isDown      = status === 'down';
  const isHeartbeat = alertType === 'heartbeat';
  const isRecovery  = alertType === 'recovery';
  const id          = site.id;
  const allChecks   = data.checks[id] || [];
  const upCount     = allChecks.filter(c => c.status === 'up').length;
  const upPct       = allChecks.length ? ((upCount / allChecks.length) * 100).toFixed(1) + '%' : '—';
  const outages     = (data.incidents[id] || []).filter(i => i.status === 'down').length;
  const domain      = (() => { try { return new URL(site.url).hostname.replace('www.', ''); } catch { return site.url; } })();
  const nowIST      = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: true,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  let title, description, color;

  if (isDown) {
    title       = `🚨 ${site.name} is DOWN`;
    description = `**${site.name}** is **unreachable**.\n> Confirmed by Netlify server check${extraNote}`;
    color       = 0xEF4444;
  } else if (isRecovery) {
    title       = `✅ ${site.name} is back ONLINE`;
    description = `**${site.name}** has **recovered** and is responding normally.${extraNote}`;
    color       = 0x10B981;
  } else {
    // Heartbeat
    title       = `💚 ${site.name} — ONLINE`;
    description = `**${site.name}** is responding normally. *(Periodic check)*${extraNote}`;
    color       = 0x10B981;
  }

  const fields = [
    { name: '🌐 URL',        value: `[${domain}](${site.url})`,        inline: true  },
    { name: '📶 Status',     value: isDown ? '`OFFLINE`' : '`ONLINE`', inline: true  },
    { name: '⏱ Response',   value: ms ? `\`${ms}ms\`` : '`timeout`',  inline: true  },
    { name: '🔢 HTTP',      value: code ? `\`${code}\`` : '`—`',       inline: true  },
    { name: '📊 Uptime',    value: `\`${upPct}\``,                     inline: true  },
    { name: '📋 Outages',   value: `\`${outages} total\``,             inline: true  },
    { name: '🕐 Time (IST)',value: `\`${nowIST}\``,                    inline: false },
    { name: '🖥 Source',    value: '`Netlify server — 24/7`',          inline: true  },
  ];

  if (site.cfEnabled) {
    fields.push({
      name:   '🔄 DNS Failover',
      value:  site.cfFailoverActive ? '`Active — on maintenance page`' : '`Inactive — normal DNS`',
      inline: true,
    });
  }

  const footerText = isHeartbeat
    ? 'Uptracker • Heartbeat (Online & Offline mode)'
    : isRecovery
    ? 'Uptracker • Service Recovered'
    : `Uptracker • every ${site.interval || 60}s`;

  const payload = {
    // Role ping as message content — shows outside the embed so it notifies properly
    content:    ROLE_PING,
    username:   'Uptracker',
    avatar_url: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
    embeds: [{
      title, description, color, fields,
      footer:    { text: footerText },
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
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}
