/* =============================================
   UPTRACKER — Core Engine
   Realtime website downtime monitor
   No build tools, runs on any static host
   ============================================= */

'use strict';

// ── CONSTANTS ───────────────────────────────
const STORAGE_KEY    = 'uptracker_sites_v2';
const LOG_KEY        = 'uptracker_logs_v2';
const DEFAULT_TIMEOUT = 10000; // 10 seconds
const SPARK_HISTORY  = 20;     // bars in sparkline
const PROXY_URLS = [
  // CORS proxy list — tries each one, picks fastest that works
  'https://api.allorigins.win/get?url=',
  'https://corsproxy.io/?',
  'https://cors-anywhere.herokuapp.com/',
];

// ── STATE ────────────────────────────────────
let sites     = [];
let logs      = {};       // { siteId: [{ ts, status, ms, code }] }
let timers    = {};       // { siteId: intervalId }
let countdown = 30;
let countdownTimer;

// ── INIT ────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  renderAll();
  bindEvents();
  startGlobalCountdown();

  // Preload roiprofitacademy.in if no sites saved
  if (sites.length === 0) {
    addSite('ROI Profit Academy', 'https://roiprofitacademy.in', 30);
  }
});

// ── STORAGE ──────────────────────────────────
function loadFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    const l = localStorage.getItem(LOG_KEY);
    sites = s ? JSON.parse(s) : [];
    logs  = l ? JSON.parse(l) : {};
  } catch(e) {
    sites = []; logs = {};
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sites));
    // Keep only last 100 log entries per site
    const trimmed = {};
    for (const id in logs) {
      trimmed[id] = (logs[id] || []).slice(-100);
    }
    localStorage.setItem(LOG_KEY, JSON.stringify(trimmed));
  } catch(e) {}
}

// ── SITE MANAGEMENT ──────────────────────────
function addSite(name, url, interval = 30) {
  const id = 'site_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  const site = {
    id,
    name:     name.trim(),
    url:      normalizeUrl(url.trim()),
    interval: interval,
    status:   'checking',
    statusCode: null,
    responseMs: null,
    uptimePct:  null,
    lastCheck:  null,
    addedAt:    Date.now(),
    history:    [],   // last N {status, ms, ts}
  };
  sites.push(site);
  logs[id] = [];
  saveToStorage();
  renderAll();
  scheduleChecks(site);
  checkSite(site);
  return site;
}

function removeSite(id) {
  // Stop timer
  if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
  sites = sites.filter(s => s.id !== id);
  delete logs[id];
  saveToStorage();
  renderAll();
  showToast('Site removed', 'info', '🗑️');
}

function normalizeUrl(url) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

// ── CHECK ENGINE ─────────────────────────────
function scheduleChecks(site) {
  if (timers[site.id]) clearInterval(timers[site.id]);
  timers[site.id] = setInterval(() => checkSite(site), site.interval * 1000);
}

function scheduleAllChecks() {
  sites.forEach(s => scheduleChecks(s));
}

