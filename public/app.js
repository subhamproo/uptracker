/**
 * UPTRACKER — Dashboard UI v5
 * Reads data from GitHub Gist (written by Netlify server function)
 * No client-side check engine — server does all monitoring 24/7
 */

'use strict';

const SPARK_HISTORY = 20;
const REFRESH_MS    = 30000; // reload Gist every 30s — matches server check interval

let sites         = [];
let incidents     = {};
let checks        = {};
let useGist       = false;
let refreshTimer;
let countdown     = 30;
let countdownTimer;

// ── INIT ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const cfg = window.UPTRACKER_CONFIG || {};
  useGist   = !!(cfg.GITHUB_TOKEN && cfg.GIST_ID && cfg.GITHUB_TOKEN !== 'YOUR_GITHUB_TOKEN');

  showLoadingState(true);
  await loadData();
  showLoadingState(false);

  renderAll();
  bindEvents();
  updateStorageIndicator();

  // Start 30s countdown + auto-refresh
  startCountdown();
});

// ── DATA LOAD ─────────────────────────────────
async function loadData() {
  let payload = null;
  if (useGist) {
    payload = await gistLoad();
  }
  if (!payload) {
    payload = lsLoad();
  }
  if (payload) hydrateFromPayload(payload);
}

async function gistLoad() {
  const { GIST_ID, GIST_FILE, GITHUB_TOKEN } = window.UPTRACKER_CONFIG || {};
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const raw  = data.files?.[GIST_FILE]?.content;
    return raw ? JSON.parse(raw) : null;
  } catch(e) {
    console.warn('Gist load:', e.message);
    return null;
  }
}

function lsLoad() {
  try {
    const raw = localStorage.getItem('uptracker_local_v4')
             || localStorage.getItem('uptracker_local_v3')
             || localStorage.getItem('uptracker_sites_v2');
    if (!raw) return null;
    const d = JSON.parse(raw);
    return Array.isArray(d) ? { sites: d, incidents: {}, checks: {} } : d;
  } catch { return null; }
}

function lsSave() {
  try {
    localStorage.setItem('uptracker_local_v4', JSON.stringify({
      version: 4, sites: sites.map(siteToJSON), incidents, checks,
    }));
  } catch {}
}

async function gistSave(payload) {
  const { GIST_ID, GIST_FILE, GITHUB_TOKEN } = window.UPTRACKER_CONFIG || {};
  if (!useGist) { lsSave(); return; }
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        files: { [GIST_FILE]: { content: JSON.stringify(payload, null, 2) } },
      }),
    });
  } catch(e) { console.warn('Gist save:', e.message); }
  lsSave();
}

function buildPayload() {
  return { version: 4, savedAt: new Date().toISOString(),
           sites: sites.map(siteToJSON), incidents, checks };
}

function siteToJSON(s) {
  return {
    id:          s.id,
    name:        s.name,
    url:         s.url,
    interval:    s.interval || 30,
    webhookUrl:  s.webhookUrl || '',
    alertMode:   s.alertMode  || 'offline',
    pinHash:     s.pinHash    || '',
    addedAt:     s.addedAt,
    // Cloudflare DNS Failover fields
    cfEnabled:          s.cfEnabled          || false,
    cfApiToken:         s.cfApiToken         || '',
    cfZoneId:           s.cfZoneId           || '',
    cfRecordId:         s.cfRecordId         || '',
    cfRecordName:       s.cfRecordName       || '',
    cfRecordType:       s.cfRecordType       || 'CNAME',
    cfOriginalContent:  s.cfOriginalContent  || '',
    cfOriginalTtl:      s.cfOriginalTtl      || 1,
    cfProxied:          s.cfProxied          || false,
    cfMaintenanceUrl:   s.cfMaintenanceUrl   || '',
    cfFailoverActive:   s.cfFailoverActive   || false,
    // Server-written fields
    lastStatus:  s.lastStatus  || undefined,
    lastMs:      s.lastMs      || undefined,
    lastCode:    s.lastCode    || undefined,
    lastChecked: s.lastChecked || undefined,
  };
}

// ── HYDRATE ──────────────────────────────────
function hydrateFromPayload(payload) {
  if (!payload) return;

  incidents = payload.incidents || {};
  checks    = payload.checks    || {};

  sites = (payload.sites || []).map(s => {
    const siteChecks = (checks[s.id] || []).slice(-SPARK_HISTORY);
    const lastInc    = (incidents[s.id] || []).at(-1);
    return {
      ...s,
      webhookUrl:         s.webhookUrl        || '',
      alertMode:          s.alertMode         || 'offline',
      pinHash:            s.pinHash           || '',
      cfEnabled:          s.cfEnabled         || false,
      cfApiToken:         s.cfApiToken        || '',
      cfZoneId:           s.cfZoneId          || '',
      cfRecordId:         s.cfRecordId        || '',
      cfRecordName:       s.cfRecordName      || '',
      cfRecordType:       s.cfRecordType      || 'CNAME',
      cfOriginalContent:  s.cfOriginalContent || '',
      cfMaintenanceUrl:   s.cfMaintenanceUrl  || '',
      cfFailoverActive:   s.cfFailoverActive  || false,
      history:    siteChecks,
      uptimePct:  calcUptimePct(siteChecks),
      status:     s.lastStatus || lastInc?.status || 'checking',
      responseMs: s.lastMs     || null,
      lastCheck:  s.lastChecked ? new Date(s.lastChecked).getTime() : (lastInc?.ts || null),
    };
  });

  // Ensure ROI webhook
  const roi = sites.find(s => s.url?.includes('roiprofitacademy.in'));
  if (roi && !roi.webhookUrl) {
    roi.webhookUrl = 'https://discord.com/api/webhooks/1465360998411272344/pFe4scsMHqiJNv6WqMmkzIJfrBYxrdr0UkNcKn5i1yqT1Q3cFiOEKI3NAGUzpaZUBXur';
    roi.alertMode  = 'both';
  }
}

// ── COUNTDOWN ────────────────────────────────
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  if (refreshTimer)   clearInterval(refreshTimer);

  countdown = 30;
  updateCountdownEl();

  countdownTimer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      countdown = 30;
      // Auto-refresh data from Gist
      loadData().then(() => {
        renderAll();
        document.getElementById('lastCheckedTime').textContent = formatTime(Date.now());
      });
    }
    updateCountdownEl();
  }, 1000);
}

