/* =============================================
   UPTRACKER — Core Engine v4
   Realtime website downtime monitor
   Storage: GitHub Gist (persistent JSON, server-side)
   Fallback: localStorage (if Gist not configured)
   ============================================= */

'use strict';

// ── CONSTANTS ────────────────────────────────
const LS_KEY          = 'uptracker_local_v4';
const DEFAULT_TIMEOUT = 10000;
const SPARK_HISTORY   = 20;
const MAX_INCIDENTS   = 5000;  // per site, ~1 year at 10/day
const MAX_CHECKS      = 2000;  // per site sparkline + stats
const PROXY_URLS = [
  'https://api.allorigins.win/get?url=',
  'https://corsproxy.io/?',
  'https://cors-anywhere.herokuapp.com/',
];

// ── STATE ─────────────────────────────────────
let sites         = [];
let incidents     = {};   // { siteId: [{ts,status,ms,code,event}] }
let checks        = {};   // { siteId: [{ts,status,ms}] } last N checks
let timers        = {};
let countdown     = 30;
let countdownTimer;
let useGist       = false;
let gistSaveTimer = null; // debounce writes

// ── GIST STORAGE LAYER ────────────────────────
const GIST_API = 'https://api.github.com/gists/';

function gistHeaders() {
  const { GITHUB_TOKEN } = window.UPTRACKER_CONFIG || {};
  return {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Content-Type':  'application/json',
    'Accept':        'application/vnd.github.v3+json',
  };
}

async function gistLoad() {
  const { GIST_ID, GIST_FILE } = window.UPTRACKER_CONFIG || {};
  try {
    const res  = await fetch(GIST_API + GIST_ID, { headers: gistHeaders(), cache: 'no-store' });
    if (!res.ok) throw new Error(`Gist load failed: ${res.status}`);
    const data = await res.json();
    const raw  = data.files?.[GIST_FILE]?.content;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(e) {
    console.warn('Gist load error:', e.message);
    return null;
  }
}

// Debounced save — batches rapid writes into one API call per 3s
function gistSave(immediate = false) {
  if (!useGist) { lsSave(); return; }
  if (gistSaveTimer) clearTimeout(gistSaveTimer);
  const delay = immediate ? 0 : 3000;
  gistSaveTimer = setTimeout(() => _doGistSave(), delay);
}

async function _doGistSave() {
  const { GIST_ID, GIST_FILE } = window.UPTRACKER_CONFIG || {};
  const payload = buildGistPayload();
  try {
    const res = await fetch(GIST_API + GIST_ID, {
      method:  'PATCH',
      headers: gistHeaders(),
      body: JSON.stringify({
        files: { [GIST_FILE]: { content: JSON.stringify(payload, null, 2) } },
      }),
    });
    if (!res.ok) throw new Error(`Gist save failed: ${res.status}`);
  } catch(e) {
    console.warn('Gist save error:', e.message);
  }
  lsSave(); // always mirror to localStorage
}

function buildGistPayload() {
  // Trim to keep Gist size manageable
  const trimmedIncidents = {};
  const trimmedChecks    = {};
  for (const id in incidents) {
    trimmedIncidents[id] = (incidents[id] || []).slice(-MAX_INCIDENTS);
  }
  for (const id in checks) {
    trimmedChecks[id] = (checks[id] || []).slice(-MAX_CHECKS);
  }
  return {
    version:   4,
    savedAt:   new Date().toISOString(),
    sites:     sites.map(siteToJSON),
    incidents: trimmedIncidents,
    checks:    trimmedChecks,
  };
}

function siteToJSON(s) {
  return {
    id:         s.id,
    name:       s.name,
    url:        s.url,
    interval:   s.interval,
    webhookUrl: s.webhookUrl || '',
    alertMode:  s.alertMode  || 'offline',
    addedAt:    s.addedAt,
  };
}

// ── LOCALSTORAGE MIRROR ───────────────────────
function lsSave() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(buildGistPayload()));
  } catch(e) {}
}