async function checkSite(site) {
  const start = performance.now();
  site.status = 'checking';
  updateCardStatus(site);

  let success = false;
  let ms = null;
  let code = null;

  // Strategy: try a no-cors fetch first (only tells us if reachable),
  // then fall back to CORS proxy for status code
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

    try {
      // Try direct no-cors fetch — will succeed if site is up (opaque response)
      const res = await fetch(site.url, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeout);
      ms = Math.round(performance.now() - start);
      // no-cors gives opaque responses — if we get here, site responded
      success = true;
      code = 200; // assume 200 since we can't read opaque headers
    } catch(fetchErr) {
      clearTimeout(timeout);
      if (fetchErr.name === 'AbortError') {
        // Timed out — site is down or very slow
        success = false;
        ms = DEFAULT_TIMEOUT;
      } else {
        // Network error — try cors proxy
        const proxyResult = await checkViaProxy(site.url, start);
        success = proxyResult.success;
        ms = proxyResult.ms;
        code = proxyResult.code;
      }
    }
  } catch(e) {
    success = false;
    ms = Math.round(performance.now() - start);
  }

  // Update site state
  const prevStatus = site.status;
  site.status      = success ? 'up' : 'down';
  site.responseMs  = ms;
  site.statusCode  = code;
  site.lastCheck   = Date.now();

  // Push to history
  site.history.push({ status: site.status, ms, ts: Date.now() });
  if (site.history.length > SPARK_HISTORY) site.history.shift();

  // Calculate uptime %
  site.uptimePct = calcUptimePct(site.history);

  // Log incidents
  const prevState = (logs[site.id] || []).at(-1)?.status;
  if (prevState !== site.status) {
    const entry = {
      ts: Date.now(),
      status: site.status,
      ms,
      code,
      event: site.status === 'up'
        ? '✅ Site came back online'
        : '🔴 Site went down',
    };
    if (!logs[site.id]) logs[site.id] = [];
    logs[site.id].push(entry);

    // Notify
    if (site.status === 'down') {
      showToast(`${site.name} is DOWN!`, 'down', '🔴');
    } else if (prevState === 'down') {
      showToast(`${site.name} is back online`, 'up', '✅');
    }
  }

  saveToStorage();
  updateCardStatus(site);
  updateSummaryBar();
}

async function checkViaProxy(url, start) {
  for (const proxy of PROXY_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(proxy + encodeURIComponent(url), {
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeout);
      const ms = Math.round(performance.now() - start);
      if (res.ok) {
        return { success: true, ms, code: 200 };
      }
    } catch(e) { /* try next proxy */ }
  }
  return { success: false, ms: Math.round(performance.now() - start), code: null };
}

function calcUptimePct(history) {
  if (!history || history.length === 0) return null;
  const up = history.filter(h => h.status === 'up').length;
  return Math.round((up / history.length) * 1000) / 10;
}

async function checkAllSites() {
  const btn = document.getElementById('checkNowBtn');
  const icon = btn?.querySelector('svg');
  if (icon) icon.classList.add('spinning');
  btn?.setAttribute('disabled', '');

  await Promise.allSettled(sites.map(s => checkSite(s)));

  document.getElementById('lastCheckedTime').textContent = formatTime(Date.now());
  if (icon) icon.classList.remove('spinning');
  btn?.removeAttribute('disabled');

  resetCountdown();
}

// ── RENDER ───────────────────────────────────
function renderAll() {
  const grid  = document.getElementById('sitesGrid');
  const empty = document.getElementById('emptyState');

  if (sites.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    grid.innerHTML = sites.map(buildCardHTML).join('');
    sites.forEach(s => scheduleChecks(s));
  }
  updateSummaryBar();
}