function updateCountdownEl() {
  const el = document.getElementById('countdown');
  if (el) el.textContent = countdown + 's';
}
async function addSite(name, url, interval = 30, webhookUrl = '', alertMode = 'offline') {
  const id   = 'site_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const site = {
    id, name: name.trim(), url: normalizeUrl(url.trim()), interval,
    webhookUrl: webhookUrl || '', alertMode: alertMode || 'offline',
    addedAt: Date.now(), status: 'checking', responseMs: null,
    uptimePct: null, lastCheck: null, history: [],
  };
  sites.push(site);
  incidents[id] = [];
  checks[id]    = [];
  await gistSave(buildPayload());
  renderAll();
  return site;
}

async function updateSite(id, changes) {
  const site = sites.find(s => s.id === id);
  if (!site) return;
  Object.assign(site, changes);
  await gistSave(buildPayload());
  updateCardStatus(site);
}

// removeSite — checks PIN before deleting
async function removeSite(id) {
  const site = sites.find(s => s.id === id);
  if (!site) return;

  if (site.pinHash) {
    openVerifyPin(id, 'delete');
  } else {
    await _doRemoveSite(id);
  }
}

function normalizeUrl(u) {
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function calcUptimePct(history) {
  if (!history?.length) return null;
  return Math.round((history.filter(h => h.status === 'up').length / history.length) * 1000) / 10;
}

// ── RENDER ───────────────────────────────────
function renderAll() {
  const grid  = document.getElementById('sitesGrid');
  const empty = document.getElementById('emptyState');

  if (sites.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    // Seed ROI if empty
    if (useGist) {
      addSite('ROI Profit Academy', 'https://roiprofitacademy.in', 30,
        'https://discord.com/api/webhooks/1465360998411272344/pFe4scsMHqiJNv6WqMmkzIJfrBYxrdr0UkNcKn5i1yqT1Q3cFiOEKI3NAGUzpaZUBXur',
        'both');
    }
  } else {
    empty.style.display = 'none';
    grid.innerHTML = sites.map(buildCardHTML).join('');
  }
  updateSummaryBar();
}

function buildCardHTML(site) {
  const uptime      = site.uptimePct !== null ? site.uptimePct.toFixed(1) + '%' : '—';
  const response    = site.responseMs !== null ? site.responseMs + 'ms' : '—';
  const rClass      = getResponseClass(site.responseMs);
  const uClass      = getUptimeClass(site.uptimePct);
  const fill        = site.uptimePct ?? 0;
  const fillCls     = fill < 70 ? 'low' : fill < 90 ? 'warn' : '';
  const domain      = getDomain(site.url);
  const totalChecks = (checks[site.id] || []).length;
  const totalInc    = (incidents[site.id] || []).filter(i => i.status === 'down').length;
  const serverBadge = useGist
    ? `<span class="server-badge">🖥 Server</span>`
    : `<span class="server-badge local">⚡ Local</span>`;
  const statusLbl = site.status === 'up' ? 'Online' : site.status === 'down' ? 'Offline' : 'Pending…';
  const sinceTxt  = site.lastCheck ? formatRelativeTime(site.lastCheck) : 'pending';

  // Lock badge + Change PIN button on card
  const lockBadge = site.pinHash
    ? `<span class="lock-badge" title="PIN protected">
        <svg viewBox="0 0 20 20" fill="none"><path d="M13 7H7m6 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2m6 0V5a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        PIN
       </span>`
    : '';

  const discordBadge = site.webhookUrl
    ? `<span class="discord-badge">
        <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
        ${site.alertMode === 'both' ? 'Online &amp; Offline' : 'Offline only'}</span>`
    : '';

  const cfBadge = site.cfEnabled
    ? `<span class="cf-card-badge ${site.cfFailoverActive ? 'active' : ''}" title="${site.cfFailoverActive ? 'DNS Failover ACTIVE — on maintenance page' : 'DNS Failover ready'}">
        ☁ ${site.cfFailoverActive ? 'Failover ON' : 'Failover'}
       </span>`
    : '';

  return `
  <div class="site-card status-${site.status}" id="card-${site.id}">
    <div class="card-header">
      <div class="card-identity">
        <div class="site-favicon">
          <img src="${getFaviconUrl(site.url)}" alt=""
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
          <span style="display:none;align-items:center;justify-content:center;width:100%;height:100%;font-size:15px;font-weight:700;color:var(--text-muted)">${getInitial(site.name)}</span>
        </div>
        <div class="card-title-wrap">
          <div class="card-name">${escHtml(site.name)}</div>
          <div class="card-url">${domain}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="icon-btn" onclick="openSiteUrl('${escAttr(site.url)}')" title="Open">
          <svg viewBox="0 0 20 20" fill="none"><path d="M11 3h6v6M17 3l-8 8M8 5H4a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-btn" onclick="openEditModal('${site.id}')" title="Edit">
          <svg viewBox="0 0 20 20" fill="none"><path d="M13.5 3.5a2.121 2.121 0 0 1 3 3L7 16l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-btn danger" onclick="removeSite('${site.id}')" title="Remove">
          <svg viewBox="0 0 20 20" fill="none"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>

    <div class="status-row">
      <div class="status-dot ${site.status}"></div>
      <span class="status-text ${site.status}">${statusLbl}</span>
      <span class="status-since">${sinceTxt}</span>
    </div>

    <div class="metrics-grid">
      <div class="metric-box">
        <div class="metric-label">Response</div>
        <div class="metric-value ${rClass}">${response}</div>
        <div class="metric-sub">Last server check</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Uptime</div>
        <div class="metric-value ${uClass}">${uptime}</div>
        <div class="metric-sub">${totalChecks} checks</div>
      </div>
    </div>

    <div class="uptime-section">
      <div class="uptime-header">
        <span>Uptime (last ${site.history.length || SPARK_HISTORY} checks)</span>
        <span class="uptime-pct ${uClass}">${uptime}</span>
      </div>
      <div class="uptime-bar-track">
        <div class="uptime-bar-fill ${fillCls}" style="width:${fill}%"></div>
      </div>
    </div>

    <div class="sparkline-section">
      <div class="sparkline-label">Response History</div>
      <div class="sparkline-wrap" id="spark-${site.id}">${buildSparkBars(site.history)}</div>
    </div>

    <div class="card-footer">
      <div class="footer-meta">${serverBadge} ${lockBadge} ${totalChecks} checks · every ${site.interval}s ${totalInc > 0 ? `· <span class="incident-count">${totalInc} outage${totalInc>1?'s':''}</span>` : ''}</div>
      <div class="footer-right">
        ${discordBadge}
        ${cfBadge}
        <button class="view-log-btn" onclick="openLogPanel('${site.id}')">
          <svg viewBox="0 0 20 20" fill="none"><path d="M3 5h14M3 10h14M3 15h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          History
        </button>
      </div>
    </div>
  </div>`;
}

function buildSparkBars(history) {
  if (!history?.length) {
    return Array(SPARK_HISTORY).fill(`<div class="spark-bar empty" style="height:20%"></div>`).join('');
  }
  const padded = [...Array(Math.max(0, SPARK_HISTORY - history.length)).fill(null), ...history];
  const maxMs  = Math.max(...history.filter(h=>h.ms).map(h=>h.ms), 500);
  return padded.map(h => {
    if (!h) return `<div class="spark-bar empty" style="height:20%" data-tip="No data"></div>`;
    if (h.status === 'down') return `<div class="spark-bar down-bar" style="height:100%" data-tip="DOWN"></div>`;
    const pct = Math.max(10, Math.min(100, Math.round((h.ms / maxMs) * 100)));
    const cls = h.ms < 500 ? 'ok' : h.ms < 1500 ? 'slow' : 'down-bar';
    return `<div class="spark-bar ${cls}" style="height:${pct}%" data-tip="${escAttr(h.ms+'ms · '+formatTime(h.ts))}"></div>`;
  }).join('');
}

function updateCardStatus(site) {
  const card = document.getElementById('card-' + site.id);
  if (!card) { renderAll(); return; }
  card.className = `site-card status-${site.status}`;
  const dot = card.querySelector('.status-dot');
  const txt = card.querySelector('.status-text');
  const snc = card.querySelector('.status-since');
  if (dot) dot.className = `status-dot ${site.status}`;
  if (txt) { txt.className = `status-text ${site.status}`;
    txt.textContent = site.status==='up'?'Online':site.status==='down'?'Offline':'Pending…'; }
  if (snc && site.lastCheck) snc.textContent = formatRelativeTime(site.lastCheck);
  const mv = card.querySelectorAll('.metric-value');
  if (mv[0]) { mv[0].textContent = site.responseMs!=null?site.responseMs+'ms':'—'; mv[0].className=`metric-value ${getResponseClass(site.responseMs)}`; }
  if (mv[1]) { mv[1].textContent = site.uptimePct!=null?site.uptimePct.toFixed(1)+'%':'—'; mv[1].className=`metric-value ${getUptimeClass(site.uptimePct)}`; }
  const fill = card.querySelector('.uptime-bar-fill');
  if (fill) { const p=site.uptimePct||0; fill.style.width=p+'%'; fill.className='uptime-bar-fill'+(p<70?' low':p<90?' warn':''); }
  const sp = document.getElementById('spark-'+site.id);
  if (sp) sp.innerHTML = buildSparkBars(site.history);
}

function updateSummaryBar() {
  document.getElementById('totalSites').textContent  = sites.length;
  document.getElementById('sitesUp').textContent     = sites.filter(s=>s.status==='up').length;
  document.getElementById('sitesDown').textContent   = sites.filter(s=>s.status==='down').length;
  const wu = sites.filter(s=>s.uptimePct!==null);
  const wr = sites.filter(s=>s.responseMs!==null&&s.status==='up');
  document.getElementById('avgUptime').textContent   = wu.length?(wu.reduce((a,s)=>a+s.uptimePct,0)/wu.length).toFixed(1)+'%':'—';
  document.getElementById('avgResponse').textContent = wr.length?Math.round(wr.reduce((a,s)=>a+s.responseMs,0)/wr.length)+'ms':'—';
  const lc = document.getElementById('lastCheckedTime');
  const lastRun = sites.find(s=>s.lastCheck)?.lastCheck;
  if (lc && lastRun) lc.textContent = formatTime(lastRun);
}

function updateStorageIndicator() {
  const el = document.getElementById('storageIndicator');
  if (!el) return;
  if (useGist) {
    el.textContent = '🖥 Server'; el.className = 'storage-indicator cloud';
    el.title = 'Monitored 24/7 by Netlify server — data in GitHub Gist';
    const b = document.getElementById('setupBanner');
    if (b) b.style.display = 'none';
  } else {
    el.textContent = '⚡ Local'; el.className = 'storage-indicator local';
    el.title = 'Configure Netlify env vars for server-side monitoring';
  }
}

function showLoadingState(on) {
  const grid = document.getElementById('sitesGrid');
  if (!grid) return;
  if (on) grid.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><span>Loading from server…</span></div>`;
}

// ── LOG PANEL ─────────────────────────────────
function openLogPanel(siteId) {
  const site = sites.find(s => s.id === siteId);
  if (!site) return;
  const panel = document.getElementById('logPanel');
  panel.dataset.siteId = siteId;
  document.getElementById('logSiteName').textContent = site.name;
  const f = document.getElementById('logDateFilter');
  if (f) f.value = '30';
  panel.classList.add('open');
  document.getElementById('logOverlay').classList.add('active');
  renderLogContent(siteId);
}

function renderLogContent(siteId) {
  const content = document.getElementById('logContent');
  const days    = parseInt(document.getElementById('logDateFilter')?.value || '30');
  const fromTs  = days === 0 ? 0 : Date.now() - days * 86400000;
  const all     = (incidents[siteId] || []).slice().reverse();
  const entries = days === 0 ? all : all.filter(e => e.ts >= fromTs);
  const totalDown = all.filter(e=>e.status==='down').length;

  if (!entries.length) {
    content.innerHTML = `<div class="log-empty">
      <svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="28" stroke="currentColor" stroke-width="2"/><path d="M22 32h20M32 22v20" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/></svg>
      <p>No incidents in this period.</p>
      ${all.length>0?`<p style="font-size:12px;color:var(--text-muted);margin-top:8px">${all.length} total · ${totalDown} outages · try "All time"</p>`:''}
    </div>`;
    return;
  }

  const down = entries.filter(e=>e.status==='down').length;
  const up   = entries.filter(e=>e.status==='up').length;
  const note = useGist
    ? `<small style="color:var(--up)">☁ Gist · 🖥 Server checks</small>`
    : `<small style="color:var(--warn)">⚡ Local only</small>`;

  const stats = `<div class="log-stats-bar">
    <span class="log-stat"><span class="log-stat-num down">${down}</span> outage${down!==1?'s':''}</span>
    <span class="log-stat"><span class="log-stat-num up">${up}</span> recover${up!==1?'ies':'y'}</span>
    <span class="log-stat-sep">·</span>
    <span class="log-stat muted">${entries.length} events</span>
    <span class="log-stat-sep">·</span>
    ${note}
  </div>`;

  const grouped = {};
  entries.forEach(e => {
    const d = new Date(e.ts).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric',year:'numeric'});
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(e);
  });

  content.innerHTML = stats + Object.entries(grouped).map(([day, evts]) => `
    <div class="log-date-group">
      <div class="log-date-label">${day}</div>
      ${evts.map(e=>`
        <div class="log-entry">
          <div class="log-dot ${e.status}"></div>
          <div class="log-body">
            <div class="log-event ${e.status}">${escHtml(e.event)}</div>
            <div class="log-time">${formatFullTime(e.ts)}</div>
            ${e.ms!=null?`<div class="log-response">${e.ms}ms${e.code?' · HTTP '+e.code:''}</div>`:''}
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
  ['siteName','siteUrl'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('checkInterval').value = '60';
  document.getElementById('modalError').textContent = '';
  setTimeout(()=>document.getElementById('siteName').focus(),100);
}
function closeAddModal() { document.getElementById('modalOverlay').classList.remove('active'); }

async function handleAddSite() {
  const name     = document.getElementById('siteName').value.trim();
  const url      = document.getElementById('siteUrl').value.trim();
  const interval = parseInt(document.getElementById('checkInterval').value);
  const errEl    = document.getElementById('modalError');
  if (!name) { errEl.textContent='Enter a site name.'; return; }
  if (!url)  { errEl.textContent='Enter a URL.'; return; }
  const norm = normalizeUrl(url);
  if (!isValidUrl(norm)) { errEl.textContent='Enter a valid URL.'; return; }
  if (sites.find(s=>s.url===norm)) { errEl.textContent='Already monitoring this.'; return; }

  // Close add modal and open Set PIN modal
  closeAddModal();
  openSetPin({ name, url: norm, interval, webhookUrl: '', alertMode: 'offline' });
}

// openEditModal — checks PIN before opening
function openEditModal(siteId) {
  const site = sites.find(s=>s.id===siteId);
  if (!site) return;

  if (site.pinHash) {
    // Site is PIN-protected → verify first
    openVerifyPin(siteId, 'edit');
  } else {
    // No PIN set → open directly (legacy sites or seeds)
    _doOpenEditModal(siteId);
  }
}
function closeEditModal() { document.getElementById('editModalOverlay').classList.remove('active'); }

async function handleSaveEdit() {
  const id        = document.getElementById('editSiteId').value;
  const name      = document.getElementById('editSiteName').value.trim();
  const url       = document.getElementById('editSiteUrl').value.trim();
  const interval  = parseInt(document.getElementById('editCheckInterval').value);
  const webhook   = document.getElementById('editWebhookUrl').value.trim();
  const alertMode = document.querySelector('input[name="alertMode"]:checked')?.value || 'offline';
  const errEl     = document.getElementById('editModalError');

  // Cloudflare fields
  const cfEnabled         = document.getElementById('cfEnabled')?.checked         || false;
  const cfApiToken        = document.getElementById('cfApiToken')?.value.trim()   || '';
  const cfZoneId          = document.getElementById('cfZoneId')?.value.trim()     || '';
  const cfRecordId        = document.getElementById('cfRecordId')?.value.trim()   || '';
  const cfRecordName      = document.getElementById('cfRecordName')?.value.trim() || '';
  const cfRecordType      = document.getElementById('cfRecordType')?.value        || 'CNAME';
  const cfOriginalContent = document.getElementById('cfOriginalContent')?.value.trim() || '';
  const cfMaintenanceUrl  = document.getElementById('cfMaintenanceUrl')?.value.trim() || '';

  if (!name) { errEl.textContent = 'Enter a site name.'; return; }
  if (!url)  { errEl.textContent = 'Enter a URL.'; return; }
  if (webhook && !webhook.includes('discord.com/api/webhooks/')) { errEl.textContent = 'Must be a Discord webhook URL.'; return; }
  if (cfEnabled && (!cfApiToken || !cfZoneId || !cfRecordId || !cfRecordName)) {
    errEl.textContent = 'Cloudflare failover requires API Token, Zone ID, Record ID and Record Name.';
    return;
  }

  const btn = document.getElementById('editModalSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  await updateSite(id, {
    name, url: normalizeUrl(url), interval, webhookUrl: webhook, alertMode,
    cfEnabled, cfApiToken, cfZoneId, cfRecordId, cfRecordName,
    cfRecordType, cfOriginalContent, cfMaintenanceUrl,
  });

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
  if (!webhook) { errEl.textContent='Enter a webhook URL first.'; return; }
  if (!webhook.includes('discord.com/api/webhooks/')) { errEl.textContent='Must be a Discord webhook URL.'; return; }
  btn.disabled=true; btn.textContent='Sending…'; errEl.textContent='';
  const ok = await sendTestDiscord(webhook, siteName||'Test Site');
  btn.disabled=false;
  btn.innerHTML=`<svg viewBox="0 0 20 20" fill="none"><path d="M10 2l2.4 5.4 5.6.8-4 4 1 5.8-5-2.8L5 18l1-5.8-4-4 5.6-.8L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg> Send Test Alert`;
  if (ok) { showToast('Test sent! ✅','up','🎉'); errEl.style.color='var(--up)'; errEl.textContent='✅ Delivered!'; setTimeout(()=>{errEl.textContent='';errEl.style.color='';},3000); }
  else    { errEl.textContent='❌ Failed. Check webhook URL.'; }
}

async function sendTestDiscord(webhookUrl, siteName) {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username:'Uptracker', embeds:[{
        title: '🧪 Test Alert — Uptracker',
        description:`Webhook working for **${siteName}** ✅\n**Source:** Netlify server-side monitoring`,
        color: 0x3B82F6,
        fields:[
          {name:'🖥 Monitored by',value:'`Netlify Scheduled Function`',inline:true},
          {name:'🕐 Time',value:`\`${formatFullTime(Date.now())}\``,inline:true},
        ],
        footer:{text:'Uptracker • Server-side checks 24/7'},
        timestamp: new Date().toISOString(),
      }]}),
    });
    return res.ok || res.status === 204;
  } catch { return false; }
}

