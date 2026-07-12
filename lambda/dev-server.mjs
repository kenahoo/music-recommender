// Local dev server for the Music Advisor Lambda.
//
//   node dev-server.mjs         →  http://localhost:3000   (set PORT to change)
//
// It runs the real index.mjs handler, so /api/* behaves exactly like production:
// it reads/commits listening-log.md on GitHub and calls Claude for real. Secrets
// come from the environment, falling back to terraform/terraform.tfvars so it just
// works with your existing config.
//
// GET / re-reads index.html on every request, so you can edit the UI and simply
// refresh the browser — no restart needed. (Restart only when you change index.mjs.)
//
// Note: clicking Commit here writes to the real GitHub repo, same as production.

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { networkInterfaces } from 'os';

loadEnv();

// Imported after loadEnv(): index.mjs constructs the Anthropic client at load
// time, which needs ANTHROPIC_API_KEY to already be set.
const { handler } = await import('./index.mjs');

const INDEX_HTML = new URL('./index.html', import.meta.url);
const PORT = process.env.PORT || 3000;

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Serve fresh HTML so UI edits appear on refresh without restarting.
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync(INDEX_HTML, 'utf-8'));
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);

  // Shape the request like an API Gateway / Function URL v2 event.
  const event = {
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: req.headers, // Node lowercases header names, matching the handler
    requestContext: { http: { method: req.method } },
    body: chunks.length ? Buffer.concat(chunks).toString('utf-8') : undefined,
    isBase64Encoded: false,
  };
  const context = { logGroupName: '/aws/lambda/local', logStreamName: 'local' };

  try {
    const result = await handler(event, context);
    res.writeHead(result.statusCode || 200, result.headers || {});
    res.end(result.body || '');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(PORT, () => {
  console.log('Music Advisor (local):');
  console.log(`  → http://localhost:${PORT}`);
  const ip = lanIP();
  if (ip) console.log(`  → http://${ip}:${PORT}   (same LAN — e.g. your phone)`);
});

// First non-internal IPv4 address (usually your Wi-Fi/LAN IP).
function lanIP() {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface || []) {
      if (!net.internal && (net.family === 'IPv4' || net.family === 4)) return net.address;
    }
  }
  return null;
}

// Populate process.env from the environment, falling back to terraform.tfvars.
function loadEnv() {
  const map = {
    APP_PASSWORD: 'app_password',
    ANTHROPIC_API_KEY: 'anthropic_api_key',
    GITHUB_TOKEN: 'github_token',
    GITHUB_REPO: 'github_repo',
  };
  let tfvars = '';
  try {
    tfvars = readFileSync(new URL('../terraform/terraform.tfvars', import.meta.url), 'utf-8');
  } catch { /* no tfvars — rely on environment variables */ }
  for (const [envKey, tfKey] of Object.entries(map)) {
    if (process.env[envKey]) continue;
    const m = tfvars.match(new RegExp(`^\\s*${tfKey}\\s*=\\s*"([^"]*)"`, 'm'));
    if (m) process.env[envKey] = m[1];
  }
  process.env.AWS_REGION ||= 'us-east-1';
  process.env.AWS_LAMBDA_FUNCTION_NAME ||= 'music-recommend';
}