function buildCardHTML(site) {
  const uptime   = site.uptimePct !== null ? site.uptimePct.toFixed(1) + '%' : '—';
  const response = site.responseMs !== null ? site.responseMs + 'ms' : '—';
  const responseClass = getResponseClass(site.responseMs);
  const uptimeClass   = getUptimeClass(site.uptimePct);
  const uptimeFill    = site.uptimePct !== null ? site.uptimePct : 0;
  const uptimeFillClass = site.uptimePct < 90 ? (site.uptimePct < 70 ? 'low' : 'warn') : '';

  const sparkBars = buildSparkBars(site.history);

  const faviconUrl = getFaviconUrl(site.url);
  const domain = getDomain(site.url);

  const statusDotClass = site.status;
  const statusLabel = site.status === 'up' ? 'Online'
                    : site.status === 'down' ? 'Offline'
                    : 'Checking…';

  const sinceTxt = site.lastCheck
    ? 'since ' + formatRelativeTime(site.lastCheck)
    : '';

  const checksTxt = site.history.length
    ? `${site.history.filter(h=>h.status==='up').length}/${site.history.length} checks passed`
    : 'No checks yet';

  return `
    <div class="site-card status-${site.status}" id="card-${site.id}" data-id="${site.id}">
      <div class="card-header">
        <div class="card-identity">
          <div class="site-favicon">
            <img src="${faviconUrl}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"/>
            <span style="display:none;font-size:15px;">${getInitial(site.name)}</span>
          </div>
          <div class="card-title-wrap">
            <div class="card-name" title="${escHtml(site.name)}">${escHtml(site.name)}</div>
            <div class="card-url" title="${escHtml(site.url)}">${domain}</div>
          </div>
        </div>
        <div class="card-actions">
          <button class="icon-btn" onclick="openSiteUrl('${escAttr(site.url)}')" title="Open site">
            <svg viewBox="0 0 20 20" fill="none"><path d="M11 3h6v6M17 3l-8 8M8 5H4a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn danger" onclick="removeSite('${site.id}')" title="Remove site">
            <svg viewBox="0 0 20 20" fill="none"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>

      <div class="status-row">
        <div class="status-dot ${statusDotClass}"></div>
        <span class="status-text ${statusDotClass}">${statusLabel}</span>
        <span class="status-since">${sinceTxt}</span>
      </div>

      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">Response</div>
          <div class="metric-value ${responseClass}">${response}</div>
          <div class="metric-sub">Last check</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Uptime</div>
          <div class="metric-value ${uptimeClass}">${uptime}</div>
          <div class="metric-sub">Last ${site.history.length} checks</div>
        </div>
      </div>

      <div class="uptime-section">
        <div class="uptime-header">
          <span>Uptime (last ${site.history.length || SPARK_HISTORY} checks)</span>
          <span class="uptime-pct ${uptimeClass}">${uptime}</span>
        </div>
        <div class="uptime-bar-track">
          <div class="uptime-bar-fill ${uptimeFillClass}" style="width:${uptimeFill}%"></div>
        </div>
      </div>

      <div class="sparkline-section">
        <div class="sparkline-label">Response History</div>
        <div class="sparkline-wrap" id="spark-${site.id}">
          ${sparkBars}
        </div>
      </div>

      <div class="card-footer">
        <div class="footer-meta">${checksTxt} · <span>Every ${site.interval}s</span></div>
        <button class="view-log-btn" onclick="openLogPanel('${site.id}')">
          <svg viewBox="0 0 20 20" fill="none"><path d="M3 5h14M3 10h14M3 15h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          View Log
        </button>
      </div>
    </div>
  `;
}

function buildSparkBars(history) {
  if (!history || history.length === 0) {
    return Array(SPARK_HISTORY).fill(0).map(() =>
      `<div class="spark-bar empty" style="height:20%" data-tip="No data"></div>`
    ).join('');
  }

  // Pad left with empty bars if < SPARK_HISTORY
  const padded = [
    ...Array(Math.max(0, SPARK_HISTORY - history.length)).fill(null),
    ...history,
  ];

  const maxMs = Math.max(...history.filter(h => h.ms).map(h => h.ms), 1000);

  return padded.map(h => {
    if (!h) return `<div class="spark-bar empty" style="height:20%" data-tip="No data"></div>`;
    if (h.status === 'down') {
      return `<div class="spark-bar down-bar" style="height:100%" data-tip="DOWN"></div>`;
    }
    const pct = Math.max(10, Math.min(100, Math.round((h.ms / maxMs) * 100)));
    const cls = h.ms < 500 ? 'ok' : h.ms < 1500 ? 'slow' : 'down-bar';
    const tip = `${h.ms}ms · ${formatTime(h.ts)}`;
    return `<div class="spark-bar ${cls}" style="height:${pct}%" data-tip="${escAttr(tip)}"></div>`;
  }).join('');
}

