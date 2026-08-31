/**
 * UPTRACKER — Maintenance Page Engine
 * Handles: status polling, UI updates, canvas bg, particles, sparkline
 */

'use strict';

// ── QUERY PARAMS ─────────────────────────────
const params    = new URLSearchParams(location.search);
const SITE_ID   = params.get('id')   || '';
const SITE_URL  = params.get('url')  || '';
const SITE_NAME = params.get('name') || 'This website';

const cfg    = window.UPTRACKER_CONFIG || {};
const TOKEN  = cfg.GITHUB_TOKEN || '';
const GIST   = cfg.GIST_ID      || '';
const FILE   = 'uptracker_data.json';

// ── STATE ─────────────────────────────────────
let currentStatus  = 'loading';
let isRedirecting  = false;
let pollIntervalId = null;
let checks         = [];

// ── INIT ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  populateStatic();
  initCanvas();
  initParticles();
  initSparkline([]);
  poll();
  pollIntervalId = setInterval(poll, 30000);
});

// ── STATIC CONTENT ────────────────────────────
function populateStatic() {
  // Site name
  document.getElementById('brandName').textContent = SITE_NAME;
  document.getElementById('brandName').title       = SITE_NAME;
  document.title = `${SITE_NAME} — Under Maintenance`;

  if (SITE_URL) {
    try {
      const url    = new URL(SITE_URL);
      const domain = url.hostname.replace('www.', '');
      document.getElementById('brandUrl').textContent = domain;
      document.getElementById('visitLink').href       = SITE_URL;

      // Favicon
      const img    = document.getElementById('faviconImg');
      img.src      = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      img.alt      = domain;
      img.onload   = () => {
        img.classList.add('loaded');
        document.getElementById('faviconFallback').style.display = 'none';
      };
      img.onerror  = () => { img.style.display = 'none'; };
    } catch {}
  } else {
    document.getElementById('visitLink').style.display = 'none';
    document.getElementById('brandUrl').style.display  = 'none';
  }
}

// ── STATUS POLL ───────────────────────────────
async function poll() {
  if (!TOKEN || !GIST) {
    setStatus('down', null, null, []);
    document.getElementById('pollLabel').textContent = 'Monitoring active';
    document.getElementById('pollDot').style.animation = 'none';
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/gists/${GIST}`, {
      headers: {
        Authorization: `token ${TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
      cache: 'no-store',
    });

    if (!res.ok) throw new Error(res.status);

    const json = await res.json();
    const raw  = json.files?.[FILE]?.content;
    if (!raw) throw new Error('empty');

    const data = JSON.parse(raw);
    const site = SITE_ID
      ? (data.sites?.find(s => s.id === SITE_ID) || data.sites?.find(s => s.url === SITE_URL))
      : data.sites?.find(s => s.url === SITE_URL);

    if (!site) throw new Error('site not found');

    const siteChecks  = data.checks?.[site.id]  || [];
    const incidents   = data.incidents?.[site.id] || [];
    checks = siteChecks;

    const upCount  = siteChecks.filter(c => c.status === 'up').length;
    const upPct    = siteChecks.length ? Math.round(upCount / siteChecks.length * 100) : null;
    const isUp     = site.lastStatus === 'up';

    setStatus(isUp ? 'up' : 'down', site, upPct, siteChecks, incidents);
    document.getElementById('pollLabel').textContent = 'Checking every 30s';

    if (isUp && SITE_URL && !isRedirecting) startRedirect();

  } catch (e) {
    console.warn('[Uptracker] Poll error:', e.message);
    document.getElementById('pollLabel').textContent = 'Retrying…';
  }
}