function lsLoad() {
  try {
    const raw = localStorage.getItem(LS_KEY)
             || localStorage.getItem('uptracker_local_v3') // migrate
             || localStorage.getItem('uptracker_sites_v2'); // migrate older
    if (!raw) return null;
    const d = JSON.parse(raw);
    // Handle old format (array of sites directly)
    if (Array.isArray(d)) return { sites: d, incidents: {}, checks: {}, version: 1 };
    return d;
  } catch(e) { return null; }
}

// ── HYDRATE STATE FROM PAYLOAD ────────────────
function hydrateFromPayload(payload) {
  if (!payload) return;

  const rawSites = payload.sites || [];
  sites = rawSites.map(s => ({
    ...s,
    // runtime state — will be populated on first check
    status:     'checking',
    statusCode: null,
    responseMs: null,
    uptimePct:  null,
    lastCheck:  null,
    history:    [],
  }));

  incidents = payload.incidents || {};
  checks    = payload.checks    || {};

  // Rebuild in-memory sparkline history from stored checks
  sites.forEach(site => {
    const siteChecks = (checks[site.id] || []);
    site.history     = siteChecks.slice(-SPARK_HISTORY);
    site.uptimePct   = calcUptimePct(site.history);

    // Migrate: if no webhookUrl/alertMode
    if (!('webhookUrl' in site)) site.webhookUrl = '';
    if (!('alertMode'  in site)) site.alertMode  = 'offline';

    // Restore last known status from last incident
    const lastInc = (incidents[site.id] || []).at(-1);
    if (lastInc) {
      site.status    = lastInc.status;
      site.lastCheck = lastInc.ts;
    }
  });

  // Always apply ROI webhook
  applyRoiWebhook();
}

function applyRoiWebhook() {
  const roi = sites.find(s => s.url && s.url.includes('roiprofitacademy.in'));
  if (roi && !roi.webhookUrl) {
    roi.webhookUrl = 'https://discord.com/api/webhooks/1465360998411272344/pFe4scsMHqiJNv6WqMmkzIJfrBYxrdr0UkNcKn5i1yqT1Q3cFiOEKI3NAGUzpaZUBXur';
    roi.alertMode  = 'both';
  }
}

// ── INIT ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const cfg = window.UPTRACKER_CONFIG || {};
  useGist   = !!(cfg.GITHUB_TOKEN && cfg.GIST_ID
              && cfg.GITHUB_TOKEN !== 'YOUR_GITHUB_TOKEN');

  showLoadingState(true);

  let payload = null;
  if (useGist) {
    payload = await gistLoad();
    if (!payload) {
      // Gist empty/new — try migrate from localStorage
      payload = lsLoad();
    }
  } else {
    payload = lsLoad();
  }

  hydrateFromPayload(payload);
  renderAll();
  bindEvents();
  startGlobalCountdown();
  showLoadingState(false);
  updateStorageIndicator();

  if (sites.length === 0) {
    await addSite(
      'ROI Profit Academy',
      'https://roiprofitacademy.in',
      30,
      'https://discord.com/api/webhooks/1465360998411272344/pFe4scsMHqiJNv6WqMmkzIJfrBYxrdr0UkNcKn5i1yqT1Q3cFiOEKI3NAGUzpaZUBXur',
      'both'
    );
  } else {
    sites.forEach(s => { scheduleChecks(s); checkSite(s); });
  }
});

