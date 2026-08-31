/**
 * UPTRACKER — Maintenance Page v4
 * - Data loaded via server-side proxy (no CORS)
 * - All icons are SVG (no emojis)
 * - CF token never stored in browser
 */

'use strict';

// ── CONFIG ────────────────────────────────────
const p        = new URLSearchParams(location.search);
const SITE_ID  = p.get('id')   || '';
const SITE_URL = p.get('url')  || '';
const SITE_NAME= decodeURIComponent(p.get('name') || 'This service');

// Token from config.js — only used for proxy auth header on localhost
// On Netlify production, the function reads it from env vars directly
const cfg   = window.UPTRACKER_CONFIG || {};
const TOKEN = cfg.GITHUB_TOKEN || '';
const GIST  = cfg.GIST_ID      || '';
const FILE  = cfg.GIST_FILE    || 'uptracker_data.json';

const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

let currentState   = 'loading';
let isRedirecting  = false;
let pollIntervalId = null;

// ── SVG ICON LIBRARY ──────────────────────────
const ICONS = {
  uptime: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  response: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  outages: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  checks: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  down_dot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  up_dot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  server: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`,
  wrench: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  ok: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  loading: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  empty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="10" opacity=".3"/><path d="M8 12l3 3 5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

// ── INIT ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  populate();
  injectIcons();
  initCanvas();
  spawnParticles();
  setLoadingState();
  poll();
  pollIntervalId = setInterval(poll, 30000);
});

// ── INJECT ICONS INTO HTML ────────────────────
function injectIcons() {
  // Metric card icons
  const mcUptime   = document.getElementById('mc-uptime');
  const mcResponse = document.getElementById('mc-response');
  const mcOutages  = document.getElementById('mc-outages');
  const mcChecks   = document.getElementById('mc-checks');

  if (mcUptime)   mcUptime.querySelector('.mc-icon').innerHTML   = ICONS.uptime;
  if (mcResponse) mcResponse.querySelector('.mc-icon').innerHTML = ICONS.response;
  if (mcOutages)  mcOutages.querySelector('.mc-icon').innerHTML  = ICONS.outages;
  if (mcChecks)   mcChecks.querySelector('.mc-icon').innerHTML   = ICONS.checks;

  // Orb core icon (server/wrench)
  const orbInner = document.getElementById('orbInner');
  if (orbInner) orbInner.innerHTML = `<span class="orb-icon-svg" id="orbIconSvg">${ICONS.wrench}</span>`;
}

// ── POPULATE STATIC ───────────────────────────
function populate() {
  document.getElementById('brandName').textContent = SITE_NAME;
  document.getElementById('copySiteName').textContent = SITE_NAME;
  document.title = `${SITE_NAME} — Under Maintenance`;

  if (SITE_URL) {
    try {
      const domain = new URL(SITE_URL).hostname.replace('www.', '');
      document.getElementById('brandDomain').textContent = domain;
      document.getElementById('visitBtn').href    = SITE_URL;
      document.getElementById('footerVisit').href = SITE_URL;

      const img   = document.getElementById('brandFavicon');
      img.src     = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      img.onload  = () => { img.classList.add('show'); document.getElementById('brandInitial').style.display = 'none'; };
      img.onerror = () => { img.style.display = 'none'; };
      document.getElementById('brandInitial').textContent = SITE_NAME.charAt(0).toUpperCase();
    } catch {}
  } else {
    document.getElementById('visitBtn').style.display    = 'none';
    document.getElementById('footerVisit').style.display = 'none';
  }
}

// ── DATA FETCH (via server proxy) ─────────────
async function fetchGistData() {
  // Always go through a server-side proxy — never direct browser → GitHub API
  // This avoids CORS and also means the GitHub token stays server-side

  if (IS_LOCAL) {
    // Dev server proxy
    const res = await fetch('/gist-proxy', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token: TOKEN, gistId: GIST, gistFile: FILE }),
    });
    if (!res.ok) throw new Error(`Proxy ${res.status}`);
    return res.json();
  } else {
    // Netlify function proxy — token comes from env vars, not browser
    const res = await fetch('/.netlify/functions/gist-proxy', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ gistFile: FILE }),
    });
    if (!res.ok) throw new Error(`Function ${res.status}`);
    return res.json();
  }
}

// ── POLL ─────────────────────────────────────
function setLoadingState() {
  setStatusBadge('loading', 'Connecting to monitor…', '');
  setStatusCard('loading', 'Connecting…', 'Fetching live status from monitoring server', null);
}

async function poll() {
  const spinner = document.getElementById('pollSpinner');
  spinner.classList.remove('done');
  document.getElementById('pollChipText').textContent = 'Checking…';

  try {
    const data = await fetchGistData();
    const site = findSite(data.sites);

    if (!site) {
      document.getElementById('pollChipText').textContent = 'No data';
      // Still show the page with whatever we have
      renderState('down', null, null, [], []);
      return;
    }

    const checks   = data.checks?.[site.id]    || [];
    const incs     = data.incidents?.[site.id]  || [];
    const isUp     = site.lastStatus === 'up';
    const upCount  = checks.filter(c => c.status === 'up').length;
    const upPct    = checks.length ? Math.round(upCount / checks.length * 100) : null;

    renderState(isUp ? 'up' : 'down', site, upPct, checks, incs);

    spinner.classList.add('done');
    document.getElementById('pollChipText').textContent = `Updated ${now()}`;

    if (isUp && SITE_URL && !isRedirecting) startRedirect();

  } catch (e) {
    console.warn('[Uptracker] Poll error:', e.message);
    document.getElementById('pollChipText').textContent = 'Retrying…';
  }
}

function findSite(sites) {
  if (!sites?.length) return null;
  if (SITE_ID)  return sites.find(s => s.id === SITE_ID) || sites.find(s => s.url === SITE_URL) || sites[0];
  if (SITE_URL) return sites.find(s => s.url === SITE_URL) || sites[0];
  return sites[0];
}

// ── RENDER STATE ──────────────────────────────
function renderState(state, site, upPct, checks, incidents) {
  currentState = state;
  const isUp   = state === 'up';
  const isDown = state === 'down';

  // Status badge
  const sinceStr = site?.lastChecked ? relTime(new Date(site.lastChecked)) : '';
  setStatusBadge(
    state,
    isUp   ? 'All Systems Operational' :
    isDown ? 'Service Disruption Detected' : 'Monitoring…',
    sinceStr
  );

  // Headline
  const hl = document.getElementById('copyHeadline');
  if (isUp) {
    hl.innerHTML = `We're back<br/><span class="grad green">online.</span><span class="cursor-blink">_</span>`;
    document.getElementById('copySub').innerHTML =
      `<strong id="copySiteName">${SITE_NAME}</strong> has fully recovered and is responding normally.`;
  } else if (isDown) {
    hl.innerHTML = `We'll be right<br/><span class="grad">back.</span><span class="cursor-blink">_</span>`;
    document.getElementById('copySub').innerHTML =
      `We're working to restore <strong id="copySiteName">${SITE_NAME}</strong> as quickly as possible. Our team has been notified.`;
  }

  // Status card
  const ms = site?.lastMs;
  setStatusCard(
    state,
    isUp   ? 'All Systems Operational'     :
    isDown ? 'Service Disruption Detected'  : 'Checking…',
    isUp   ? `Responding normally${ms ? ' · ' + ms + 'ms' : ''}` :
    isDown ? `Unreachable${ms ? ' · Last response ' + ms + 'ms' : ''}` :
             'Connecting to monitoring server',
    ms
  );

  if (site?.lastChecked) {
    document.getElementById('scTime').textContent =
      new Date(site.lastChecked).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  }

  // Metrics
  if (upPct !== null) {
    const el = document.getElementById('mcUptime');
    el.textContent = upPct + '%';
    el.className   = `mc-val ${upPct >= 99 ? 'good' : upPct >= 90 ? 'warn' : 'bad'}`;
    document.getElementById('mcUptimeBar').style.width = upPct + '%';
  }

  if (ms) {
    const el  = document.getElementById('mcResponse');
    el.textContent = ms + 'ms';
    el.className   = `mc-val ${ms < 600 ? 'good' : ms < 1500 ? 'warn' : 'bad'}`;
    const tag = document.getElementById('mcResponseTag');
    tag.textContent = ms < 600 ? 'Fast' : ms < 1500 ? 'Slow' : 'Timeout';
    tag.className   = `mc-tag ${ms < 600 ? 'good' : ms < 1500 ? 'warn' : 'bad'}`;
  }

  const downIncs = incidents.filter(i => i.status === 'down');
  const outEl = document.getElementById('mcOutages');
  outEl.textContent = downIncs.length;
  outEl.className   = `mc-val ${downIncs.length === 0 ? 'good' : downIncs.length < 5 ? 'warn' : 'bad'}`;

  const chkEl = document.getElementById('mcChecks');
  chkEl.textContent = checks.length;
  chkEl.className   = `mc-val ${checks.length > 0 ? '' : 'dim'}`;

  // Progress bar
  if (upPct !== null) {
    const cls = upPct >= 90 ? 'good' : upPct >= 70 ? 'warn' : '';
    const fill = document.getElementById('progFill');
    const glow = document.getElementById('progGlow');
    fill.style.width = upPct + '%';
    glow.style.width = upPct + '%';
    fill.className = `prog-fill ${cls}`;
    glow.className = `prog-glow ${cls}`;
    document.getElementById('progScore').textContent     = upPct + '%';
    document.getElementById('progChecksLabel').textContent =
      `${checks.length} checks · ${checks.filter(c=>c.status==='up').length} successful`;
  }

  // Sparkline
  renderSparkline(checks.slice(-40));

  // Incidents
  renderIncidents([...incidents].reverse().slice(0, 8));

  // Orb
  const orbEl  = document.getElementById('orbContainer');
  const coreEl = document.getElementById('orbCore');
  const iconEl = document.getElementById('orbIconSvg');
  orbEl.className  = `orb-container ${isUp ? 'up' : ''}`;
  coreEl.className = `orb-core ${isUp ? 'up' : ''}`;
  if (iconEl) {
    iconEl.innerHTML = isUp ? ICONS.ok : isDown ? ICONS.wrench : ICONS.loading;
    iconEl.className = `orb-icon-svg ${isUp ? 'up' : ''} ${currentState === 'loading' ? 'spin' : ''}`;
  }
  document.getElementById('orbStatusText').textContent =
    isUp   ? 'All systems operational' :
    isDown ? 'Service disruption detected' : 'Checking…';

  // Canvas + glow
  setCanvasMode(isUp ? 'green' : 'red');
  document.getElementById('bgGlow').className = `bg-glow${isUp ? ' green' : ''}`;
}