// ── SET STATUS UI ─────────────────────────────
function setStatus(state, site, upPct, siteChecks = [], incidents = []) {
  if (currentStatus === state && state !== 'loading') {
    // Still update metrics even if state unchanged
    updateMetrics(site, upPct, siteChecks, incidents);
    return;
  }
  currentStatus = state;

  const isDown = state === 'down';
  const isUp   = state === 'up';

  // ── Status pill ──────────────────────────────
  const pill = document.getElementById('statusPill');
  const dot  = document.getElementById('pillDot');
  const txt  = document.getElementById('pillText');
  pill.className = `status-pill ${state}`;
  txt.textContent = isDown ? 'Service Disruption' : isUp ? 'Back Online' : 'Checking status…';

  // ── Headline ─────────────────────────────────
  const accEl = document.querySelector('.headline-accent');
  if (isUp) {
    document.getElementById('headline').innerHTML = `We're back<br/><span class="headline-accent">online.</span>`;
    document.getElementById('headlineSub').textContent =
      `${SITE_NAME} has recovered and is responding normally. You'll be redirected shortly.`;
  } else if (isDown) {
    document.getElementById('headline').innerHTML = `We'll be right<br/><span class="headline-accent red-accent">back.</span>`;
    document.getElementById('headlineSub').textContent =
      `We're aware of the disruption and working to restore ${SITE_NAME} as quickly as possible.`;
  }

  // ── Status icon ──────────────────────────────
  const iconWrap = document.getElementById('statusIconWrap');
  const iconCore = document.getElementById('statusIconCore');
  const emoji    = document.getElementById('statusEmoji');
  iconWrap.className = `status-icon-wrap ${isUp ? 'up' : ''}`;
  iconCore.className = `status-icon-core ${isUp ? 'up' : ''}`;
  emoji.textContent  = isUp ? '✅' : state === 'loading' ? '🔄' : '🔧';

  // ── Canvas colour ─────────────────────────────
  updateCanvasColor(isUp ? 'green' : isDown ? 'red' : 'blue');

  // ── Metrics + timeline ────────────────────────
  updateMetrics(site, upPct, siteChecks, incidents);
}

function updateMetrics(site, upPct, siteChecks, incidents) {
  if (!site) return;

  // Uptime metric
  const mUp  = document.getElementById('mUptime');
  const mBar = document.getElementById('mUptimeBar');
  if (upPct !== null) {
    mUp.textContent  = upPct + '%';
    mUp.className    = `metric-val ${upPct >= 99 ? 'good' : upPct >= 90 ? 'warn' : 'bad'}`;
    mBar.style.width = upPct + '%';
  }

  // Response metric
  const mResp = document.getElementById('mResponse');
  const mTag  = document.getElementById('mResponseTag');
  if (site.lastMs) {
    mResp.textContent = site.lastMs + 'ms';
    mResp.className   = `metric-val ${site.lastMs < 600 ? 'good' : site.lastMs < 1500 ? 'warn' : 'bad'}`;
    mTag.textContent  = site.lastMs < 600 ? 'Fast' : site.lastMs < 1500 ? 'Slow' : 'Very slow';
    mTag.className    = `metric-tag ${site.lastMs < 600 ? '' : site.lastMs < 1500 ? 'warn' : 'bad'}`;
  }

  // Checked time
  const mChk = document.getElementById('mChecked');
  if (site.lastChecked) {
    mChk.textContent = new Date(site.lastChecked).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    mChk.className = 'metric-val';
  }

  // Progress bar
  if (upPct !== null) {
    const fill = document.getElementById('progressFill');
    const glow = document.getElementById('progressGlow');
    const pct  = document.getElementById('progressPct');
    const cls  = upPct >= 90 ? 'good' : upPct >= 70 ? 'warn' : '';
    fill.style.width = upPct + '%';
    glow.style.width = upPct + '%';
    fill.className = `progress-fill ${cls}`;
    glow.className = `progress-glow ${cls}`;
    pct.textContent = upPct + '%';
    document.getElementById('progressChecks').textContent =
      `${siteChecks.length} total checks`;
  }

  // Sparkline
  initSparkline(siteChecks.slice(-30));

  // Timeline
  renderTimeline(incidents.slice(-5).reverse());
}

