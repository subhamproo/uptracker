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
    addSite(
      'ROI Profit Academy',
      'https://roiprofitacademy.in',
      30,
      'https://discord.com/api/webhooks/1465360998411272344/pFe4scsMHqiJNv6WqMmkzIJfrBYxrdr0UkNcKn5i1yqT1Q3cFiOEKI3NAGUzpaZUBXur',
      'both'
    );
  }
});

// ── STORAGE ──────────────────────────────────
function loadFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    const l = localStorage.getItem(LOG_KEY);
    sites = s ? JSON.parse(s) : [];
    logs  = l ? JSON.parse(l) : {};

    // Migrate existing sites that don't have webhook fields
    sites.forEach(site => {
      if (!('webhookUrl' in site)) site.webhookUrl = '';
      if (!('alertMode'  in site)) site.alertMode  = 'offline';
    });

    // Pre-configure ROI Profit Academy webhook if not already set
    const roi = sites.find(s => s.url && s.url.includes('roiprofitacademy.in'));
    if (roi && !roi.webhookUrl) {
      roi.webhookUrl = 'https://discord.com/api/webhooks/1465360998411272344/pFe4scsMHqiJNv6WqMmkzIJfrBYxrdr0UkNcKn5i1yqT1Q3cFiOEKI3NAGUzpaZUBXur';
      roi.alertMode  = 'both';
    }
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
function addSite(name, url, interval = 30, webhookUrl = '', alertMode = 'offline') {
  const id = 'site_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  const site = {
    id,
    name:        name.trim(),
    url:         normalizeUrl(url.trim()),
    interval:    interval,
    status:      'checking',
    statusCode:  null,
    responseMs:  null,
    uptimePct:   null,
    lastCheck:   null,
    addedAt:     Date.now(),
    history:     [],
    webhookUrl:  webhookUrl || '',
    alertMode:   alertMode || 'offline', // 'offline' | 'both'
  };
  sites.push(site);
  logs[id] = [];
  saveToStorage();
  renderAll();
  scheduleChecks(site);
  checkSite(site);
  return site;
}