// ── TARGETED DOM UPDATE (no full re-render) ──
function updateCardStatus(site) {
  const card = document.getElementById('card-' + site.id);
  if (!card) {
    renderAll();
    return;
  }

  // Update card class
  card.className = `site-card status-${site.status}`;

  // Status dot & text
  const dot   = card.querySelector('.status-dot');
  const txt   = card.querySelector('.status-text');
  const since = card.querySelector('.status-since');
  if (dot) { dot.className = `status-dot ${site.status}`; }
  if (txt) {
    txt.className = `status-text ${site.status}`;
    txt.textContent = site.status === 'up' ? 'Online'
                    : site.status === 'down' ? 'Offline'
                    : 'Checking…';
  }
  if (since && site.lastCheck) {
    since.textContent = 'since ' + formatRelativeTime(site.lastCheck);
  }

  // Metrics
  const metricValues = card.querySelectorAll('.metric-value');
  if (metricValues[0]) {
    metricValues[0].textContent = site.responseMs !== null ? site.responseMs + 'ms' : '—';
    metricValues[0].className   = `metric-value ${getResponseClass(site.responseMs)}`;
  }
  if (metricValues[1]) {
    const uptime = site.uptimePct !== null ? site.uptimePct.toFixed(1) + '%' : '—';
    metricValues[1].textContent = uptime;
    metricValues[1].className   = `metric-value ${getUptimeClass(site.uptimePct)}`;
  }

  // Uptime bar
  const fill = card.querySelector('.uptime-bar-fill');
  if (fill) {
    fill.style.width = (site.uptimePct || 0) + '%';
    fill.className = 'uptime-bar-fill' +
      (site.uptimePct < 90 ? (site.uptimePct < 70 ? ' low' : ' warn') : '');
  }
  const uptimePctEl = card.querySelector('.uptime-pct');
  if (uptimePctEl) {
    uptimePctEl.textContent = site.uptimePct !== null ? site.uptimePct.toFixed(1) + '%' : '—';
    uptimePctEl.className   = `uptime-pct ${getUptimeClass(site.uptimePct)}`;
  }

  // Sparkline
  const spark = document.getElementById('spark-' + site.id);
  if (spark) spark.innerHTML = buildSparkBars(site.history);

  // Footer
  const footer = card.querySelector('.footer-meta');
  if (footer) {
    const checksTxt = site.history.length
      ? `${site.history.filter(h=>h.status==='up').length}/${site.history.length} checks passed`
      : 'No checks yet';
    footer.innerHTML = `${checksTxt} · <span>Every ${site.interval}s</span>`;
  }
}

function updateSummaryBar() {
  document.getElementById('totalSites').textContent   = sites.length;
  document.getElementById('sitesUp').textContent      = sites.filter(s => s.status === 'up').length;
  document.getElementById('sitesDown').textContent    = sites.filter(s => s.status === 'down').length;

  const withUptime  = sites.filter(s => s.uptimePct !== null);
  const withResponse = sites.filter(s => s.responseMs !== null && s.status === 'up');

  document.getElementById('avgUptime').textContent = withUptime.length
    ? (withUptime.reduce((a,s) => a + s.uptimePct, 0) / withUptime.length).toFixed(1) + '%'
    : '—';

  document.getElementById('avgResponse').textContent = withResponse.length
    ? Math.round(withResponse.reduce((a,s) => a + s.responseMs, 0) / withResponse.length) + 'ms'
    : '—';
}

// ── COUNTDOWN ────────────────────────────────
function startGlobalCountdown() {
  const defaultInterval = sites.length > 0
    ? Math.min(...sites.map(s => s.interval))
    : 30;
  countdown = defaultInterval;
  updateCountdownDisplay();

  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      countdown = defaultInterval;
      document.getElementById('lastCheckedTime').textContent = formatTime(Date.now());
    }
    updateCountdownDisplay();
  }, 1000);
}

function resetCountdown() {
  const defaultInterval = sites.length > 0
    ? Math.min(...sites.map(s => s.interval))
    : 30;
  countdown = defaultInterval;
  updateCountdownDisplay();
}

function updateCountdownDisplay() {
  const el = document.getElementById('countdown');
  if (el) el.textContent = countdown + 's';
}

