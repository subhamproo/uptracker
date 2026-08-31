/**
 * UPTRACKER — Maintenance Page v3
 * Futuristic, data-rich status page
 */

'use strict';

// ── CONFIG ────────────────────────────────────
const p        = new URLSearchParams(location.search);
const SITE_ID  = p.get('id')   || '';
const SITE_URL = p.get('url')  || '';
const SITE_NAME= decodeURIComponent(p.get('name') || 'This service');

const cfg   = window.UPTRACKER_CONFIG || {};
const TOKEN = cfg.GITHUB_TOKEN || '';
const GIST  = cfg.GIST_ID      || '';
const FILE  = cfg.GIST_FILE    || 'uptracker_data.json';

let currentState    = 'loading';
let isRedirecting   = false;
let pollIntervalId  = null;

// ── DOM INIT ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  populate();
  initCanvas();
  spawnParticles();
  setLoadingState();
  firstPoll();
  pollIntervalId = setInterval(poll, 30000);
});

function setLoadingState() {
  setStatusBadge('loading', 'Connecting…', '');
  setStatusCard('loading', 'Checking status…', 'Connecting to monitoring server', null);
}

// ── STATIC POPULATE ───────────────────────────
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
  }
}

// ── POLLING ───────────────────────────────────
async function firstPoll() {
  await poll();
}