// ── STATUS BADGE & CARD ───────────────────────
function setStatusBadge(state, text, since) {
  document.getElementById('statusBadge').className       = `status-badge ${state}`;
  document.getElementById('statusBadgeText').textContent  = text;
  document.getElementById('statusBadgeSince').textContent = since;
}

function setStatusCard(state, stateText, detail, ms) {
  document.getElementById('statusCard').className    = `status-card ${state}`;
  document.getElementById('siDot').className         = `si-dot ${state}`;
  const stEl = document.getElementById('siState');
  stEl.className   = `si-state ${state}`;
  stEl.textContent = stateText;
  document.getElementById('siDetail').textContent = detail;
  document.getElementById('siMs').textContent     = ms ? ms + 'ms' : '—';
}

// ── SPARKLINE ─────────────────────────────────
function renderSparkline(history) {
  const wrap  = document.getElementById('sparklineWrap');
  const COUNT = 40;
  const pad   = [...Array(Math.max(0, COUNT - history.length)).fill(null), ...history];
  const valid = history.filter(h => h?.ms && h.status !== 'down').map(h => h.ms);
  const maxMs = valid.length ? Math.max(...valid) : 1000;

  wrap.innerHTML = pad.map(h => {
    if (!h) return `<div class="spark-b empty" style="height:12%"></div>`;
    if (h.status === 'down') return `<div class="spark-b down-b" style="height:100%" data-tip="DOWN"></div>`;
    const pct = Math.max(10, Math.min(100, Math.round((h.ms / maxMs) * 100)));
    const cls = h.ms < 600 ? 'ok' : h.ms < 1500 ? 'slow' : 'down-b';
    const tip = `${h.ms}ms · ${new Date(h.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
    return `<div class="spark-b ${cls}" style="height:${pct}%" data-tip="${tip}"></div>`;
  }).join('');

  document.getElementById('sparkCount').textContent =
    history.length ? `(${history.length})` : '';

  const oldest = history[0]?.ts;
  if (oldest) {
    document.getElementById('sparkOldest').textContent =
      new Date(oldest).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  }
}

// ── INCIDENTS ─────────────────────────────────
function renderIncidents(incidents) {
  const list  = document.getElementById('incidentList');
  const count = document.getElementById('incidentCount');
  count.textContent = `${incidents.length} event${incidents.length !== 1 ? 's' : ''}`;

  if (!incidents.length) {
    list.innerHTML = `<div class="incident-empty">
      <span class="ie-icon">${ICONS.empty}</span>
      <span>No incidents recorded</span>
    </div>`;
    return;
  }

  list.innerHTML = incidents.map(inc => {
    const isUp = inc.status === 'up';
    const time = new Date(inc.ts).toLocaleString([], {
      month:'short', day:'numeric', hour:'2-digit', minute:'2-digit',
    });
    const icon = isUp
      ? `<span class="inc-icon-wrap up">${ICONS.up_dot}</span>`
      : `<span class="inc-icon-wrap down">${ICONS.down_dot}</span>`;
    const msStr = inc.ms ? `${inc.ms}ms${inc.code ? ' · HTTP ' + inc.code : ''}` : '';
    return `
      <div class="inc-item">
        ${icon}
        <div class="inc-body">
          <div class="inc-event ${inc.status}">${inc.event || (isUp ? 'Service restored' : 'Service disrupted')}</div>
          <div class="inc-time">${time}${msStr ? ` · ${msStr}` : ''}</div>
        </div>
      </div>`;
  }).join('');
}

// ── REDIRECT ─────────────────────────────────
function startRedirect() {
  if (isRedirecting) return;
  isRedirecting = true;
  clearInterval(pollIntervalId);

  const banner = document.getElementById('recoveryBanner');
  banner.style.display = 'flex';

  const circle = document.getElementById('rbCircle');
  const total  = 2 * Math.PI * 20; // r=20
  circle.style.strokeDashoffset = total;

  let n = 5;
  document.getElementById('rbCountdown').textContent = n;

  const t = setInterval(() => {
    n--;
    document.getElementById('rbCountdown').textContent = n;
    circle.style.transition        = 'stroke-dashoffset .9s linear';
    circle.style.strokeDashoffset  = total * (1 - (5 - n) / 5);
    if (n <= 0) { clearInterval(t); if (SITE_URL) window.location.replace(SITE_URL); }
  }, 1000);
}

// ── HELPERS ───────────────────────────────────
function now() {
  return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function relTime(d) {
  const diff = Date.now() - d.getTime();
  if (diff < 60000)    return 'just now';
  if (diff < 3600000)  return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return Math.floor(diff/86400000) + 'd ago';
}

// ── CANVAS BG ─────────────────────────────────
const canvas = document.getElementById('bgCanvas');
const ctx    = canvas.getContext('2d');
let cW, cH, cAngle = 0;
let cColor  = {r:239,g:68,b:68};
let cTarget = {r:239,g:68,b:68};

function setCanvasMode(m) {
  cTarget = m === 'green' ? {r:16,g:185,b:129} : {r:239,g:68,b:68};
}

function lerp(a, b, t) {
  return {r:Math.round(a.r+(b.r-a.r)*t), g:Math.round(a.g+(b.g-a.g)*t), b:Math.round(a.b+(b.b-a.b)*t)};
}

function resizeCanvas() {
  cW = canvas.width  = window.innerWidth;
  cH = canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

(function drawCanvas() {
  requestAnimationFrame(drawCanvas);
  cColor = lerp(cColor, cTarget, 0.015);
  const {r,g,b} = cColor;
  ctx.clearRect(0,0,cW,cH);
  cAngle += 0.003;

  const g1 = ctx.createRadialGradient(
    cW*.5 + Math.cos(cAngle)*cW*.22,
    cH*.3  + Math.sin(cAngle*.7)*cH*.18,
    0,
    cW*.5 + Math.cos(cAngle)*cW*.22,
    cH*.3  + Math.sin(cAngle*.7)*cH*.18,
    cW*.45
  );
  g1.addColorStop(0, `rgba(${r},${g},${b},0.07)`);
  g1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g1; ctx.fillRect(0,0,cW,cH);

  const g2 = ctx.createRadialGradient(
    cW*.5 + Math.cos(-cAngle*1.3+2)*cW*.28,
    cH*.7  + Math.sin(-cAngle*.9+1)*cH*.14,
    0,
    cW*.5 + Math.cos(-cAngle*1.3+2)*cW*.28,
    cH*.7  + Math.sin(-cAngle*.9+1)*cH*.14,
    cW*.3
  );
  g2.addColorStop(0, `rgba(59,130,246,0.04)`);
  g2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g2; ctx.fillRect(0,0,cW,cH);
})();

// ── PARTICLES ─────────────────────────────────
function spawnParticles() {
  const c = document.getElementById('particles');
  const n = window.innerWidth < 640 ? 18 : 36;
  for (let i = 0; i < n; i++) {
    const el  = document.createElement('div');
    el.className = 'particle';
    const sz  = Math.random() * 2.5 + .8;
    const x   = Math.random() * 100;
    const dur = Math.random() * 22 + 14;
    const del = -(Math.random() * 22);
    const op  = Math.random() * .3 + .07;
    const col = Math.random() > .6 ? '239,68,68' : Math.random() > .5 ? '59,130,246' : '110,231,183';
    el.style.cssText = `left:${x}%;bottom:-5%;width:${sz}px;height:${sz}px;background:rgba(${col},${op});box-shadow:0 0 ${sz*2}px rgba(${col},${op*.5});animation-duration:${dur}s;animation-delay:${del}s;`;
    c.appendChild(el);
  }
}
