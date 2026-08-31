/**
 * Uptracker — Local Dev Server
 * Serves public/ as static files + proxies Cloudflare API calls (avoids CORS)
 * Usage: node server.js
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;
const MIME = {
  html: 'text/html',
  css:  'text/css',
  js:   'application/javascript',
  svg:  'image/svg+xml',
  ico:  'image/x-icon',
  png:  'image/png',
  json: 'application/json',
};

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

// ── Generic HTTPS request helper ─────────────
function httpsRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-cf-token');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  // ── /cf-proxy — Cloudflare API proxy ────────
  if (reqUrl.pathname === '/cf-proxy') {
    let cfPath, cfToken, cfMethod = 'GET', cfBody = null;

    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw);
        cfPath   = parsed.path;
        cfToken  = parsed.token;
        cfMethod = parsed.method || 'GET';
        cfBody   = parsed.body   || null;
      } catch {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Invalid JSON'}));
        return;
      }
    } else {
      cfPath  = reqUrl.searchParams.get('path');
      cfToken = req.headers['x-cf-token'];
      cfMethod = req.method;
      if (cfMethod === 'PATCH' || cfMethod === 'PUT') {
        const raw = await readBody(req);
        try { cfBody = JSON.parse(raw); } catch { cfBody = null; }
      }
    }

    if (!cfPath || !cfToken) {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Missing path or token'}));
      return;
    }

    const payload = cfBody ? JSON.stringify(cfBody) : null;
    try {
      const result = await httpsRequest({
        hostname: 'api.cloudflare.com',
        path:     `/client/v4${cfPath}`,
        method:   cfMethod.toUpperCase(),
        headers: {
          'Authorization': `Bearer ${cfToken}`,
          'Content-Type':  'application/json',
          'User-Agent':    'Uptracker-DevServer/1.0',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, payload);
      res.writeHead(result.status, {'Content-Type':'application/json'});
      res.end(typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ── /gist-proxy — GitHub Gist proxy (for maintenance page) ──
  if (reqUrl.pathname === '/gist-proxy') {
    let ghToken, gistId, gistFile;

    if (req.method === 'POST') {
      try {
        const raw    = await readBody(req);
        const parsed = JSON.parse(raw);
        ghToken  = parsed.token;
        gistId   = parsed.gistId;
        gistFile = parsed.gistFile || 'uptracker_data.json';
      } catch {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Invalid JSON'}));
        return;
      }
    }

    if (!ghToken || !gistId) {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Missing token or gistId'}));
      return;
    }

    try {
      const result = await httpsRequest({
        hostname: 'api.github.com',
        path:     `/gists/${gistId}`,
        method:   'GET',
        headers: {
          'Authorization': `token ${ghToken}`,
          'Accept':        'application/vnd.github.v3+json',
          'User-Agent':    'Uptracker-DevServer/1.0',
        },
      }, null);
      const raw = result.data?.files?.[gistFile]?.content;
      if (!raw) { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'File not found in Gist'})); return; }
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(raw); // return raw JSON content directly
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ── /gist-proxy-write — GitHub Gist PATCH proxy ────────────────────
  if (reqUrl.pathname === '/gist-proxy-write') {
    let ghToken, gistId, gistFile, content;
    try {
      const raw    = await readBody(req);
      const parsed = JSON.parse(raw);
      ghToken  = parsed.token;
      gistId   = parsed.gistId;
      gistFile = parsed.gistFile || 'uptracker_data.json';
      content  = parsed.content;
    } catch {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Invalid JSON'}));
      return;
    }

    if (!ghToken || !gistId || !content) {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Missing token, gistId or content'}));
      return;
    }

    const body = JSON.stringify({
      files: { [gistFile]: { content: JSON.stringify(content, null, 2) } },
    });

    try {
      const result = await httpsRequest({
        hostname: 'api.github.com',
        path:     `/gists/${gistId}`,
        method:   'PATCH',
        headers: {
          'Authorization': `token ${ghToken}`,
          'Content-Type':  'application/json',
          'Accept':        'application/vnd.github.v3+json',
          'User-Agent':    'Uptracker-DevServer/1.0',
          'Content-Length': Buffer.byteLength(body),
        },
      }, body);
      res.writeHead(result.status === 200 ? 200 : result.status, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: result.status === 200 }));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }
  const filePath = path.join(__dirname, 'public',
    reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname);

  try {
    const data = fs.readFileSync(filePath);
    const ext  = filePath.split('.').pop();
    res.writeHead(200, {
      'Content-Type':  MIME[ext] || 'text/plain',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, {'Content-Type':'text/plain'});
    res.end('Not found: ' + reqUrl.pathname);
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Uptracker dev server → http://localhost:${PORT}`);
  console.log(`   CF proxy: POST /cf-proxy  {path, token, method, body}`);
  console.log(`   Press Ctrl+C to stop\n`);
});
