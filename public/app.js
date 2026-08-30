/* =============================================
   UPTRACKER — Core Engine v3
   Realtime website downtime monitor
   Backend: Supabase (persistent, 1-year history)
   Fallback: localStorage (offline / unconfigured)
   ============================================= */

'use strict';

// ── CONSTANTS ───────────────────────────────
const STORAGE_KEY     = 'uptracker_sites_v3';
const DEFAULT_TIMEOUT = 10000;
const SPARK_HISTORY   = 20;
const PROXY_URLS = [
  'https://api.allorigins.win/get?url=',
  'https://corsproxy.io/?',
  'https://cors-anywhere.herokuapp.com/',
];

// ── STATE ────────────────────────────────────
let sites         = [];
let timers        = {};
let countdown     = 30;
let countdownTimer;
let sb            = null;   // Supabase client
let useSupabase   = false;

// ── SUPABASE INIT ─────────────────────────────
function initSupabase() {
  const cfg = window.UPTRACKER_CONFIG || {};
  const url = cfg.SUPABASE_URL;
  const key = cfg.SUPABASE_ANON_KEY;

  if (!url || !key || url === 'YOUR_SUPABASE_URL' || key === 'YOUR_SUPABASE_ANON_KEY') {
    console.info('Uptracker: Supabase not configured — using localStorage fallback');
    useSupabase = false;
    return;
  }

  try {
    sb = window.supabase.createClient(url, key);
    useSupabase = true;
    console.info('Uptracker: Supabase connected ✅');
  } catch(e) {
    console.warn('Uptracker: Supabase init failed, using localStorage', e);
    useSupabase = false;
  }
}

