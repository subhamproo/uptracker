/**
 * UPTRACKER — Server-Side Monitor (Netlify Scheduled Function)
 * Runs every 1 minute on Netlify's servers, 24/7
 * No browser required — checks sites, saves to Gist, sends Discord alerts
 */

'use strict';

const https    = require('https');
const http     = require('http');
const { URL }  = require('url');
const { schedule } = require('@netlify/functions');

// ── CONFIG FROM ENV VARS ──────────────────────
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GIST_ID       = process.env.GIST_ID;
const GIST_FILE     = 'uptracker_data.json';
const CHECK_TIMEOUT = 10000;
const MAX_CHECKS    = 2000;
const MAX_INCIDENTS = 5000;

// ── SCHEDULED HANDLER ────────────────────────
const handler = async () => {
  if (!GITHUB_TOKEN || !GIST_ID) {
    console.error('Missing GITHUB_TOKEN or GIST_ID');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  // 1. Load data from Gist
  const data = await gistLoad();
  if (!data) return { statusCode: 500, body: 'Failed to load Gist' };

  const sites = data.sites || [];
  if (sites.length === 0) return { statusCode: 200, body: 'No sites configured' };

  if (!data.checks)    data.checks    = {};
  if (!data.incidents) data.incidents = {};

  // 2. Check all sites in parallel
  const results = await Promise.allSettled(sites.map(checkSite));

  // 3. Process each result
  const log = [];
  for (let i = 0; i < results.length; i++) {
    const site = sites[i];
    if (results[i].status !== 'fulfilled') {
      log.push(`${site.name}: check failed`);
      continue;
    }

    const { status, ms, code } = results[i].value;
    const id = site.id;

    if (!data.checks[id])    data.checks[id]    = [];
    if (!data.incidents[id]) data.incidents[id] = [];

    // Store check result
    data.checks[id].push({ ts: Date.now(), status, ms });
    if (data.checks[id].length > MAX_CHECKS) data.checks[id].shift();

    // Detect status change
    const prev = data.incidents[id].at(-1)?.status;
    if (prev !== status) {
      const evt = status === 'up' ? '✅ Site came back online' : '🔴 Site went down';
      data.incidents[id].push({ ts: Date.now(), status, ms, code, event: evt });
      if (data.incidents[id].length > MAX_INCIDENTS) data.incidents[id].shift();

      console.log(`[INCIDENT] ${site.name}: ${prev ?? 'new'} → ${status} (${ms}ms)`);
      log.push(`${site.name}: ${prev ?? '?'} → ${status}`);

      // Discord alert
      if (site.webhookUrl) {
        const send = site.alertMode === 'both' ||
          (site.alertMode === 'offline' && status === 'down');
        if (send) {
          await sendDiscord(site, status, ms, code, data).catch(e =>
            console.warn('Discord failed:', e.message)
          );
        }
      }
    } else {
      log.push(`${site.name}: ${status} (${ms}ms)`);
    }

    // Update last known state on site record
    sites[i] = { ...site, lastStatus: status, lastMs: ms, lastCode: code,
                 lastChecked: new Date().toISOString() };
  }

  // 4. Save back to Gist
  data.sites   = sites;
  data.savedAt = new Date().toISOString();
  data.lastRun = new Date().toISOString();
  data.version = 4;
  await gistSave(data);

  console.log(`[DONE] ${log.join(' | ')}`);
  return { statusCode: 200, body: log.join(', ') };
};

// Export as scheduled function — runs every 1 minute (Netlify free tier minimum)
// The UI polls every 30s so users always see fresh data within 30s of a check
module.exports.handler = schedule('* * * * *', handler);

// ── SITE CHECK ────────────────────────────────
function checkSite(site) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (status, ms, code) => {
      if (done) return; done = true;
      resolve({ status, ms: Math.round(ms), code });
    };

    const kill = setTimeout(() => finish('down', CHECK_TIMEOUT, null), CHECK_TIMEOUT + 500);

    try {
      const u    = new URL(site.url);
      const lib  = u.protocol === 'https:' ? https : http;
      const req  = lib.request({
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname + u.search || '/',
        method:   'HEAD',
        timeout:  CHECK_TIMEOUT,
        headers:  { 'User-Agent': 'Uptracker/4 (+https://uptimetracker.netlify.app)' },
      }, (res) => {
        clearTimeout(kill);
        res.resume();
        const ms     = Date.now() - start;
        const code   = res.statusCode;
        const status = code < 500 ? 'up' : 'down';
        finish(status, ms, code);
      });
      req.on('error',   () => { clearTimeout(kill); finish('down', Date.now()-start, null); });
      req.on('timeout', () => { clearTimeout(kill); req.destroy(); finish('down', CHECK_TIMEOUT, null); });
      req.end();
    } catch(e) {
      clearTimeout(kill);
      finish('down', Date.now()-start, null);
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
        if (res.statusCode >= 400) return reject(new Error(`GH ${res.statusCode}: ${raw.slice(0,200)}`));
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
  } catch(e) { console.error('gistLoad:', e.message); return null; }
}

async function gistSave(data) {
  await ghRequest('PATCH', {
    files: { [GIST_FILE]: { content: JSON.stringify(data, null, 2) } },
  });
}

// ── DISCORD ───────────────────────────────────
async function sendDiscord(site, status, ms, code, data) {
  const isDown = status === 'down';
  const id     = site.id;
  const checks = data.checks[id] || [];
  const upPct  = checks.length
    ? ((checks.filter(c=>c.status==='up').length / checks.length)*100).toFixed(1) + '%'
    : '—';
  const outages = (data.incidents[id]||[]).filter(i=>i.status==='down').length;
  const domain  = (() => { try { return new URL(site.url).hostname.replace('www.',''); } catch { return site.url; } })();
  const now     = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

  const embed = {
    username: 'Uptracker',
    embeds: [{
      title:       isDown ? `🚨 ${site.name} is DOWN` : `✅ ${site.name} is back ONLINE`,
      description: isDown
        ? `**${site.name}** is unreachable.\n> Confirmed by Netlify server-side check`
        : `**${site.name}** has recovered and is responding normally.`,
      color: isDown ? 0xEF4444 : 0x10B981,
      fields: [
        { name: '🌐 URL',       value: `[${domain}](${site.url})`,       inline: true },
        { name: '📶 Status',    value: isDown ? '`OFFLINE`' : '`ONLINE`', inline: true },
        { name: '⏱ Response',  value: ms ? `\`${ms}ms\`` : '`timeout`', inline: true },
        { name: '🔢 HTTP',     value: code ? `\`${code}\`` : '`—`',      inline: true },
        { name: '📊 Uptime',   value: `\`${upPct}\``,                    inline: true },
        { name: '📋 Outages',  value: `\`${outages} total\``,            inline: true },
        { name: '🕐 Time (IST)', value: `\`${now}\``,                    inline: false },
        { name: '🖥 Source',   value: '`Netlify server — 24/7`',         inline: true },
      ],
      footer: { text: `Uptracker • checks every ${site.interval||60}s` },
      timestamp: new Date().toISOString(),
    }],
  };

  const body   = JSON.stringify(embed);
  const u      = new URL(site.webhookUrl);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Uptracker/4',
      },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}
