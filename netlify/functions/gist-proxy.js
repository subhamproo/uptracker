/**
 * Uptracker — GitHub Gist Proxy
 * Netlify Function: /.netlify/functions/gist-proxy
 *
 * Fetches the Gist data server-side (no CORS).
 * Used by the maintenance page to load live status.
 * The GitHub token comes from Netlify env vars, not the browser.
 *
 * POST body: { gistFile?: string }
 * Returns: raw parsed Gist JSON data
 */

'use strict';

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID      = process.env.GIST_ID;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  if (!GITHUB_TOKEN || !GIST_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let gistFile = 'uptracker_data.json';
  try {
    if (event.body) {
      const b = JSON.parse(event.body);
      if (b.gistFile) gistFile = b.gistFile;
    }
  } catch {}

  try {
    const data = await fetchGist(gistFile);
    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

function fetchGist(gistFile) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path:     `/gists/${GIST_ID}`,
      method:   'GET',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'Uptracker/4',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json    = JSON.parse(raw);
          const content = json.files?.[gistFile]?.content;
          if (!content) return reject(new Error('File not found in Gist'));
          resolve(JSON.parse(content));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