// ── SPARKLINE ─────────────────────────────────
function initSparkline(history) {
  const container = document.getElementById('sparkline');
  const BARS = 30;
  const padded = [...Array(Math.max(0, BARS - history.length)).fill(null), ...history];
  const maxMs  = Math.max(...history.filter(h => h?.ms).map(h => h.ms), 800);

  container.innerHTML = padded.map(h => {
    if (!h) return `<div class="spark-bar empty" style="height:15%"></div>`;
    if (h.status === 'down') return `<div class="spark-bar down-bar" style="height:100%" data-tip="DOWN"></div>`;
    const pct = Math.max(12, Math.min(100, Math.round((h.ms / maxMs) * 100)));
    const cls = h.ms < 600 ? 'ok' : h.ms < 1500 ? 'slow' : 'down-bar';
    const tip = `${h.ms}ms · ${new Date(h.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
    return `<div class="spark-bar ${cls}" style="height:${pct}%" data-tip="${tip}"></div>`;
  }).join('');
}

// ── TIMELINE ─────────────────────────────────
function renderTimeline(incidents) {
  const container = document.getElementById('timeline');
  if (!incidents || incidents.length === 0) {
    container.innerHTML = `
      <div class="timeline-empty">
        <span class="tl-dot dim"></span>
        <span class="tl-text dim" style="font-size:12px;color:var(--dim)">No recent incidents</span>
      </div>`;
    return;
  }

  container.innerHTML = incidents.map(inc => {
    const isUp = inc.status === 'up';
    const time = new Date(inc.ts).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    return `
      <div class="tl-item">
        <span class="tl-dot ${inc.status}"></span>
        <div class="tl-body">
          <div class="tl-event ${inc.status}">${inc.event || (isUp ? '✅ Site came back online' : '🔴 Site went down')}</div>
          <div class="tl-time">${time}</div>
          ${inc.ms ? `<div class="tl-ms">${inc.ms}ms${inc.code ? ' · HTTP ' + inc.code : ''}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── REDIRECT ─────────────────────────────────
function startRedirect() {
  if (isRedirecting) return;
  isRedirecting = true;
  clearInterval(pollIntervalId);

  const card = document.getElementById('recoveryCard');
  card.style.display = 'flex';

  const circle = document.getElementById('recoveryCircle');
  const total  = 2 * Math.PI * 19; // circumference

  let n = 5;
  document.getElementById('countdownNum').textContent = n;
  circle.style.strokeDashoffset = total;

  const interval = setInterval(() => {
    n--;
    document.getElementById('countdownNum').textContent = n;
    const progress = (5 - n) / 5;
    circle.style.strokeDashoffset = total * (1 - progress);
    circle.style.transition = 'stroke-dashoffset 0.9s linear';

    if (n <= 0) {
      clearInterval(interval);
      if (SITE_URL) window.location.replace(SITE_URL);
    }
  }, 1000);
}

// ── CANVAS BACKGROUND ─────────────────────────
const canvas = document.getElementById('bgCanvas');
const ctx    = canvas.getContext('2d');

let canvasW, canvasH;
let canvasColor = { r: 239, g: 68, b: 68 };   // default red
let targetColor = { r: 239, g: 68, b: 68 };

function updateCanvasColor(scheme) {
  const colors = {
    red:   { r: 239, g: 68,  b: 68  },
    green: { r: 16,  g: 185, b: 129 },
    blue:  { r: 59,  g: 130, b: 246 },
  };
  targetColor = colors[scheme] || colors.red;
}

function lerpColor(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function resizeCanvas() {
  canvasW = canvas.width  = window.innerWidth;
  canvasH = canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

let canvasAngle = 0;

function drawCanvas() {
  requestAnimationFrame(drawCanvas);
  canvasColor = lerpColor(canvasColor, targetColor, 0.02);

  ctx.clearRect(0, 0, canvasW, canvasH);
  const { r, g, b } = canvasColor;

  // Grid
  ctx.strokeStyle = `rgba(${r},${g},${b},0.025)`;
  ctx.lineWidth   = 1;
  const gsize = 48;
  for (let x = 0; x < canvasW; x += gsize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvasH); ctx.stroke();
  }
  for (let y = 0; y < canvasH; y += gsize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasW, y); ctx.stroke();
  }

  // Top radial glow
  const grd = ctx.createRadialGradient(canvasW / 2, 0, 0, canvasW / 2, 0, canvasH * 0.7);
  grd.addColorStop(0,   `rgba(${r},${g},${b},0.07)`);
  grd.addColorStop(0.4, `rgba(${r},${g},${b},0.02)`);
  grd.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Orbiting glow blob
  canvasAngle += 0.004;
  const bx = canvasW / 2 + Math.cos(canvasAngle) * canvasW * 0.35;
  const by = canvasH / 2 + Math.sin(canvasAngle * 0.7) * canvasH * 0.3;
  const blob = ctx.createRadialGradient(bx, by, 0, bx, by, canvasW * 0.3);
  blob.addColorStop(0,   `rgba(${r},${g},${b},0.05)`);
  blob.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = blob;
  ctx.fillRect(0, 0, canvasW, canvasH);
}

drawCanvas();

// ── PARTICLES ─────────────────────────────────
function initParticles() {
  const container = document.getElementById('particles');
  const count     = window.innerWidth < 640 ? 18 : 35;

  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';

    const size = Math.random() * 3 + 1;
    const x    = Math.random() * 100;
    const dur  = Math.random() * 20 + 15;
    const del  = Math.random() * 20;
    const op   = Math.random() * 0.4 + 0.1;
    const hue  = Math.random() > 0.5 ? '239,68,68' : '59,130,246';

    p.style.cssText = `
      left: ${x}%;
      width: ${size}px;
      height: ${size}px;
      background: rgba(${hue},${op});
      animation-duration: ${dur}s;
      animation-delay: -${del}s;
    `;
    container.appendChild(p);
  }
}
