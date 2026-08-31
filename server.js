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

function cfRequest(token, cfPath, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path:     `/client/v4${cfPath}`,
      method:   method.toUpperCase(),
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Uptracker-DevServer/1.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
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
      // Netlify function format: POST with JSON body
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
      // GET format: query param + header
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

    try {
      const result = await cfRequest(cfToken, cfPath, cfMethod, cfBody);
      res.writeHead(result.status, {'Content-Type':'application/json'});
      res.end(typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ── Static files ─────────────────────────────
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