// ── EVENTS ───────────────────────────────────
function bindEvents() {
  document.getElementById('addSiteBtn').addEventListener('click', openAddModal);
  document.getElementById('checkNowBtn').addEventListener('click', async () => {
    const btn  = document.getElementById('checkNowBtn');
    const icon = btn?.querySelector('svg');
    if (icon) icon.classList.add('spinning');
    btn?.setAttribute('disabled', '');

    await loadData();
    renderAll();
    document.getElementById('lastCheckedTime').textContent = formatTime(Date.now());
    showToast('Data refreshed from server', 'info', '🔄');

    // Reset countdown
    countdown = 30;
    updateCountdownEl();

    if (icon) icon.classList.remove('spinning');
    btn?.removeAttribute('disabled');
  });
  document.getElementById('modalClose').addEventListener('click', closeAddModal);
  document.getElementById('modalCancelBtn').addEventListener('click', closeAddModal);
  document.getElementById('modalAddBtn').addEventListener('click', handleAddSite);
  document.getElementById('logClose').addEventListener('click', closeLogPanel);
  document.getElementById('logOverlay').addEventListener('click', closeLogPanel);
  document.getElementById('editModalClose').addEventListener('click', closeEditModal);
  document.getElementById('editModalCancelBtn').addEventListener('click', closeEditModal);
  document.getElementById('editModalSaveBtn').addEventListener('click', handleSaveEdit);
  document.getElementById('testWebhookBtn').addEventListener('click', handleTestWebhook);

  // Cloudflare toggle
  document.getElementById('cfEnabled')?.addEventListener('change', (e) => {
    toggleCfFields(e.target.checked);
  });
  // CF test connection button
  document.getElementById('cfTestBtn')?.addEventListener('click', handleCfTest);
  document.getElementById('modalOverlay').addEventListener('click', e=>{if(e.target===e.currentTarget)closeAddModal();});
  document.getElementById('editModalOverlay').addEventListener('click', e=>{if(e.target===e.currentTarget)closeEditModal();});
  document.getElementById('siteUrl').addEventListener('keydown', e=>{if(e.key==='Enter')handleAddSite();});
  document.getElementById('siteName').addEventListener('keydown', e=>{if(e.key==='Enter')document.getElementById('siteUrl').focus();});
  document.getElementById('logDateFilter')?.addEventListener('change', () => {
    const id = document.getElementById('logPanel').dataset.siteId;
    if (id) renderLogContent(id);
  });
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape'){
      closeAddModal();
      closeLogPanel();
      closeEditModal();
      closeSetPin();
      closeVerifyPin();
      closeChangePinModal();
    }
  });

  // Init PIN system
  bindPinEvents();
}

