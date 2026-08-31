/**
 * Uptracker — Cloudflare API Proxy
 * Netlify Function: /.netlify/functions/cf-proxy
 *
 * Proxies Cloudflare API calls server-side to avoid CORS.
 * Used by the dashboard UI for "Test Connection" button.
 * The real failover logic runs in monitor.js — this is UI-only.
 *
 * Request format:
 *   POST /.netlify/functions/cf-proxy
 *   Body: { path: "/zones/.../dns_records/...", token: "cfut_...", method: "GET"|"PATCH", body?: {} }
 */

'use strict';

const https = require('https');

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { path, token, method = 'GET', body } = payload;

  if (!path || !token) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields: path, token' }),
    };
  }

  // Validate path — only allow Cloudflare DNS record endpoints
  if (!path.startsWith('/zones/') || !path.includes('/dns_records')) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Only DNS record paths are allowed' }),
    };
  }

  try {
    const result = await cfRequest(token, path, method, body);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

function cfRequest(token, path, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path:     `/client/v4${path}`,
      method:   method.toUpperCase(),
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Uptracker/4',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