function showLoadingState(on) {
  const grid = document.getElementById('sitesGrid');
  if (!grid) return;
  if (on) {
    grid.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <span>${useGist ? 'Loading from GitHub Gist…' : 'Loading…'}</span>
      </div>`;
  }
}

function updateStorageIndicator() {
  const el = document.getElementById('storageIndicator');
  if (!el) return;
  if (useGist) {
    el.textContent = '☁ Cloud';
    el.className   = 'storage-indicator cloud';
    el.title       = 'Data stored in GitHub Gist — persistent across devices';
    // Hide setup banner
    const b = document.getElementById('setupBanner');
    if (b) b.style.display = 'none';
  } else {
    el.textContent = '⚡ Local';
    el.className   = 'storage-indicator local';
    el.title       = 'Data in browser localStorage only — clears with cache. Add config.js to enable cloud.';
  }
}

// ── SITE MANAGEMENT ──────────────────────────
async function addSite(name, url, interval = 30, webhookUrl = '', alertMode = 'offline') {
  const id   = 'site_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const site = {
    id,
    name:       name.trim(),
    url:        normalizeUrl(url.trim()),
    interval,
    status:     'checking',
    statusCode: null,
    responseMs: null,
    uptimePct:  null,
    lastCheck:  null,
    addedAt:    Date.now(),
    history:    [],
    webhookUrl: webhookUrl || '',
    alertMode:  alertMode  || 'offline',
  };
  sites.push(site);
  incidents[id] = [];
  checks[id]    = [];
  gistSave();
  renderAll();
  scheduleChecks(site);
  checkSite(site);
  return site;
}

async function updateSite(id, changes) {
  const site = sites.find(s => s.id === id);
  if (!site) return;
  Object.assign(site, changes);
  gistSave();
  scheduleChecks(site);
  updateCardStatus(site);
}

async function removeSite(id) {
  if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
  sites     = sites.filter(s => s.id !== id);
  delete incidents[id];
  delete checks[id];
  gistSave(true);
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

async function checkSite(site) {
  const start = performance.now();
  site.status = 'checking';
  updateCardStatus(site);

  let success = false, ms = null, code = null;

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
    try {
      await fetch(site.url, { method: 'HEAD', mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(tid);
      ms = Math.round(performance.now() - start);
      success = true; code = 200;
    } catch(fe) {
      clearTimeout(tid);
      if (fe.name === 'AbortError') {
        success = false; ms = DEFAULT_TIMEOUT;
      } else {
        const r = await checkViaProxy(site.url, start);
        success = r.success; ms = r.ms; code = r.code;
      }
    }
  } catch(e) {
    success = false; ms = Math.round(performance.now() - start);
  }

  const newStatus = success ? 'up' : 'down';
  site.status     = newStatus;
  site.responseMs = ms;
  site.statusCode = code;
  site.lastCheck  = Date.now();

  // Store check
  if (!checks[site.id]) checks[site.id] = [];
  checks[site.id].push({ ts: Date.now(), status: newStatus, ms });
  if (checks[site.id].length > MAX_CHECKS) checks[site.id].shift();

  // Rebuild sparkline from stored checks
  site.history   = checks[site.id].slice(-SPARK_HISTORY);
  site.uptimePct = calcUptimePct(site.history);

  // Incident detection
  const prevInc = (incidents[site.id] || []).at(-1);
  const prevStatus = prevInc?.status;

  if (prevStatus !== newStatus) {
    const event = newStatus === 'up' ? '✅ Site came back online' : '🔴 Site went down';
    const entry = { ts: Date.now(), status: newStatus, ms, code, event };

    if (!incidents[site.id]) incidents[site.id] = [];
    incidents[site.id].push(entry);
    if (incidents[site.id].length > MAX_INCIDENTS) incidents[site.id].shift();

    // Toast
    if (newStatus === 'down') showToast(`${site.name} is DOWN!`, 'down', '🔴');
    else if (prevStatus === 'down') showToast(`${site.name} is back online`, 'up', '✅');

    // Discord
    if (site.webhookUrl) {
      const send = site.alertMode === 'both' ||
        (site.alertMode === 'offline' && newStatus === 'down');
      if (send) sendDiscordAlert(site, newStatus, ms, code);
    }
  }

  gistSave(); // debounced — batches many checks into one write
  updateCardStatus(site);
  updateSummaryBar();
}

async function checkViaProxy(url, start) {
  for (const proxy of PROXY_URLS) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(proxy + encodeURIComponent(url), { signal: ctrl.signal, cache: 'no-store' });
      if (res.ok) return { success: true, ms: Math.round(performance.now() - start), code: 200 };
    } catch(e) {}
  }
  return { success: false, ms: Math.round(performance.now() - start), code: null };
}

function calcUptimePct(history) {
  if (!history || history.length === 0) return null;
  const up = history.filter(h => h.status === 'up').length;
  return Math.round((up / history.length) * 1000) / 10;
}

async function checkAllSites() {
  const btn  = document.getElementById('checkNowBtn');
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
  const uptime        = site.uptimePct !== null ? site.uptimePct.toFixed(1) + '%' : '—';
  const response      = site.responseMs !== null ? site.responseMs + 'ms' : '—';
  const responseClass = getResponseClass(site.responseMs);
  const uptimeClass   = getUptimeClass(site.uptimePct);
  const uptimeFill    = site.uptimePct !== null ? site.uptimePct : 0;
  const fillClass     = uptimeFill < 70 ? 'low' : uptimeFill < 90 ? 'warn' : '';
  const sparkBars     = buildSparkBars(site.history);
  const domain        = getDomain(site.url);
  const statusLabel   = site.status === 'up' ? 'Online' : site.status === 'down' ? 'Offline' : 'Checking…';
  const sinceTxt      = site.lastCheck ? 'since ' + formatRelativeTime(site.lastCheck) : '';
  const checksTxt     = site.history.length
    ? `${site.history.filter(h => h.status === 'up').length}/${site.history.length} checks`
    : 'No checks yet';
  const storageBadge  = useGist
    ? `<span class="storage-badge sb" title="Stored in GitHub Gist">☁ Cloud</span>`
    : `<span class="storage-badge local" title="Browser only — configure Gist for persistence">⚡ Local</span>`;
  const totalChecks   = (checks[site.id] || []).length;
  const totalInc      = (incidents[site.id] || []).filter(i => i.status === 'down').length;

  return `
    <div class="site-card status-${site.status}" id="card-${site.id}" data-id="${site.id}">
      <div class="card-header">
        <div class="card-identity">
          <div class="site-favicon">
            <img src="${getFaviconUrl(site.url)}" alt=""
              onerror="this.style.display='none';this.nextElementSibling.style.display='block'"/>
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
        <div class="status-dot ${site.status}"></div>
        <span class="status-text ${site.status}">${statusLabel}</span>
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
          <div class="metric-sub">${totalChecks} total checks</div>
        </div>
      </div>

      <div class="uptime-section">
        <div class="uptime-header">
          <span>Uptime (last ${site.history.length || SPARK_HISTORY} checks)</span>
          <span class="uptime-pct ${uptimeClass}">${uptime}</span>
        </div>
        <div class="uptime-bar-track">
          <div class="uptime-bar-fill ${fillClass}" style="width:${uptimeFill}%"></div>
        </div>
      </div>

      <div class="sparkline-section">
        <div class="sparkline-label">Response History</div>
        <div class="sparkline-wrap" id="spark-${site.id}">${sparkBars}</div>
      </div>

      <div class="card-footer">
        <div class="footer-meta">
          ${storageBadge}
          ${checksTxt} · <span>Every ${site.interval}s</span>
          ${totalInc > 0 ? `· <span class="incident-count">${totalInc} outage${totalInc>1?'s':''}</span>` : ''}
        </div>
        <div class="footer-right">
          ${site.webhookUrl ? `<span class="discord-badge" title="Discord: ${site.alertMode === 'both' ? 'Online &amp; Offline' : 'Offline only'}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
            ${site.alertMode === 'both' ? 'Online &amp; Offline' : 'Offline only'}
          </span>` : ''}
          <button class="view-log-btn" onclick="openLogPanel('${site.id}')">
            <svg viewBox="0 0 20 20" fill="none"><path d="M3 5h14M3 10h14M3 15h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            History
          </button>
        </div>
      </div>
    </div>`;
}

function buildSparkBars(history) {
  if (!history || history.length === 0) {
    return Array(SPARK_HISTORY).fill(0).map(() =>
      `<div class="spark-bar empty" style="height:20%" data-tip="No data"></div>`).join('');
  }
  const padded = [...Array(Math.max(0, SPARK_HISTORY - history.length)).fill(null), ...history];
  const maxMs  = Math.max(...history.filter(h => h.ms).map(h => h.ms), 1000);
  return padded.map(h => {
    if (!h) return `<div class="spark-bar empty" style="height:20%" data-tip="No data"></div>`;
    if (h.status === 'down') return `<div class="spark-bar down-bar" style="height:100%" data-tip="DOWN"></div>`;
    const pct = Math.max(10, Math.min(100, Math.round((h.ms / maxMs) * 100)));
    const cls = h.ms < 500 ? 'ok' : h.ms < 1500 ? 'slow' : 'down-bar';
    return `<div class="spark-bar ${cls}" style="height:${pct}%" data-tip="${escAttr(h.ms + 'ms · ' + formatTime(h.ts))}"></div>`;
  }).join('');
}

// ── TARGETED DOM UPDATE ───────────────────────
function updateCardStatus(site) {
  const card = document.getElementById('card-' + site.id);
  if (!card) { renderAll(); return; }

  card.className = `site-card status-${site.status}`;

  const dot   = card.querySelector('.status-dot');
  const txt   = card.querySelector('.status-text');
  const since = card.querySelector('.status-since');
  if (dot)   dot.className  = `status-dot ${site.status}`;
  if (txt) { txt.className  = `status-text ${site.status}`;
             txt.textContent = site.status === 'up' ? 'Online' : site.status === 'down' ? 'Offline' : 'Checking…'; }
  if (since && site.lastCheck) since.textContent = 'since ' + formatRelativeTime(site.lastCheck);

  const mv = card.querySelectorAll('.metric-value');
  if (mv[0]) { mv[0].textContent = site.responseMs !== null ? site.responseMs + 'ms' : '—'; mv[0].className = `metric-value ${getResponseClass(site.responseMs)}`; }
  if (mv[1]) { mv[1].textContent = site.uptimePct  !== null ? site.uptimePct.toFixed(1) + '%' : '—'; mv[1].className = `metric-value ${getUptimeClass(site.uptimePct)}`; }

  const mv1sub = card.querySelectorAll('.metric-sub');
  if (mv1sub[1]) mv1sub[1].textContent = `${(checks[site.id]||[]).length} total checks`;

  const fill = card.querySelector('.uptime-bar-fill');
  if (fill) {
    fill.style.width = (site.uptimePct || 0) + '%';
    const p = site.uptimePct || 0;
    fill.className = 'uptime-bar-fill' + (p < 70 ? ' low' : p < 90 ? ' warn' : '');
  }
  const uptimePctEl = card.querySelector('.uptime-pct');
  if (uptimePctEl) { uptimePctEl.textContent = site.uptimePct !== null ? site.uptimePct.toFixed(1) + '%' : '—'; uptimePctEl.className = `uptime-pct ${getUptimeClass(site.uptimePct)}`; }

  const spark = document.getElementById('spark-' + site.id);
  if (spark) spark.innerHTML = buildSparkBars(site.history);

  const footer = card.querySelector('.footer-meta');
  if (footer) {
    const ct  = site.history.length ? `${site.history.filter(h=>h.status==='up').length}/${site.history.length} checks` : 'No checks yet';
    const tot = (checks[site.id]||[]).length;
    const inc = (incidents[site.id]||[]).filter(i=>i.status==='down').length;
    const badge = useGist ? `<span class="storage-badge sb">☁ Cloud</span>` : `<span class="storage-badge local">⚡ Local</span>`;
    footer.innerHTML = `${badge} ${ct} · <span>Every ${site.interval}s</span>${inc>0?` · <span class="incident-count">${inc} outage${inc>1?'s':''}</span>`:''}`;
  }
}

function updateSummaryBar() {
  document.getElementById('totalSites').textContent  = sites.length;
  document.getElementById('sitesUp').textContent     = sites.filter(s => s.status === 'up').length;
  document.getElementById('sitesDown').textContent   = sites.filter(s => s.status === 'down').length;
  const wu = sites.filter(s => s.uptimePct !== null);
  const wr = sites.filter(s => s.responseMs !== null && s.status === 'up');
  document.getElementById('avgUptime').textContent   = wu.length ? (wu.reduce((a,s)=>a+s.uptimePct,0)/wu.length).toFixed(1)+'%' : '—';
  document.getElementById('avgResponse').textContent = wr.length ? Math.round(wr.reduce((a,s)=>a+s.responseMs,0)/wr.length)+'ms' : '—';
}

// ── COUNTDOWN ────────────────────────────────
function startGlobalCountdown() {
  const iv = sites.length > 0 ? Math.min(...sites.map(s => s.interval)) : 30;
  countdown = iv;
  updateCountdownDisplay();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      countdown = iv;
      document.getElementById('lastCheckedTime').textContent = formatTime(Date.now());
    }
    updateCountdownDisplay();
  }, 1000);
}

function resetCountdown() {
  countdown = sites.length > 0 ? Math.min(...sites.map(s => s.interval)) : 30;
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

  const panel = document.getElementById('logPanel');
  panel.dataset.siteId = siteId;
  document.getElementById('logSiteName').textContent = site.name;

  const filterEl = document.getElementById('logDateFilter');
  if (filterEl && !filterEl.dataset.set) { filterEl.value = '30'; filterEl.dataset.set = '1'; }

  panel.classList.add('open');
  document.getElementById('logOverlay').classList.add('active');
  renderLogContent(siteId);
}

function renderLogContent(siteId) {
  const content  = document.getElementById('logContent');
  const filterEl = document.getElementById('logDateFilter');
  const days     = filterEl ? parseInt(filterEl.value) : 30;
  const fromTs   = days === 0 ? 0 : Date.now() - days * 86400000;

  const all     = (incidents[siteId] || []).slice().reverse();
  const entries = days === 0 ? all : all.filter(e => e.ts >= fromTs);

  if (entries.length === 0) {
    const mode = useGist ? '☁ Stored in GitHub Gist' : '⚡ Local storage only';
    content.innerHTML = `
      <div class="log-empty">
        <svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="28" stroke="currentColor" stroke-width="2"/><path d="M22 32h20M32 22v20" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/></svg>
        <p>No incidents in this period.<br/><small>${mode}</small></p>
      </div>`;
    return;
  }

  // Group by date
  const grouped = {};
  entries.forEach(e => {
    const day = new Date(e.ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    if (!grouped[day]) grouped[day] = [];
    grouped[day].push(e);
  });

  content.innerHTML = Object.entries(grouped).map(([day, dayEntries]) => `
    <div class="log-date-group">
      <div class="log-date-label">${day}</div>
      ${dayEntries.map(entry => `
        <div class="log-entry">
          <div class="log-dot ${entry.status}"></div>
          <div class="log-body">
            <div class="log-event ${entry.status}">${escHtml(entry.event)}</div>
            <div class="log-time">${formatFullTime(entry.ts)}</div>
            ${entry.ms !== null ? `<div class="log-response">Response: ${entry.ms}ms${entry.code ? ' · HTTP ' + entry.code : ''}</div>` : ''}
          </div>
        </div>`).join('')}
    </div>`).join('');
}

function closeLogPanel() {
  document.getElementById('logPanel').classList.remove('open');
  document.getElementById('logOverlay').classList.remove('active');
}

// ── ADD MODAL ────────────────────────────────
function openAddModal() {
  document.getElementById('modalOverlay').classList.add('active');
  ['siteName','siteUrl'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('checkInterval').value = '30';
  document.getElementById('modalError').textContent = '';
  setTimeout(() => document.getElementById('siteName').focus(), 100);
}

function closeAddModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

async function handleAddSite() {
  const name     = document.getElementById('siteName').value.trim();
  const url      = document.getElementById('siteUrl').value.trim();
  const interval = parseInt(document.getElementById('checkInterval').value);
  const errEl    = document.getElementById('modalError');

  if (!name) { errEl.textContent = 'Please enter a site name.'; return; }
  if (!url)  { errEl.textContent = 'Please enter a URL.'; return; }
  const normalized = normalizeUrl(url);
  if (!isValidUrl(normalized)) { errEl.textContent = 'Please enter a valid URL.'; return; }
  if (sites.find(s => s.url === normalized)) { errEl.textContent = 'Already monitoring this site.'; return; }

  const btn = document.getElementById('modalAddBtn');
  btn.disabled = true; btn.textContent = 'Adding…';
  closeAddModal();
  await addSite(name, normalized, interval);
  btn.disabled = false; btn.textContent = 'Add & Monitor';
  showToast(`Added ${name}`, 'info', '✅');
}

// ── EDIT MODAL ───────────────────────────────
function openEditModal(siteId) {
  const site = sites.find(s => s.id === siteId);
  if (!site) return;
  document.getElementById('editSiteId').value         = site.id;
  document.getElementById('editSiteName').value       = site.name;
  document.getElementById('editSiteUrl').value        = site.url;
  document.getElementById('editCheckInterval').value  = String(site.interval);
  document.getElementById('editWebhookUrl').value     = site.webhookUrl || '';
  document.getElementById('editModalError').textContent = '';
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
  if (!isValidUrl(normalizeUrl(url))) { errEl.textContent = 'Please enter a valid URL.'; return; }
  if (webhook && !webhook.includes('discord.com/api/webhooks/')) { errEl.textContent = 'Must be a Discord webhook URL.'; return; }

  const btn = document.getElementById('editModalSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  await updateSite(id, { name, url: normalizeUrl(url), interval, webhookUrl: webhook, alertMode });
  btn.disabled = false; btn.textContent = 'Save Changes';
  closeEditModal();
  showToast(`${name} updated`, 'info', '✏️');
  renderAll();
}

async function handleTestWebhook() {
  const webhook  = document.getElementById('editWebhookUrl').value.trim();
  const siteName = document.getElementById('editSiteName').value.trim();
  const btn      = document.getElementById('testWebhookBtn');
  const errEl    = document.getElementById('editModalError');

  if (!webhook) { errEl.textContent = 'Enter a webhook URL first.'; return; }
  if (!webhook.includes('discord.com/api/webhooks/')) { errEl.textContent = 'Must be a Discord webhook URL.'; return; }

  btn.disabled = true; btn.textContent = 'Sending…'; errEl.textContent = '';
  const ok = await sendTestDiscordAlert(webhook, siteName || 'Test Site');
  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 2l2.4 5.4 5.6.8-4 4 1 5.8-5-2.8L5 18l1-5.8-4-4 5.6-.8L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg> Send Test Alert`;

  if (ok) {
    showToast('Test alert sent! ✅', 'up', '🎉');
    errEl.style.color = 'var(--up)'; errEl.textContent = '✅ Delivered successfully.';
    setTimeout(() => { errEl.textContent = ''; errEl.style.color = ''; }, 4000);
  } else {
    errEl.style.color = ''; errEl.textContent = '❌ Failed. Check the webhook URL.';
  }
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
  document.getElementById('editModalClose').addEventListener('click', closeEditModal);
  document.getElementById('editModalCancelBtn').addEventListener('click', closeEditModal);
  document.getElementById('editModalSaveBtn').addEventListener('click', handleSaveEdit);
  document.getElementById('testWebhookBtn').addEventListener('click', handleTestWebhook);
  document.getElementById('modalOverlay').addEventListener('click', e => { if(e.target===e.currentTarget) closeAddModal(); });
  document.getElementById('editModalOverlay').addEventListener('click', e => { if(e.target===e.currentTarget) closeEditModal(); });
  document.getElementById('siteUrl').addEventListener('keydown', e => { if(e.key==='Enter') handleAddSite(); });
  document.getElementById('siteName').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('siteUrl').focus(); });

  const logFilter = document.getElementById('logDateFilter');
  if (logFilter) {
    logFilter.addEventListener('change', () => {
      const siteId = document.getElementById('logPanel').dataset.siteId;
      if (siteId) renderLogContent(siteId);
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAddModal(); closeLogPanel(); closeEditModal(); }
  });
}