// ── CLOUDFLARE TEST ───────────────────────────
async function handleCfTest() {
  const token    = document.getElementById('cfApiToken')?.value.trim();
  const zoneId   = document.getElementById('cfZoneId')?.value.trim();
  const recordId = document.getElementById('cfRecordId')?.value.trim();
  const errEl    = document.getElementById('editModalError');
  const btn      = document.getElementById('cfTestBtn');

  if (!token || !zoneId || !recordId) {
    errEl.textContent = 'Fill in API Token, Zone ID and Record ID to test.';
    return;
  }

  btn.disabled = true; btn.textContent = 'Testing…'; errEl.textContent = '';

  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.success) {
      const rec = data.result;
      // Auto-fill original content if empty
      const origInput = document.getElementById('cfOriginalContent');
      if (origInput && !origInput.value) origInput.value = rec.content;
      const nameInput = document.getElementById('cfRecordName');
      if (nameInput && !nameInput.value) nameInput.value = rec.name;
      const typeInput = document.getElementById('cfRecordType');
      if (typeInput) typeInput.value = rec.type;

      errEl.style.color = 'var(--up)';
      errEl.textContent = `✅ Connected! Record: ${rec.type} ${rec.name} → ${rec.content}`;
      setTimeout(() => { errEl.textContent = ''; errEl.style.color = ''; }, 5000);
      showToast('Cloudflare connection verified ✅', 'up', '☁️');
    } else {
      errEl.textContent = `❌ CF Error: ${data.errors?.[0]?.message || 'Unknown error'}`;
    }
  } catch(e) {
    errEl.textContent = `❌ Request failed: ${e.message}`;
  }

  btn.disabled = false; btn.textContent = 'Test Connection';
}