// ── INCIDENT LOG PANEL ────────────────────────
function openLogPanel(siteId) {
  const site = sites.find(s => s.id === siteId);
  if (!site) return;

  const panel   = document.getElementById('logPanel');
  const overlay = document.getElementById('logOverlay');
  const title   = document.getElementById('logSiteName');
  const content = document.getElementById('logContent');

  title.textContent = site.name;

  const entries = (logs[siteId] || []).slice().reverse();
  if (entries.length === 0) {
    content.innerHTML = `
      <div class="log-empty">
        <svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="28" stroke="currentColor" stroke-width="2"/><path d="M22 32h20M32 22v20" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/></svg>
        <p>No incidents recorded yet.<br/>Monitoring in progress…</p>
      </div>
    `;
  } else {
    content.innerHTML = entries.map(entry => `
      <div class="log-entry">
        <div class="log-dot ${entry.status}"></div>
        <div class="log-body">
          <div class="log-event ${entry.status}">${entry.event}</div>
          <div class="log-time">${formatFullTime(entry.ts)}</div>
          ${entry.ms !== null ? `<div class="log-response">Response: ${entry.ms}ms${entry.code ? ' · HTTP ' + entry.code : ''}</div>` : ''}
        </div>
      </div>
    `).join('');
  }

  panel.classList.add('open');
  overlay.classList.add('active');
}

function closeLogPanel() {
  document.getElementById('logPanel').classList.remove('open');
  document.getElementById('logOverlay').classList.remove('active');
}

// ── MODAL ────────────────────────────────────
function openAddModal() {
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('siteName').value = '';
  document.getElementById('siteUrl').value  = '';
  document.getElementById('checkInterval').value = '30';
  document.getElementById('modalError').textContent = '';
  setTimeout(() => document.getElementById('siteName').focus(), 100);
}

function closeAddModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

function handleAddSite() {
  const name     = document.getElementById('siteName').value.trim();
  const url      = document.getElementById('siteUrl').value.trim();
  const interval = parseInt(document.getElementById('checkInterval').value);
  const errEl    = document.getElementById('modalError');

  if (!name) { errEl.textContent = 'Please enter a site name.'; return; }
  if (!url)  { errEl.textContent = 'Please enter a URL.'; return; }

  const normalized = normalizeUrl(url);
  if (!isValidUrl(normalized)) { errEl.textContent = 'Please enter a valid URL.'; return; }

  if (sites.find(s => s.url === normalized)) {
    errEl.textContent = 'This site is already being monitored.'; return;
  }

  closeAddModal();
  addSite(name, normalized, interval);
  showToast(`Added ${name}`, 'info', '✅');
}

// ── EVENT BINDINGS ────────────────────────────
function bindEvents() {
  document.getElementById('addSiteBtn').addEventListener('click', openAddModal);
  document.getElementById('checkNowBtn').addEventListener('click', checkAllSites);
  document.getElementById('modalClose').addEventListener('click', closeAddModal);
  document.getElementById('modalCancelBtn').addEventListener('click', closeAddModal);
  document.getElementById('modalAddBtn').addEventListener('click', handleAddSite);
  document.getElementById('logClose').addEventListener('click', closeLogPanel);
  document.getElementById('logOverlay').addEventListener('click', closeLogPanel);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAddModal();
  });

  // Enter key in modal
  document.getElementById('siteUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddSite();
  });
  document.getElementById('siteName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('siteUrl').focus();
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeAddModal(); closeLogPanel(); }
  });
}

// ── HELPERS ──────────────────────────────────
function openSiteUrl(url) { window.open(url, '_blank', 'noopener'); }

function getFaviconUrl(url) {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  } catch { return ''; }
}

function getDomain(url) {
  try { return new URL(url).hostname.replace('www.',''); }
  catch { return url; }
}

function getInitial(name) {
  return name.charAt(0).toUpperCase();
}

function getResponseClass(ms) {
  if (ms === null) return 'dim';
  if (ms < 500)  return 'good';
  if (ms < 1500) return 'warn';
  return 'bad';
}

function getUptimeClass(pct) {
  if (pct === null) return 'dim';
  if (pct >= 99)  return 'good';
  if (pct >= 90)  return 'warn';
  return 'bad';
}

function isValidUrl(url) {
  try { new URL(url); return true; }
  catch { return false; }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(str) {
  return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatFullTime(ts) {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)  return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  return Math.floor(diff/3600000) + 'h ago';
}

// ── TOAST ────────────────────────────────────
function showToast(message, type = 'info', icon = 'ℹ️') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── EXPOSE TO HTML onclick handlers ─────────
window.removeSite   = removeSite;
window.openLogPanel = openLogPanel;
window.openSiteUrl  = openSiteUrl;