// ── DISCORD ───────────────────────────────────
async function sendDiscordAlert(site, status, ms, code) {
  if (!site.webhookUrl) return;
  const isDown = status === 'down';
  const payload = {
    username: 'Uptracker',
    embeds: [{
      title:       isDown ? `🚨 ${site.name} is DOWN` : `✅ ${site.name} is back ONLINE`,
      description: isDown ? `**${site.name}** is unreachable.` : `**${site.name}** has recovered.`,
      color:  isDown ? 0xEF4444 : 0x10B981,
      fields: [
        { name: '🌐 URL',       value: `[${getDomain(site.url)}](${site.url})`, inline: true },
        { name: '📶 Status',    value: isDown ? '`OFFLINE`' : '`ONLINE`', inline: true },
        { name: '⏱ Response',  value: ms !== null ? `\`${ms}ms\`` : '`timeout`', inline: true },
        { name: '📊 Uptime',   value: site.uptimePct !== null ? `\`${site.uptimePct.toFixed(1)}%\`` : '`—`', inline: true },
        { name: '📋 Total',    value: `\`${(checks[site.id]||[]).length} checks · ${(incidents[site.id]||[]).filter(i=>i.status==='down').length} outages\``, inline: true },
        { name: '🕐 Time',     value: `\`${formatFullTime(Date.now())}\``, inline: true },
      ],
      footer:    { text: `Uptracker • Every ${site.interval}s • ${useGist ? '☁ Cloud' : '⚡ Local'}` },
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    await fetch(site.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch(e) { console.warn('Discord webhook failed:', e.message); }
}

async function sendTestDiscordAlert(webhookUrl, siteName) {
  const payload = {
    username: 'Uptracker',
    embeds: [{
      title:       '🧪 Test Alert — Uptracker',
      description: `Webhook working for **${siteName}**! ✅\n\nStorage: **${useGist ? '☁ GitHub Gist (persistent)' : '⚡ localStorage (browser only)'}**`,
      color:  0x3B82F6,
      fields: [
        { name: '📡 Source', value: '`Uptracker Dashboard`', inline: true },
        { name: '🕐 Time',   value: `\`${formatFullTime(Date.now())}\``, inline: true },
      ],
      footer: { text: 'Uptracker • Realtime Website Monitor' },
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.ok || res.status === 204;
  } catch(e) { return false; }
}

// ── TOAST ────────────────────────────────────
function showToast(message, type = 'info', icon = 'ℹ️') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 300); }, 4000);
}

// ── HELPERS ──────────────────────────────────
function openSiteUrl(url)  { window.open(url, '_blank', 'noopener'); }
function getFaviconUrl(url){ try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`; } catch { return ''; } }
function getDomain(url)    { try { return new URL(url).hostname.replace('www.',''); } catch { return url; } }
function getInitial(name)  { return name.charAt(0).toUpperCase(); }
function getResponseClass(ms) { if(ms===null)return'dim'; if(ms<500)return'good'; if(ms<1500)return'warn'; return'bad'; }
function getUptimeClass(pct)  { if(pct===null)return'dim'; if(pct>=99)return'good'; if(pct>=90)return'warn'; return'bad'; }
function isValidUrl(url)   { try { new URL(url); return true; } catch { return false; } }
function escHtml(str)      { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(str)      { return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function formatTime(ts)    { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function formatFullTime(ts){ return new Date(ts).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function formatRelativeTime(ts) {
  const d = Date.now()-ts;
  if(d<60000)    return 'just now';
  if(d<3600000)  return Math.floor(d/60000)+'m ago';
  if(d<86400000) return Math.floor(d/3600000)+'h ago';
  return Math.floor(d/86400000)+'d ago';
}

// ── EXPOSE ───────────────────────────────────
window.removeSite    = removeSite;
window.openLogPanel  = openLogPanel;
window.openSiteUrl   = openSiteUrl;
window.openEditModal = openEditModal;