// ── TOAST ────────────────────────────────────
function showToast(msg, type='info', icon='ℹ️') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${icon}</span><span>${escHtml(msg)}</span>`;
  c.appendChild(t);
  setTimeout(()=>{ t.classList.add('removing'); setTimeout(()=>t.remove(),300); }, 4000);
}

// ── HELPERS ──────────────────────────────────
function openSiteUrl(u)   { window.open(u,'_blank','noopener'); }
function getFaviconUrl(u) { try{return`https://www.google.com/s2/favicons?domain=${new URL(u).hostname}&sz=64`;}catch{return'';} }
function getDomain(u)     { try{return new URL(u).hostname.replace('www.','');}catch{return u;} }
function getInitial(n)    { return n.charAt(0).toUpperCase(); }
function getResponseClass(ms){ if(ms===null)return'dim';if(ms<500)return'good';if(ms<1500)return'warn';return'bad'; }
function getUptimeClass(p)   { if(p===null)return'dim';if(p>=99)return'good';if(p>=90)return'warn';return'bad'; }
function isValidUrl(u)    { try{new URL(u);return true;}catch{return false;} }
function escHtml(s)       { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s)       { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function formatTime(ts)   { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function formatFullTime(ts){ return new Date(ts).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function formatRelativeTime(ts){ const d=Date.now()-ts; if(d<60000)return'just now';if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';return Math.floor(d/86400000)+'d ago'; }

window.removeSite        = removeSite;
window.openLogPanel      = openLogPanel;
window.openSiteUrl       = openSiteUrl;
window.openEditModal     = openEditModal;
window.openChangePinFlow = (siteId) => openVerifyPin(siteId, 'changePinAfterVerify');


/* ═══════════════════════════════════════════════════════════
   PIN SECURITY ENGINE
   ═══════════════════════════════════════════════════════════ */

const MASTER_PIN = '381998';

// ── HASH (simple djb2 — not cryptographic, good enough for UX lock) ──
function hashPin(pin) {
  let h = 5381;
  for (let i = 0; i < pin.length; i++) {
    h = ((h << 5) + h) + pin.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function pinMatches(input, storedHash) {
  // Master PIN always works — even if no pinHash is set yet
  if (input === MASTER_PIN) return true;
  // If no PIN has been set, nothing else can match
  if (!storedHash) return false;
  return hashPin(input) === storedHash;
}

// ── PIN DIGIT BOX CONTROLLER ──────────────────────────────────────────
// Manages a .pin-digits container: auto-advance, backspace, paste, focus
function initPinBox(containerId, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const digits = Array.from(container.querySelectorAll('.pin-digit'));

  digits.forEach((inp, i) => {
    // Only allow numbers
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (inp.value) {
          inp.value = '';
          inp.classList.remove('filled');
        } else if (i > 0) {
          digits[i - 1].value = '';
          digits[i - 1].classList.remove('filled');
          digits[i - 1].focus();
        }
        opts.onChange?.();
        return;
      }
      if (e.key === 'ArrowLeft'  && i > 0)              { e.preventDefault(); digits[i-1].focus(); return; }
      if (e.key === 'ArrowRight' && i < digits.length-1) { e.preventDefault(); digits[i+1].focus(); return; }
      if (e.key === 'Enter') { opts.onEnter?.(); return; }
      if (!/^\d$/.test(e.key)) { e.preventDefault(); }
    });

    inp.addEventListener('input', () => {
      const val = inp.value.replace(/\D/g, '');
      inp.value = val ? val[0] : '';
      inp.classList.toggle('filled', !!inp.value);

      // Activate extra slots styling when we reach the 5th digit
      if (i >= 3) {
        container.querySelectorAll('.pin-digit-extra').forEach(d => d.classList.add('active-extra'));
      }

      if (inp.value && i < digits.length - 1) {
        digits[i + 1].focus();
      }
      opts.onChange?.();
    });

    // Allow paste of full PIN
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      pasted.split('').forEach((ch, j) => {
        if (digits[i + j]) {
          digits[i + j].value = ch;
          digits[i + j].classList.add('filled');
        }
      });
      const next = Math.min(i + pasted.length, digits.length - 1);
      digits[next].focus();
      opts.onChange?.();
    });

    inp.addEventListener('focus', () => {
      inp.select();
    });
  });
}

// Read value from a pin-digits container
function getPinValue(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return '';
  return Array.from(container.querySelectorAll('.pin-digit'))
    .map(d => d.value).join('');
}

// Clear all digits in a container
function clearPinBox(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.pin-digit').forEach(d => {
    d.value = '';
    d.classList.remove('filled', 'success');
  });
  container.querySelectorAll('.pin-digit-extra').forEach(d => {
    d.classList.remove('active-extra');
  });
  container.classList.remove('shake');
}