async function poll() {
  const spinner = document.getElementById('pollSpinner');
  spinner.className = 'poll-spinner';
  document.getElementById('pollChipText').textContent = 'Checking…';

  if (!TOKEN || !GIST) {
    document.getElementById('pollChipText').textContent = 'No config';
    renderState('down', null, null, [], []);
    return;
  }

  try {
    const res  = await fetch(`https://api.github.com/gists/${GIST}`, {
      headers: { Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github.v3+json' },
      cache: 'no-store',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json     = await res.json();
    const raw      = json.files?.[FILE]?.content;
    if (!raw) throw new Error('Empty Gist');

    const data     = JSON.parse(raw);
    const site     = findSite(data.sites);

    if (!site) {
      document.getElementById('pollChipText').textContent = 'Site not found';
      renderState('down', null, null, [], []);
      return;
    }

    const siteChecks  = data.checks?.[site.id]    || [];
    const incidents   = data.incidents?.[site.id]  || [];
    const isUp        = site.lastStatus === 'up';
    const upCount     = siteChecks.filter(c => c.status === 'up').length;
    const upPct       = siteChecks.length ? Math.round(upCount / siteChecks.length * 100) : null;

    renderState(isUp ? 'up' : 'down', site, upPct, siteChecks, incidents);

    spinner.className = 'poll-spinner done';
    document.getElementById('pollChipText').textContent = `Updated ${now()}`;

    if (isUp && SITE_URL && !isRedirecting) startRedirect();

  } catch (e) {
    console.warn('[Uptracker]', e.message);
    spinner.className = 'poll-spinner';
    document.getElementById('pollChipText').textContent = 'Retrying…';
  }
}

function findSite(sites) {
  if (!sites) return null;
  if (SITE_ID)  return sites.find(s => s.id === SITE_ID) || sites.find(s => s.url === SITE_URL) || null;
  if (SITE_URL) return sites.find(s => s.url === SITE_URL) || null;
  return sites[0] || null;
}

// ── RENDER STATE ──────────────────────────────
function renderState(state, site, upPct, checks, incidents) {
  currentState = state;
  const isUp   = state === 'up';
  const isDown = state === 'down';

  // ── Status badge ─────────────────────────────
  const since = site?.lastChecked ? relTime(new Date(site.lastChecked)) : '';
  setStatusBadge(state,
    isUp   ? '🟢 All Systems Online' :
    isDown ? '🔴 Service Disruption' : 'Checking…',
    since
  );

  // ── Headline ─────────────────────────────────
  const hl = document.getElementById('copyHeadline');
  if (isUp) {
    hl.innerHTML = `We're back<br/><span class="grad green">online.</span><span class="cursor-blink">_</span>`;
    document.getElementById('copySub').innerHTML =
      `<strong id="copySiteName">${SITE_NAME}</strong> has fully recovered. All systems are responding normally.`;
  } else if (isDown) {
    hl.innerHTML = `We'll be right<br/><span class="grad">back.</span><span class="cursor-blink">_</span>`;
    document.getElementById('copySub').innerHTML =
      `We're aware of the disruption to <strong id="copySiteName">${SITE_NAME}</strong> and working to restore service as quickly as possible.`;
  }

  // ── Status card ──────────────────────────────
  const ms = site?.lastMs;
  setStatusCard(
    state,
    isUp   ? 'All Systems Operational'    :
    isDown ? 'Service Disruption Detected' : 'Checking…',
    isUp   ? `Response time: ${ms ? ms+'ms' : '—'} · HTTP 200` :
    isDown ? `Last response: ${ms ? ms+'ms' : 'Timeout'} · Unreachable` :
             'Connecting to monitoring server',
    ms
  );

  // ── Last checked time ─────────────────────────
  if (site?.lastChecked) {
    document.getElementById('scTime').textContent =
      new Date(site.lastChecked).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }

  // ── Metrics ──────────────────────────────────
  if (upPct !== null) {
    const mUp = document.getElementById('mcUptime');
    mUp.textContent = upPct + '%';
    mUp.className   = `mc-val ${upPct >= 99 ? 'good' : upPct >= 90 ? 'warn' : 'bad'}`;
    document.getElementById('mcUptimeBar').style.width = upPct + '%';
  }

  if (ms) {
    const mResp = document.getElementById('mcResponse');
    mResp.textContent = ms + 'ms';
    mResp.className   = `mc-val ${ms < 600 ? 'good' : ms < 1500 ? 'warn' : 'bad'}`;
    const tag = document.getElementById('mcResponseTag');
    tag.textContent = ms < 600 ? 'Fast' : ms < 1500 ? 'Slow' : 'Timeout';
    tag.className   = `mc-tag ${ms < 600 ? 'good' : ms < 1500 ? 'warn' : 'bad'}`;
  }

  const downIncs = incidents.filter(i => i.status === 'down');
  const mcOut = document.getElementById('mcOutages');
  mcOut.textContent = downIncs.length;
  mcOut.className   = `mc-val ${downIncs.length === 0 ? 'good' : downIncs.length < 3 ? 'warn' : 'bad'}`;

  const mcChk = document.getElementById('mcChecks');
  mcChk.textContent = checks.length;
  mcChk.className   = `mc-val ${checks.length > 0 ? '' : 'dim'}`;

  // ── Progress bar ─────────────────────────────
  if (upPct !== null) {
    const cls = upPct >= 90 ? 'good' : upPct >= 70 ? 'warn' : '';
    document.getElementById('progFill').style.width = upPct + '%';
    document.getElementById('progGlow').style.width = upPct + '%';
    document.getElementById('progFill').className  = `prog-fill ${cls}`;
    document.getElementById('progGlow').className  = `prog-glow ${cls}`;
    document.getElementById('progScore').textContent = upPct + '%';
    document.getElementById('progChecksLabel').textContent = `${checks.length} checks · ${upCount(checks)} up`;
  }

  // ── Sparkline ────────────────────────────────
  renderSparkline(checks.slice(-40));

  // ── Incident timeline ─────────────────────────
  renderIncidents([...incidents].reverse().slice(0, 8));

  // ── Orb ──────────────────────────────────────
  const orb  = document.getElementById('orbContainer');
  const core = document.getElementById('orbCore');
  const emoji= document.getElementById('orbEmoji');
  orb.className    = `orb-container ${isUp ? 'up' : ''}`;
  core.className   = `orb-core ${isUp ? 'up' : ''}`;
  emoji.textContent = isUp ? '✅' : isDown ? '🔧' : '🔄';
  document.getElementById('orbStatusText').textContent =
    isUp ? 'All systems operational' : isDown ? 'Investigating disruption' : 'Checking…';

  // ── Canvas colour ─────────────────────────────
  setCanvasMode(isUp ? 'green' : 'red');

  // ── bg-glow ───────────────────────────────────
  const glow = document.getElementById('bgGlow');
  glow.className = isUp ? 'bg-glow green' : 'bg-glow';
}

function upCount(checks) {
  return checks.filter(c => c.status === 'up').length;
}

// ── STATUS BADGE ──────────────────────────────
function setStatusBadge(state, text, since) {
  const el   = document.getElementById('statusBadge');
  const txt  = document.getElementById('statusBadgeText');
  const snc  = document.getElementById('statusBadgeSince');
  el.className  = `status-badge ${state}`;
  txt.textContent = text;
  snc.textContent = since;
}

// ── STATUS CARD ───────────────────────────────
function setStatusCard(state, stateText, detail, ms) {
  const card   = document.getElementById('statusCard');
  const dot    = document.getElementById('siDot');
  const state_ = document.getElementById('siState');
  const det    = document.getElementById('siDetail');
  const msEl   = document.getElementById('siMs');
  card.className   = `status-card ${state}`;
  dot.className    = `si-dot ${state}`;
  state_.className = `si-state ${state}`;
  state_.textContent = stateText;
  det.textContent    = detail;
  msEl.textContent   = ms ? ms + 'ms' : '—';
}

// ── SPARKLINE ─────────────────────────────────
function renderSparkline(history) {
  const wrap = document.getElementById('sparklineWrap');
  const COUNT = 40;
  const padded = [...Array(Math.max(0, COUNT - history.length)).fill(null), ...history];
  const validMs = history.filter(h => h?.ms && h.status !== 'down').map(h => h.ms);
  const maxMs   = validMs.length ? Math.max(...validMs) : 1000;

  wrap.innerHTML = padded.map(h => {
    if (!h) return `<div class="spark-b empty" style="height:12%"></div>`;
    if (h.status === 'down') return `<div class="spark-b down-b" style="height:100%" data-tip="DOWN"></div>`;
    const pct = Math.max(10, Math.min(100, Math.round((h.ms / maxMs) * 100)));
    const cls = h.ms < 600 ? 'ok' : h.ms < 1500 ? 'slow' : 'down-b';
    const tip = `${h.ms}ms · ${new Date(h.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
    return `<div class="spark-b ${cls}" style="height:${pct}%" data-tip="${tip}"></div>`;
  }).join('');

  document.getElementById('sparkCount').textContent =
    history.length ? `(${history.length} checks)` : '';

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
      <svg viewBox="0 0 24 24" fill="none" width="24" height="24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" opacity=".3"/><path d="M8 12l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>No incidents recorded — all clear ✅</span>
    </div>`;
    return;
  }

  list.innerHTML = incidents.map(inc => {
    const isUp  = inc.status === 'up';
    const time  = new Date(inc.ts).toLocaleString([], {
      month:'short', day:'numeric', hour:'2-digit', minute:'2-digit',
    });
    const msStr = inc.ms ? `${inc.ms}ms${inc.code ? ' · HTTP '+inc.code : ''}` : '';
    return `
      <div class="inc-item">
        <span class="inc-dot ${inc.status}"></span>
        <div class="inc-body">
          <div class="inc-event ${inc.status}">${inc.event || (isUp ? '✅ Site came back online' : '🔴 Site went down')}</div>
          <div class="inc-time">${time}</div>
          ${msStr ? `<div class="inc-ms">${msStr}</div>` : ''}
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
  const total  = 2 * Math.PI * 20;
  circle.style.strokeDashoffset = total;

  let n = 5;
  document.getElementById('rbCountdown').textContent = n;

  const t = setInterval(() => {
    n--;
    document.getElementById('rbCountdown').textContent = n;
    const pct = (5 - n) / 5;
    circle.style.transition = 'stroke-dashoffset .9s linear';
    circle.style.strokeDashoffset = total * (1 - pct);
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
let cColor  = {r:239, g:68,  b:68};
let cTarget = {r:239, g:68,  b:68};

function setCanvasMode(mode) {
  cTarget = mode === 'green' ? {r:16,g:185,b:129} : {r:239,g:68,b:68};
}

function lerpColor(a, b, t) {
  return { r:Math.round(a.r+(b.r-a.r)*t), g:Math.round(a.g+(b.g-a.g)*t), b:Math.round(a.b+(b.b-a.b)*t) };
}

function resizeCanvas() {
  cW = canvas.width  = window.innerWidth;
  cH = canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function drawCanvas() {
  requestAnimationFrame(drawCanvas);
  cColor  = lerpColor(cColor, cTarget, 0.015);
  const {r,g,b} = cColor;

  ctx.clearRect(0, 0, cW, cH);

  // Sweeping gradient orb
  cAngle += 0.003;
  const bx = cW * 0.5 + Math.cos(cAngle) * cW * 0.25;
  const by = cH * 0.3  + Math.sin(cAngle * 0.7) * cH * 0.2;
  const grad = ctx.createRadialGradient(bx, by, 0, bx, by, cW * 0.45);
  grad.addColorStop(0,   `rgba(${r},${g},${b},0.06)`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.02)`);
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cW, cH);

  // Second orb counter-rotating
  const bx2 = cW * 0.5 + Math.cos(-cAngle * 1.3 + 2) * cW * 0.3;
  const by2 = cH * 0.7  + Math.sin(-cAngle * 0.9 + 1) * cH * 0.15;
  const grad2 = ctx.createRadialGradient(bx2, by2, 0, bx2, by2, cW * 0.3);
  grad2.addColorStop(0,   `rgba(59,130,246,0.04)`);
  grad2.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = grad2;
  ctx.fillRect(0, 0, cW, cH);
}

drawCanvas();

// ── PARTICLES ─────────────────────────────────
function spawnParticles() {
  const container = document.getElementById('particles');
  const count = window.innerWidth < 640 ? 20 : 40;

  for (let i = 0; i < count; i++) {
    const el  = document.createElement('div');
    el.className = 'particle';
    const sz  = Math.random() * 2.5 + 0.8;
    const x   = Math.random() * 100;
    const dur = Math.random() * 22 + 14;
    const del = -(Math.random() * 22);
    const op  = Math.random() * 0.35 + 0.08;
    const col = Math.random() > 0.6 ? '239,68,68' : Math.random() > 0.5 ? '59,130,246' : '110,231,183';

    el.style.cssText = `
      left:${x}%; bottom:-5%;
      width:${sz}px; height:${sz}px;
      background:rgba(${col},${op});
      box-shadow:0 0 ${sz*2}px rgba(${col},${op*0.5});
      animation-duration:${dur}s;
      animation-delay:${del}s;
    `;
    container.appendChild(el);
  }
}