function updateSite(id, changes) {
  const site = sites.find(s => s.id === id);
  if (!site) return;
  Object.assign(site, changes);
  saveToStorage();
  // Reschedule if interval changed
  scheduleChecks(site);
  updateCardStatus(site);
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

    // In-app toast
    if (site.status === 'down') {
      showToast(`${site.name} is DOWN!`, 'down', '🔴');
    } else if (prevState === 'down') {
      showToast(`${site.name} is back online`, 'up', '✅');
    }

    // Discord webhook — on status change
    if (site.webhookUrl) {
      const shouldSend =
        site.alertMode === 'both' ||
        (site.alertMode === 'offline' && site.status === 'down');
      if (shouldSend) {
        sendDiscordAlert(site, site.status, ms, code);
      }
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
          <button class="icon-btn" onclick="openEditModal('${site.id}')" title="Edit site &amp; webhook">
            <svg viewBox="0 0 20 20" fill="none"><path d="M13.5 3.5a2.121 2.121 0 0 1 3 3L7 16l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
        <div class="footer-right">
          ${site.webhookUrl ? `<span class="discord-badge" title="Discord alerts: ${site.alertMode === 'both' ? 'Online &amp; Offline' : 'Offline only'}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
            ${site.alertMode === 'both' ? 'Online & Offline' : 'Offline only'}
          </span>` : ''}
          <button class="view-log-btn" onclick="openLogPanel('${site.id}')">
            <svg viewBox="0 0 20 20" fill="none"><path d="M3 5h14M3 10h14M3 15h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            View Log
          </button>
        </div>
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

  // Edit modal
  document.getElementById('editModalClose').addEventListener('click', closeEditModal);
  document.getElementById('editModalCancelBtn').addEventListener('click', closeEditModal);
  document.getElementById('editModalSaveBtn').addEventListener('click', handleSaveEdit);
  document.getElementById('testWebhookBtn').addEventListener('click', handleTestWebhook);
  document.getElementById('editModalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeEditModal();
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeAddModal(); closeLogPanel(); closeEditModal(); }
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

// ── DISCORD WEBHOOK ──────────────────────────
async function sendDiscordAlert(site, status, ms, code) {
  if (!site.webhookUrl) return;

  const isDown   = status === 'down';
  const color    = isDown ? 0xEF4444 : 0x10B981;
  const emoji    = isDown ? '🔴' : '✅';
  const title    = isDown
    ? `🚨 ${site.name} is DOWN`
    : `✅ ${site.name} is back ONLINE`;
  const desc     = isDown
    ? `**${site.name}** is unreachable. Immediate attention may be required.`
    : `**${site.name}** has recovered and is responding normally.`;

  const fields = [
    { name: '🌐 URL',      value: `[${getDomain(site.url)}](${site.url})`, inline: true },
    { name: '📶 Status',   value: isDown ? '`OFFLINE`' : '`ONLINE`',       inline: true },
    { name: '⏱ Response', value: ms !== null ? `\`${ms}ms\`` : '`timeout`', inline: true },
  ];
  if (code) fields.push({ name: '🔢 HTTP Code', value: `\`${code}\``, inline: true });

  const uptime = site.uptimePct !== null ? `\`${site.uptimePct.toFixed(1)}%\`` : '`—`';
  fields.push({ name: '📊 Uptime', value: uptime, inline: true });
  fields.push({ name: '🕐 Time', value: `\`${formatFullTime(Date.now())}\``, inline: true });

  const payload = {
    username: 'Uptracker',
    avatar_url: 'https://www.google.com/s2/favicons?domain=uptracker.app&sz=64',
    embeds: [{
      title,
      description: desc,
      color,
      fields,
      footer: {
        text: `Uptracker • Checking every ${site.interval}s`,
      },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    await fetch(site.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch(e) {
    console.warn('Discord webhook failed:', e.message);
  }
}

async function sendTestDiscordAlert(webhookUrl, siteName) {
  if (!webhookUrl) return false;
  const payload = {
    username: 'Uptracker',
    embeds: [{
      title: '🧪 Test Alert from Uptracker',
      description: `This is a test notification for **${siteName || 'your site'}**.\n\nIf you see this, your Discord webhook is working correctly! ✅`,
      color: 0x3B82F6,
      fields: [
        { name: '📡 Source', value: '`Uptracker Dashboard`', inline: true },
        { name: '🕐 Time',   value: `\`${formatFullTime(Date.now())}\``, inline: true },
      ],
      footer: { text: 'Uptracker • Realtime Website Monitor' },
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok || res.status === 204;
  } catch(e) {
    return false;
  }
}

// ── EDIT MODAL ───────────────────────────────
function openEditModal(siteId) {
  const site = sites.find(s => s.id === siteId);
  if (!site) return;

  document.getElementById('editSiteId').value          = site.id;
  document.getElementById('editSiteName').value        = site.name;
  document.getElementById('editSiteUrl').value         = site.url;
  document.getElementById('editCheckInterval').value   = String(site.interval);
  document.getElementById('editWebhookUrl').value      = site.webhookUrl || '';
  document.getElementById('editModalError').textContent = '';

  // Set alert mode radio
  const mode = site.alertMode || 'offline';
  document.querySelector(`input[name="alertMode"][value="${mode}"]`).checked = true;

  document.getElementById('editModalOverlay').classList.add('active');
  setTimeout(() => document.getElementById('editSiteName').focus(), 100);
}

function closeEditModal() {
  document.getElementById('editModalOverlay').classList.remove('active');
}

async function handleSaveEdit() {
  const id       = document.getElementById('editSiteId').value;
  const name     = document.getElementById('editSiteName').value.trim();
  const url      = document.getElementById('editSiteUrl').value.trim();
  const interval = parseInt(document.getElementById('editCheckInterval').value);
  const webhook  = document.getElementById('editWebhookUrl').value.trim();
  const alertMode = document.querySelector('input[name="alertMode"]:checked')?.value || 'offline';
  const errEl    = document.getElementById('editModalError');

  if (!name) { errEl.textContent = 'Please enter a site name.'; return; }
  if (!url)  { errEl.textContent = 'Please enter a URL.'; return; }

  const normalized = normalizeUrl(url);
  if (!isValidUrl(normalized)) { errEl.textContent = 'Please enter a valid URL.'; return; }

  if (webhook && !isValidUrl(webhook)) {
    errEl.textContent = 'Please enter a valid webhook URL.'; return;
  }
  if (webhook && !webhook.includes('discord.com/api/webhooks/')) {
    errEl.textContent = 'URL must be a Discord webhook URL.'; return;
  }

  updateSite(id, {
    name:       name,
    url:        normalized,
    interval:   interval,
    webhookUrl: webhook,
    alertMode:  alertMode,
  });

  closeEditModal();
  showToast(`${name} updated`, 'info', '✏️');

  // Re-render the card to reflect name/url changes
  renderAll();
}

async function handleTestWebhook() {
  const webhook  = document.getElementById('editWebhookUrl').value.trim();
  const siteName = document.getElementById('editSiteName').value.trim();
  const btn      = document.getElementById('testWebhookBtn');
  const errEl    = document.getElementById('editModalError');

  if (!webhook) { errEl.textContent = 'Enter a webhook URL first.'; return; }
  if (!webhook.includes('discord.com/api/webhooks/')) {
    errEl.textContent = 'Must be a Discord webhook URL.'; return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  errEl.textContent = '';

  const ok = await sendTestDiscordAlert(webhook, siteName || 'Test Site');
  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 2l2.4 5.4 5.6.8-4 4 1 5.8-5-2.8L5 18l1-5.8-4-4 5.6-.8L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg> Send Test Alert`;

  if (ok) {
    showToast('Test alert sent to Discord! ✅', 'up', '🎉');
    errEl.style.color = 'var(--up)';
    errEl.textContent = '✅ Test message delivered successfully.';
    setTimeout(() => { errEl.textContent = ''; errEl.style.color = ''; }, 4000);
  } else {
    errEl.style.color = '';
    errEl.textContent = '❌ Failed to send. Check the webhook URL.';
  }
}
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
window.removeSite    = removeSite;
window.openLogPanel  = openLogPanel;
window.openSiteUrl   = openSiteUrl;
window.openEditModal = openEditModal;
