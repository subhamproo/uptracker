/**
 * Uptracker — Local Dev Server
 * Serves public/ as static files + proxies Cloudflare API calls (avoids CORS)
 * Usage: node server.js
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

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

const server = http.createServer(async (req, res) => {
  // ── CORS headers for all responses ──────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);

  // ── Cloudflare API proxy ─────────────────────
  // GET  /cf-proxy?path=/zones/...   (read record)
  // PATCH /cf-proxy?path=/zones/...  (update record)
  if (parsed.pathname === '/cf-proxy') {
    const cfPath  = parsed.query.path;
    const cfToken = req.headers['x-cf-token'];

    if (!cfPath || !cfToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path or token' }));
      return;
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const options = {
        hostname: 'api.cloudflare.com',
        path:     `/client/v4${cfPath}`,
        method:   req.method === 'PATCH' ? 'PATCH' : 'GET',
        headers: {
          'Authorization': `Bearer ${cfToken}`,
          'Content-Type':  'application/json',
          'User-Agent':    'Uptracker-DevServer/1.0',
        },
      };

      if (body && req.method === 'PATCH') {
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const cfReq = https.request(options, (cfRes) => {
        let data = '';
        cfRes.on('data', c => data += c);
        cfRes.on('end', () => {
          res.writeHead(cfRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      cfReq.on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      if (body && req.method === 'PATCH') cfReq.write(body);
      cfReq.end();
    });
    return;
  }

  // ── Static file serving ──────────────────────
  const filePath = path.join(__dirname, 'public',
    parsed.pathname === '/' ? 'index.html' : parsed.pathname);

  try {
    const data = fs.readFileSync(filePath);
    const ext  = filePath.split('.').pop();
    res.writeHead(200, {
      'Content-Type':  MIME[ext] || 'text/plain',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + parsed.pathname);
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Uptracker dev server running at http://localhost:${PORT}`);
  console.log(`   Cloudflare API proxy: http://localhost:${PORT}/cf-proxy?path=/zones/...`);
  console.log(`   Press Ctrl+C to stop\n`);
});