// Shake a pin-digits container (wrong PIN)
function shakePinBox(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth; // reflow to restart animation
  el.classList.add('shake');
  el.querySelectorAll('.pin-digit').forEach(d => d.classList.remove('filled'));
}

// Flash success (green) on all digits
function successPinBox(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.querySelectorAll('.pin-digit').forEach(d => d.classList.add('success'));
}

// ── PENDING ACTION STATE ──────────────────────────────────────────────
// When user clicks edit/delete, we store what to do after PIN verified
let _pendingAction = null; // { type: 'edit'|'delete', siteId }

// ── SET PIN MODAL ─────────────────────────────────────────────────────
let _pendingAddData = null; // store add-site form data while user sets PIN

function openSetPin(addData) {
  _pendingAddData = addData;
  clearPinBox('setPinDigits');
  clearPinBox('confirmPinDigits');
  document.getElementById('setPinError').textContent = '';
  document.getElementById('setPinOverlay').classList.add('active');
  setTimeout(() => {
    document.querySelector('#setPinDigits .pin-digit')?.focus();
  }, 120);
}

function closeSetPin() {
  document.getElementById('setPinOverlay').classList.remove('active');
  _pendingAddData = null;
}

async function handleSetPinConfirm() {
  const pin1 = getPinValue('setPinDigits');
  const pin2 = getPinValue('confirmPinDigits');
  const errEl = document.getElementById('setPinError');

  if (pin1.length < 4) {
    errEl.textContent = 'Enter all 4 digits.';
    shakePinBox('setPinDigits');
    return;
  }
  if (pin1 !== pin2) {
    errEl.textContent = 'PINs don\'t match. Try again.';
    shakePinBox('confirmPinDigits');
    clearPinBox('confirmPinDigits');
    setTimeout(() => document.querySelector('#confirmPinDigits .pin-digit')?.focus(), 50);
    return;
  }
  if (pin1 === MASTER_PIN.slice(0, 4)) {
    errEl.textContent = 'Cannot use the first 4 digits of master PIN.';
    shakePinBox('setPinDigits');
    return;
  }

  successPinBox('setPinDigits');
  successPinBox('confirmPinDigits');

  await new Promise(r => setTimeout(r, 350)); // let success animation play

  const pinHash = hashPin(pin1);
  closeSetPin();

  // Now actually add the site with the PIN hash
  const d = _pendingAddData;
  if (!d) return;
  await addSiteWithPin(d.name, d.url, d.interval, d.webhookUrl, d.alertMode, pinHash);
}