// ── INIT ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initSupabase();
  showLoadingState(true);

  if (useSupabase) {
    await loadSitesFromDB();
  } else {
    loadSitesFromStorage();
  }

  renderAll();
  bindEvents();
  startGlobalCountdown();
  showLoadingState(false);

  // Seed ROI Profit Academy if no sites exist
  if (sites.length === 0) {
    await addSite(
      'ROI Profit Academy',
      'https://roiprofitacademy.in',
      30,
      'https://discord.com/api/webhooks/1465360998411272344/pFe4scsMHqiJNv6WqMmkzIJfrBYxrdr0UkNcKn5i1yqT1Q3cFiOEKI3NAGUzpaZUBXur',
      'both'
    );
  } else {
    // Start monitoring all loaded sites
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
        <span>Loading sites…</span>
      </div>`;
  }
}

// ── SUPABASE DB LAYER ─────────────────────────

async function loadSitesFromDB() {
  try {
    const { data, error } = await sb.from('sites').select('*').order('added_at', { ascending: true });
    if (error) throw error;
    sites = (data || []).map(dbRowToSite);
    // Migrate webhook config for ROI if missing
    migrateRoiWebhook();
  } catch(e) {
    console.warn('DB load failed, falling back to localStorage', e);
    loadSitesFromStorage();
  }
}

async function dbSaveSite(site) {
  if (!useSupabase) { saveToStorage(); return; }
  try {
    await sb.from('sites').upsert({
      id:          site.id,
      name:        site.name,
      url:         site.url,
      interval:    site.interval,
      webhook_url: site.webhookUrl || '',
      alert_mode:  site.alertMode  || 'offline',
      updated_at:  new Date().toISOString(),
    });
  } catch(e) {
    console.warn('DB save site failed', e);
  }
  saveToStorage(); // always mirror to localStorage as backup
}

async function dbDeleteSite(siteId) {
  if (!useSupabase) { saveToStorage(); return; }
  try {
    await sb.from('sites').delete().eq('id', siteId);
  } catch(e) {
    console.warn('DB delete site failed', e);
  }
  saveToStorage();
}

async function dbSaveCheck(site, status, ms, code) {
  if (!useSupabase) return;
  try {
    await sb.from('checks').insert({
      site_id:     site.id,
      status:      status,
      response_ms: ms,
      status_code: code,
      checked_at:  new Date().toISOString(),
    });
  } catch(e) {
    // Silent — checks are high-frequency, don't spam errors
  }
}

async function dbSaveIncident(site, status, ms, code, event) {
  if (!useSupabase) return;
  try {
    await sb.from('incidents').insert({
      site_id:     site.id,
      status:      status,
      response_ms: ms,
      status_code: code,
      event:       event,
      occurred_at: new Date().toISOString(),
    });
  } catch(e) {
    console.warn('DB save incident failed', e);
  }
}

async function dbLoadIncidents(siteId, fromDate = null) {
  if (!useSupabase) {
    // Return from localStorage incidents
    const stored = JSON.parse(localStorage.getItem('uptracker_incidents_v3') || '{}');
    return (stored[siteId] || []).filter(e => !fromDate || e.ts >= fromDate);
  }
  try {
    let query = sb
      .from('incidents')
      .select('*')
      .eq('site_id', siteId)
      .order('occurred_at', { ascending: false });

    if (fromDate) {
      query = query.gte('occurred_at', new Date(fromDate).toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(r => ({
      ts:     new Date(r.occurred_at).getTime(),
      status: r.status,
      ms:     r.response_ms,
      code:   r.status_code,
      event:  r.event,
    }));
  } catch(e) {
    console.warn('DB load incidents failed', e);
    return [];
  }
}

async function dbLoadChecksForSparkline(siteId) {
  if (!useSupabase) return null;
  try {
    const { data, error } = await sb
      .from('checks')
      .select('status, response_ms, checked_at')
      .eq('site_id', siteId)
      .order('checked_at', { ascending: false })
      .limit(SPARK_HISTORY);
    if (error) throw error;
    return (data || []).reverse().map(r => ({
      status: r.status,
      ms:     r.response_ms,
      ts:     new Date(r.checked_at).getTime(),
    }));
  } catch(e) {
    return null;
  }
}

async function dbLoadUptimeStats(siteId, days = 30) {
  if (!useSupabase) return null;
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await sb
      .from('checks')
      .select('status')
      .eq('site_id', siteId)
      .gte('checked_at', since);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const up = data.filter(r => r.status === 'up').length;
    return Math.round((up / data.length) * 1000) / 10;
  } catch(e) {
    return null;
  }
}

function dbRowToSite(row) {
  return {
    id:         row.id,
    name:       row.name,
    url:        row.url,
    interval:   row.interval || 30,
    webhookUrl: row.webhook_url || '',
    alertMode:  row.alert_mode  || 'offline',
    addedAt:    new Date(row.added_at).getTime(),
    // runtime state (populated on first check)
    status:     'checking',
    statusCode: null,
    responseMs: null,
    uptimePct:  null,
    lastCheck:  null,
    history:    [],
  };
}

// ── LOCALSTORAGE FALLBACK ─────────────────────
function loadSitesFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    const old = localStorage.getItem('uptracker_sites_v2'); // migrate from v2
    const raw = s || old;
    sites = raw ? JSON.parse(raw) : [];
    sites.forEach(site => {
      if (!('webhookUrl' in site)) site.webhookUrl = '';
      if (!('alertMode'  in site)) site.alertMode  = 'offline';
      if (!('history'    in site)) site.history     = [];
    });
    migrateRoiWebhook();
  } catch(e) {
    sites = [];
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sites));
  } catch(e) {}
}

function saveIncidentToStorage(siteId, entry) {
  try {
    const key = 'uptracker_incidents_v3';
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    if (!all[siteId]) all[siteId] = [];
    all[siteId].push(entry);
    // Keep last 500 per site
    if (all[siteId].length > 500) all[siteId] = all[siteId].slice(-500);
    localStorage.setItem(key, JSON.stringify(all));
  } catch(e) {}
}

function migrateRoiWebhook() {
  const roi = sites.find(s => s.url && s.url.includes('roiprofitacademy.in'));
  if (roi && !roi.webhookUrl) {
    roi.webhookUrl = 'https://discord.com/api/webhooks/1465360998411272344/pFe4scsMHqiJNv6WqMmkzIJfrBYxrdr0UkNcKn5i1yqT1Q3cFiOEKI3NAGUzpaZUBXur';
    roi.alertMode  = 'both';
  }
}

// ── SITE MANAGEMENT ──────────────────────────
async function addSite(name, url, interval = 30, webhookUrl = '', alertMode = 'offline') {
  const id = 'site_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
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
  await dbSaveSite(site);
  renderAll();
  scheduleChecks(site);
  checkSite(site);
  return site;
}

async function updateSite(id, changes) {
  const site = sites.find(s => s.id === id);
  if (!site) return;
  Object.assign(site, changes);
  await dbSaveSite(site);
  scheduleChecks(site);
  updateCardStatus(site);
}

async function removeSite(id) {
  if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
  sites = sites.filter(s => s.id !== id);
  await dbDeleteSite(id);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    try {
      await fetch(site.url, {
        method: 'HEAD', mode: 'no-cors',
        signal: controller.signal, cache: 'no-store',
      });
      clearTimeout(timeout);
      ms = Math.round(performance.now() - start);
      success = true; code = 200;
    } catch(fetchErr) {
      clearTimeout(timeout);
      if (fetchErr.name === 'AbortError') {
        success = false; ms = DEFAULT_TIMEOUT;
      } else {
        const r = await checkViaProxy(site.url, start);
        success = r.success; ms = r.ms; code = r.code;
      }
    }
  } catch(e) {
    success = false; ms = Math.round(performance.now() - start);
  }

  const prevStatus = site.status;
  site.status      = success ? 'up' : 'down';
  site.responseMs  = ms;
  site.statusCode  = code;
  site.lastCheck   = Date.now();

  // Push to in-memory sparkline history
  site.history.push({ status: site.status, ms, ts: Date.now() });
  if (site.history.length > SPARK_HISTORY) site.history.shift();
  site.uptimePct = calcUptimePct(site.history);

  // Save check to DB
  dbSaveCheck(site, site.status, ms, code);

  // Detect status change → incident
  const prevState = site._lastLoggedStatus;
  if (prevState !== site.status) {
    site._lastLoggedStatus = site.status;
    const event = site.status === 'up' ? '✅ Site came back online' : '🔴 Site went down';
    const entry = { ts: Date.now(), status: site.status, ms, code, event };

    // Save incident
    dbSaveIncident(site, site.status, ms, code, event);
    saveIncidentToStorage(site.id, entry);

    // Toast
    if (site.status === 'down') {
      showToast(`${site.name} is DOWN!`, 'down', '🔴');
    } else if (prevState === 'down') {
      showToast(`${site.name} is back online`, 'up', '✅');
    }

    // Discord
    if (site.webhookUrl) {
      const should = site.alertMode === 'both' ||
        (site.alertMode === 'offline' && site.status === 'down');
      if (should) sendDiscordAlert(site, site.status, ms, code);
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
      setTimeout(() => controller.abort(), 8000);
      const res = await fetch(proxy + encodeURIComponent(url), {
        signal: controller.signal, cache: 'no-store',
      });
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
  const uptimeFillClass = site.uptimePct < 90 ? (site.uptimePct < 70 ? 'low' : 'warn') : '';
  const sparkBars     = buildSparkBars(site.history);
  const faviconUrl    = getFaviconUrl(site.url);
  const domain        = getDomain(site.url);
  const statusLabel   = site.status === 'up' ? 'Online' : site.status === 'down' ? 'Offline' : 'Checking…';
  const sinceTxt      = site.lastCheck ? 'since ' + formatRelativeTime(site.lastCheck) : '';
  const checksTxt     = site.history.length
    ? `${site.history.filter(h=>h.status==='up').length}/${site.history.length} checks`
    : 'No checks yet';
  const storageMode   = useSupabase
    ? `<span class="storage-badge sb">☁ Cloud</span>`
    : `<span class="storage-badge local">⚡ Local</span>`;

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
        <div class="sparkline-wrap" id="spark-${site.id}">${sparkBars}</div>
      </div>

      <div class="card-footer">
        <div class="footer-meta">
          ${storageMode}
          ${checksTxt} · <span>Every ${site.interval}s</span>
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
    </div>
  `;
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
  if (mv[1]) { const u = site.uptimePct !== null ? site.uptimePct.toFixed(1) + '%' : '—'; mv[1].textContent = u; mv[1].className = `metric-value ${getUptimeClass(site.uptimePct)}`; }

  const fill = card.querySelector('.uptime-bar-fill');
  if (fill) { fill.style.width = (site.uptimePct || 0) + '%'; fill.className = 'uptime-bar-fill' + (site.uptimePct < 90 ? (site.uptimePct < 70 ? ' low' : ' warn') : ''); }
  const uptimePctEl = card.querySelector('.uptime-pct');
  if (uptimePctEl) { uptimePctEl.textContent = site.uptimePct !== null ? site.uptimePct.toFixed(1) + '%' : '—'; uptimePctEl.className = `uptime-pct ${getUptimeClass(site.uptimePct)}`; }

  const spark = document.getElementById('spark-' + site.id);
  if (spark) spark.innerHTML = buildSparkBars(site.history);

  const footer = card.querySelector('.footer-meta');
  if (footer) {
    const ct = site.history.length ? `${site.history.filter(h=>h.status==='up').length}/${site.history.length} checks` : 'No checks yet';
    const badge = useSupabase ? `<span class="storage-badge sb">☁ Cloud</span>` : `<span class="storage-badge local">⚡ Local</span>`;
    footer.innerHTML = `${badge} ${ct} · <span>Every ${site.interval}s</span>`;
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

  // Show cloud/local indicator in header
  const ind = document.getElementById('storageIndicator');
  if (ind) {
    ind.textContent  = useSupabase ? '☁ Cloud' : '⚡ Local';
    ind.className    = 'storage-indicator ' + (useSupabase ? 'cloud' : 'local');
    ind.title        = useSupabase ? 'Data stored in Supabase cloud database' : 'Data stored in browser localStorage — configure Supabase for persistence';
  }
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

// ── INCIDENT LOG PANEL (with date filter) ────
async function openLogPanel(siteId) {
  const site = sites.find(s => s.id === siteId);
  if (!site) return;

  const panel   = document.getElementById('logPanel');
  const overlay = document.getElementById('logOverlay');
  document.getElementById('logSiteName').textContent = site.name;

  // Store current siteId for filter changes
  panel.dataset.siteId = siteId;

  // Set date range filter defaults (last 30 days)
  const filterEl = document.getElementById('logDateFilter');
  if (filterEl && !filterEl.value) filterEl.value = '30';

  panel.classList.add('open');
  overlay.classList.add('active');

  await reloadLogContent(siteId);
}

async function reloadLogContent(siteId) {
  const content   = document.getElementById('logContent');
  const filterEl  = document.getElementById('logDateFilter');
  const days      = filterEl ? parseInt(filterEl.value) : 30;
  const fromDate  = days === 0 ? null : Date.now() - days * 86400000;

  content.innerHTML = `<div class="log-loading"><div class="loading-spinner sm"></div><span>Loading history…</span></div>`;

  const entries = await dbLoadIncidents(siteId, fromDate);

  if (entries.length === 0) {
    content.innerHTML = `
      <div class="log-empty">
        <svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="28" stroke="currentColor" stroke-width="2"/><path d="M22 32h20M32 22v20" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/></svg>
        <p>No incidents in this period.<br/>${useSupabase ? 'Supabase cloud storage active.' : 'Configure Supabase for persistent history.'}</p>
      </div>`;
    return;
  }

  content.innerHTML = entries.map(entry => `
    <div class="log-entry">
      <div class="log-dot ${entry.status}"></div>
      <div class="log-body">
        <div class="log-event ${entry.status}">${escHtml(entry.event)}</div>
        <div class="log-time">${formatFullTime(entry.ts)}</div>
        ${entry.ms !== null ? `<div class="log-response">Response: ${entry.ms}ms${entry.code ? ' · HTTP ' + entry.code : ''}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function closeLogPanel() {
  document.getElementById('logPanel').classList.remove('open');
  document.getElementById('logOverlay').classList.remove('active');
}

// ── ADD MODAL ────────────────────────────────
function openAddModal() {
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('siteName').value  = '';
  document.getElementById('siteUrl').value   = '';
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
  const normalized = normalizeUrl(url);
  if (!isValidUrl(normalized)) { errEl.textContent = 'Please enter a valid URL.'; return; }
  if (webhook && !webhook.includes('discord.com/api/webhooks/')) { errEl.textContent = 'Must be a Discord webhook URL.'; return; }

  const btn = document.getElementById('editModalSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  await updateSite(id, { name, url: normalized, interval, webhookUrl: webhook, alertMode });
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
    errEl.style.color = 'var(--up)';
    errEl.textContent = '✅ Test message delivered successfully.';
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

  // Log date filter
  const logFilter = document.getElementById('logDateFilter');
  if (logFilter) {
    logFilter.addEventListener('change', () => {
      const siteId = document.getElementById('logPanel').dataset.siteId;
      if (siteId) reloadLogContent(siteId);
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAddModal(); closeLogPanel(); closeEditModal(); }
  });
}

// ── DISCORD WEBHOOK ──────────────────────────
async function sendDiscordAlert(site, status, ms, code) {
  if (!site.webhookUrl) return;
  const isDown = status === 'down';
  const payload = {
    username: 'Uptracker',
    embeds: [{
      title:       isDown ? `🚨 ${site.name} is DOWN` : `✅ ${site.name} is back ONLINE`,
      description: isDown
        ? `**${site.name}** is unreachable. Immediate attention required.`
        : `**${site.name}** has recovered and is responding normally.`,
      color:  isDown ? 0xEF4444 : 0x10B981,
      fields: [
        { name: '🌐 URL',      value: `[${getDomain(site.url)}](${site.url})`, inline: true },
        { name: '📶 Status',   value: isDown ? '`OFFLINE`' : '`ONLINE`',       inline: true },
        { name: '⏱ Response', value: ms !== null ? `\`${ms}ms\`` : '`timeout`', inline: true },
        { name: '📊 Uptime',  value: site.uptimePct !== null ? `\`${site.uptimePct.toFixed(1)}%\`` : '`—`', inline: true },
        { name: '🕐 Time',    value: `\`${formatFullTime(Date.now())}\``, inline: true },
        { name: '💾 Storage', value: useSupabase ? '`Cloud (Supabase)`' : '`Local`', inline: true },
      ],
      footer:    { text: `Uptracker • Every ${site.interval}s` },
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
      title:       '🧪 Test Alert from Uptracker',
      description: `This is a test notification for **${siteName || 'your site'}**.\n\nWebhook is working correctly! ✅\n\n**Storage mode:** ${useSupabase ? '☁ Supabase (persistent)' : '⚡ localStorage (browser only)'}`,
      color:  0x3B82F6,
      fields: [
        { name: '📡 Source', value: '`Uptracker Dashboard`', inline: true },
        { name: '🕐 Time',   value: `\`${formatFullTime(Date.now())}\``, inline: true },
      ],
      footer:    { text: 'Uptracker • Realtime Website Monitor' },
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

// ── EXPOSE TO HTML onclick ───────────────────
window.removeSite    = removeSite;
window.openLogPanel  = openLogPanel;
window.openSiteUrl   = openSiteUrl;
window.openEditModal = openEditModal;
