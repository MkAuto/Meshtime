import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { db, get, now } from './db.js';
import { userFromSession, createInvite } from './auth.js';
import { routes } from './routes.js';
import { errorPage } from './views.js';
import { BASE_URL } from './lib.js';

const PORT = Number(process.env.PORT || 3000);
// CSRF: the browser sets Host to the target and Origin to the page that sent the form; they must match.
// Comparing against Host (not BASE_URL) keeps localhost / 127.0.0.1 / LAN access working.
// Prefer Sec-Fetch-Site (always sent by Chromium/Firefox/Safari); privacy shields sometimes strip Origin/Referer.
function sameOrigin(req) {
  const h = req.headers, site = h['sec-fetch-site'];
  let ok;
  if (site) ok = site === 'same-origin' || site === 'none';
  else { try { ok = new URL(h.origin || h.referer).host === h.host; } catch { ok = false; } }
  if (!ok) console.warn('Rejected cross-origin POST', { host: h.host, origin: h.origin, referer: h.referer, 'sec-fetch-site': site });
  return ok;
}
const PROD = process.env.NODE_ENV === 'production';
const MAX_BODY = 16 * 1024;
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// Static files are whitelisted at startup: no path traversal possible.
const PUBLIC = join(import.meta.dirname, '..', 'public');
const STATIC = new Map(readdirSync(PUBLIC).map(f => ['/' + f, { body: readFileSync(join(PUBLIC, f)), type: TYPES[extname(f)] || 'application/octet-stream' }]));

const parseCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(([k, val]) => k && val));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large.'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString())));
    req.on('error', reject);
  });
}

function makeCtx(req, res, url) {
  const head = req.method === 'HEAD';
  return {
    req, res, url, params: {}, user: null, body: null, sid: null,
    html(str, status = 200) { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(head ? undefined : str); },
    text(str, status = 200, headers = {}) { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }); res.end(head ? undefined : str); },
    redirect(path) { res.writeHead(303, { Location: path }); res.end(); },
    setCookie(name, value, maxAge) { res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`); },
    fail(status, msg) { this.html(errorPage(status, msg, this.user), status); },
  };
}

async function handle(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url, BASE_URL);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const ctx = makeCtx(req, res, url);
  try {
    if (method === 'GET' && STATIC.has(url.pathname)) {
      const s = STATIC.get(url.pathname);
      res.writeHead(200, { 'Content-Type': s.type, 'Cache-Control': 'public, max-age=3600' });
      return res.end(req.method === 'HEAD' ? undefined : s.body);
    }
    if (method === 'POST') { // SameSite=Lax cookie + same-origin check on every mutation
      if (!sameOrigin(req)) return ctx.fail(403, 'Cross-origin request rejected.');
      if (!(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return ctx.fail(415, 'Unsupported content type.');
      ctx.body = await readBody(req);
    }
    ctx.sid = parseCookies(req).sid || null;
    ctx.user = userFromSession(ctx.sid) || null;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = url.pathname.match(r.path);
      if (!m) continue;
      ctx.params = m.groups || {};
      if (!r.public && !ctx.user) return method === 'GET' ? ctx.redirect('/login') : ctx.fail(401, 'Please log in.');
      return await r.handler(ctx);
    }
    ctx.fail(404, 'Page not found.');
  } catch (err) {
    if (res.headersSent) return res.end();
    if (!err.status) console.error(err);
    ctx.fail(err.status || 500, err.status ? err.message : 'Something went wrong.');
  }
}

function bootstrap() {
  if (get('SELECT 1 FROM users LIMIT 1')) return;
  const inv = get('SELECT token FROM invites WHERE is_admin = 1 AND used_at IS NULL AND expires_at > ?', now());
  const token = inv?.token || createInvite({ isAdmin: 1 });
  console.log(`\nNo users yet. Open this link to create the first (admin) account:\n  ${BASE_URL}/invite/${token}\n`);
}

const server = createServer((req, res) => handle(req, res));
server.listen(PORT, () => { console.log(`Free Days listening on :${PORT} as ${BASE_URL}`); bootstrap(); });
const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