// ── VERIFY PIN MODAL ──────────────────────────────────────────────────
function openVerifyPin(siteId, action) {
  // action: 'edit' | 'delete' | 'changePinAfterVerify'
  _pendingAction = { siteId, action };

  const site = sites.find(s => s.id === siteId);
  const name = site?.name || 'this site';

  const icons    = { edit: '✏️', delete: '🗑️', changePinAfterVerify: '🔑' };
  const titles   = { edit: `Edit "${name}"`, delete: `Delete "${name}"`, changePinAfterVerify: `Change PIN for "${name}"` };
  const subs     = {
    edit:                'Enter your PIN to unlock settings for this site.',
    delete:              'Enter your PIN to permanently remove this site.',
    changePinAfterVerify:'Enter current PIN to unlock PIN change.',
  };

  document.getElementById('verifyPinIcon').textContent  = icons[action]  || '🔒';
  document.getElementById('verifyPinTitle').textContent = titles[action] || 'Enter PIN';
  document.getElementById('verifyPinSub').textContent   = subs[action]   || 'Enter your 4-digit PIN.';

  clearPinBox('verifyPinDigits');
  document.getElementById('verifyPinError').textContent = '';

  // Make extra slots fully visible — master PIN always available
  document.querySelectorAll('#verifyPinDigits .pin-digit-extra').forEach(d => {
    d.classList.add('active-extra');
  });

  document.getElementById('verifyPinOverlay').classList.add('active');
  setTimeout(() => document.querySelector('#verifyPinDigits .pin-digit')?.focus(), 120);
}

function closeVerifyPin() {
  document.getElementById('verifyPinOverlay').classList.remove('active');
  _pendingAction = null;
}

async function handleVerifyPinConfirm() {
  const entered = getPinValue('verifyPinDigits');
  const errEl   = document.getElementById('verifyPinError');

  if (entered.length !== 4 && entered.length !== 6) {
    errEl.textContent = 'Enter 4-digit site PIN or 6-digit master PIN.';
    shakePinBox('verifyPinDigits');
    return;
  }

  const { siteId, action } = _pendingAction || {};
  const site = sites.find(s => s.id === siteId);

  if (!pinMatches(entered, site?.pinHash)) {
    errEl.textContent = 'Wrong PIN. Try again.';
    shakePinBox('verifyPinDigits');
    clearPinBox('verifyPinDigits');
    setTimeout(() => document.querySelector('#verifyPinDigits .pin-digit')?.focus(), 50);
    return;
  }

  // PIN correct
  successPinBox('verifyPinDigits');
  await new Promise(r => setTimeout(r, 300));
  closeVerifyPin();

  if (action === 'edit') {
    _doOpenEditModal(siteId);
  } else if (action === 'delete') {
    await _doRemoveSite(siteId);
  } else if (action === 'changePinAfterVerify') {
    openChangePinModal(siteId);
  }
}

// ── CHANGE PIN MODAL ──────────────────────────────────────────────────
let _changePinSiteId = null;

function openChangePinModal(siteId) {
  _changePinSiteId = siteId;
  clearPinBox('oldPinDigits');
  clearPinBox('newPinDigits');
  clearPinBox('confirmNewPinDigits');
  document.getElementById('changePinError').textContent = '';

  // Update subtitle based on whether site already has a PIN
  const site = sites.find(s => s.id === siteId);
  const sub  = document.querySelector('#changePinModal .pin-modal-sub');
  if (sub) {
    sub.textContent = site?.pinHash
      ? 'Enter your current PIN (or master PIN 381998), then set a new 4-digit PIN.'
      : 'This site has no PIN yet. Enter master PIN (381998) to set one.';
  }

  // Make extra slots (5th & 6th) fully visible — master PIN always available
  document.querySelectorAll('#oldPinDigits .pin-digit-extra').forEach(d => {
    d.classList.add('active-extra');
  });

  document.getElementById('changePinOverlay').classList.add('active');
  setTimeout(() => document.querySelector('#oldPinDigits .pin-digit')?.focus(), 120);
}

function closeChangePinModal() {
  document.getElementById('changePinOverlay').classList.remove('active');
  _changePinSiteId = null;
}

async function handleChangePinConfirm() {
  const oldPin    = getPinValue('oldPinDigits');
  const newPin    = getPinValue('newPinDigits');
  const confirmPin = getPinValue('confirmNewPinDigits');
  const errEl     = document.getElementById('changePinError');

  const site = sites.find(s => s.id === _changePinSiteId);
  if (!site) { closeChangePinModal(); return; }

  // Validate old PIN — accept 4 digits (site PIN) or 6 digits (master PIN)
  if (oldPin.length !== 4 && oldPin.length !== 6) {
    errEl.textContent = 'Enter 4 digits (site PIN) or 6 digits (master PIN).';
    shakePinBox('oldPinDigits');
    return;
  }
  if (!pinMatches(oldPin, site.pinHash)) {
    // Special case: site has no PIN yet — only master PIN can set one
    if (!site.pinHash && oldPin !== MASTER_PIN) {
      errEl.textContent = 'This site has no PIN. Use master PIN (381998) to set one.';
      shakePinBox('oldPinDigits');
      clearPinBox('oldPinDigits');
      setTimeout(() => document.querySelector('#oldPinDigits .pin-digit')?.focus(), 50);
      return;
    }
    errEl.textContent = 'Current PIN is wrong.';
    shakePinBox('oldPinDigits');
    clearPinBox('oldPinDigits');
    setTimeout(() => document.querySelector('#oldPinDigits .pin-digit')?.focus(), 50);
    return;
  }

  // Validate new PIN
  if (newPin.length < 4) {
    errEl.textContent = 'Enter all 4 digits for new PIN.';
    shakePinBox('newPinDigits');
    return;
  }
  if (newPin === MASTER_PIN.slice(0, 4)) {
    errEl.textContent = 'Cannot use the first 4 digits of master PIN.';
    shakePinBox('newPinDigits');
    return;
  }
  if (newPin !== confirmPin) {
    errEl.textContent = 'New PINs don\'t match.';
    shakePinBox('confirmNewPinDigits');
    clearPinBox('confirmNewPinDigits');
    setTimeout(() => document.querySelector('#confirmNewPinDigits .pin-digit')?.focus(), 50);
    return;
  }

  successPinBox('newPinDigits');
  successPinBox('confirmNewPinDigits');
  await new Promise(r => setTimeout(r, 350));

  // Save new PIN hash
  site.pinHash = hashPin(newPin);
  await gistSave(buildPayload());
  closeChangePinModal();
  showToast('PIN updated successfully', 'up', '🔑');
  renderAll(); // refresh lock badges
}

// ── INTERNAL — actual add/edit/delete (called after PIN verified) ─────

// addSiteWithPin is the real addSite that includes the pinHash
async function addSiteWithPin(name, url, interval, webhookUrl, alertMode, pinHash) {
  const id   = 'site_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const site = {
    id,
    name:       name.trim(),
    url:        normalizeUrl(url.trim()),
    interval,
    webhookUrl: webhookUrl || '',
    alertMode:  alertMode  || 'offline',
    pinHash:    pinHash    || '',
    addedAt:    Date.now(),
    status:     'checking',
    responseMs: null,
    uptimePct:  null,
    lastCheck:  null,
    history:    [],
  };
  sites.push(site);
  incidents[id] = [];
  checks[id]    = [];
  await gistSave(buildPayload());
  renderAll();
  showToast(`${name} added & protected 🔒`, 'up', '✅');
  return site;
}

function _doOpenEditModal(siteId) {
  const site = sites.find(s => s.id === siteId);
  if (!site) return;
  document.getElementById('editSiteId').value        = site.id;
  document.getElementById('editSiteName').value      = site.name;
  document.getElementById('editSiteUrl').value       = site.url;
  document.getElementById('editCheckInterval').value = String(site.interval || 30);
  document.getElementById('editWebhookUrl').value    = site.webhookUrl || '';
  document.getElementById('editModalError').textContent = '';
  const mode = site.alertMode || 'offline';
  document.querySelector(`input[name="alertMode"][value="${mode}"]`).checked = true;

  // Populate Cloudflare fields
  document.getElementById('cfEnabled').checked           = !!site.cfEnabled;
  document.getElementById('cfApiToken').value            = site.cfApiToken        || '';
  document.getElementById('cfZoneId').value              = site.cfZoneId          || '';
  document.getElementById('cfRecordId').value            = site.cfRecordId        || '';
  document.getElementById('cfRecordName').value          = site.cfRecordName      || '';
  document.getElementById('cfRecordType').value          = site.cfRecordType      || 'CNAME';
  document.getElementById('cfOriginalContent').value     = site.cfOriginalContent || '';
  document.getElementById('cfMaintenanceUrl').value      = site.cfMaintenanceUrl  || '';
  // Show/hide CF fields based on toggle
  toggleCfFields(!!site.cfEnabled);
  // Show CF status if active
  updateCfStatusRow(site);

  // Inject "Change PIN" row into edit modal (once)
  const existing = document.getElementById('changePinRow');
  if (!existing) {
    const cfSec = document.getElementById('cfSection');
    if (cfSec) {
      const row = document.createElement('div');
      row.id        = 'changePinRow';
      row.className = 'change-pin-row';
      row.innerHTML = `
        <div class="change-pin-info">
          <svg viewBox="0 0 20 20" fill="none"><path d="M13 7H7m6 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2m6 0V5a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span>Site PIN is active</span>
        </div>
        <button class="change-pin-btn" id="changePinTrigger">Change PIN</button>`;
      cfSec.insertAdjacentElement('afterend', row);
      document.getElementById('changePinTrigger').addEventListener('click', () => {
        const id = document.getElementById('editSiteId').value;
        closeEditModal();
        openChangePinModal(id);
      });
    }
  }

  document.getElementById('editModalOverlay').classList.add('active');
  setTimeout(() => document.getElementById('editSiteName')?.focus(), 100);
}

function toggleCfFields(enabled) {
  const fields = document.getElementById('cfFields');
  if (fields) fields.style.display = enabled ? 'flex' : 'none';
}

function updateCfStatusRow(site) {
  const row = document.getElementById('cfStatusRow');
  const ind = document.getElementById('cfStatusIndicator');
  const txt = document.getElementById('cfStatusText');
  if (!row) return;
  if (site.cfEnabled && site.cfZoneId && site.cfRecordId) {
    row.style.display = 'flex';
    if (site.cfFailoverActive) {
      ind.className = 'cf-status-indicator down';
      txt.textContent = '🔄 Failover active — DNS pointing to maintenance page';
    } else {
      ind.className = 'cf-status-indicator up';
      txt.textContent = '✅ Normal — DNS pointing to your server';
    }
  } else {
    row.style.display = 'none';
  }
}

async function _doRemoveSite(id) {
  const name = sites.find(s => s.id === id)?.name || 'Site';
  sites     = sites.filter(s => s.id !== id);
  delete incidents[id];
  delete checks[id];
  await gistSave(buildPayload());
  renderAll();
  showToast(`${name} removed`, 'info', '🗑️');
}

// ── BIND PIN MODAL EVENTS ─────────────────────────────────────────────
function bindPinEvents() {
  // Set PIN
  initPinBox('setPinDigits',     { onEnter: () => document.querySelector('#confirmPinDigits .pin-digit')?.focus() });
  initPinBox('confirmPinDigits', { onEnter: handleSetPinConfirm });
  document.getElementById('setPinConfirm').addEventListener('click', handleSetPinConfirm);
  document.getElementById('setPinCancel').addEventListener('click', closeSetPin);
  document.getElementById('setPinOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSetPin();
  });

  // Verify PIN (6 slots: 4 normal + 2 extra for master)
  initPinBox('verifyPinDigits', { onEnter: handleVerifyPinConfirm });
  document.getElementById('verifyPinConfirm').addEventListener('click', handleVerifyPinConfirm);
  document.getElementById('verifyPinCancel').addEventListener('click', closeVerifyPin);
  document.getElementById('verifyPinOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeVerifyPin();
  });

  // Change PIN
  // Change PIN — old PIN box must support 4 or 6 digits (master)
  // Don't auto-jump to newPin on Enter — let user finish typing 6 digits if needed
  initPinBox('oldPinDigits', {
    onEnter: () => {
      const val = getPinValue('oldPinDigits');
      if (val.length >= 4) {
        document.querySelector('#newPinDigits .pin-digit')?.focus();
      }
    }
  });
  initPinBox('newPinDigits',        { onEnter: () => document.querySelector('#confirmNewPinDigits .pin-digit')?.focus() });
  initPinBox('confirmNewPinDigits', { onEnter: handleChangePinConfirm });
  document.getElementById('changePinConfirm').addEventListener('click', handleChangePinConfirm);
  document.getElementById('changePinCancel').addEventListener('click', closeChangePinModal);
  document.getElementById('changePinOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeChangePinModal();
  });

  // Close PIN modals on Escape
  // (hooked into the existing global keydown in bindEvents)
}
