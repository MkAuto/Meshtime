import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { db, get, now } from './db.js';
import { userFromSession, createInvite } from './auth.js';
import { routes } from './routes.js';
import { errorPage } from './views.js';
import { BASE_URL } from './lib.js';

const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const MAX_BODY = 16 * 1024;

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// public/ is read once at startup into a "/name" -> file map, so no request can walk the filesystem.
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const STATIC_FILES = new Map(readdirSync(PUBLIC_DIR).map(name => ['/' + name, {
  body: readFileSync(join(PUBLIC_DIR, name)),
  type: CONTENT_TYPES[extname(name)] || 'application/octet-stream',
}]));

// ---- CSRF ----
// The browser sets Host to the target and Origin to the page that sent the form; they must match.
// Comparing against Host (not BASE_URL) keeps localhost / 127.0.0.1 / LAN access working.
// Prefer Sec-Fetch-Site (always sent by Chromium/Firefox/Safari); privacy shields sometimes strip Origin/Referer.
function isSameOrigin(req) {
  const { host, origin, referer, 'sec-fetch-site': fetchSite } = req.headers;
  let ok;
  if (fetchSite) {
    ok = fetchSite === 'same-origin' || fetchSite === 'none';
  } else {
    try { ok = new URL(origin || referer).host === host; }
    catch { ok = false; } // absent or unparseable: treat as cross-origin
  }
  if (!ok) console.warn('Rejected cross-origin POST', { host, origin, referer, 'sec-fetch-site': fetchSite });
  return ok;
}

// ---- request plumbing ----

const parseCookies = req => Object.fromEntries((req.headers.cookie || '')
  .split(';')
  .map(pair => pair.trim().split('='))
  .filter(([name, value]) => name && value));

/** Resolves to the form body as URLSearchParams. Rejects with status 413 past MAX_BODY. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString())));
    req.on('error', reject);
  });
}

/** The ctx object every route handler in routes.js receives. */
function makeCtx(req, res, url) {
  const isHead = req.method === 'HEAD'; // same headers as GET, but no body may be sent
  return {
    req,
    res,
    url,
    params: {},  // named groups captured by the route regex
    user: null,  // the users row, or null when not logged in
    body: null,  // URLSearchParams on POST
    sid: null,   // raw session cookie value

    html(body, status = 200) {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(isHead ? undefined : body);
    },
    text(body, status = 200, headers = {}) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(isHead ? undefined : body);
    },
    json(obj, status = 200) {
      this.text(JSON.stringify(obj), status, { 'Content-Type': 'application/json' });
    },
    redirect(path) {
      res.writeHead(303, { Location: path });
      res.end();
    },
    setCookie(name, value, maxAge) {
      res.setHeader('Set-Cookie',
        `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`);
    },
    fail(status, msg) {
      this.html(errorPage(status, msg, this.user), status);
    },
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
    if (method === 'GET' && STATIC_FILES.has(url.pathname)) {
      const file = STATIC_FILES.get(url.pathname);
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=3600' });
      return res.end(req.method === 'HEAD' ? undefined : file.body);
    }

    if (method === 'POST') { // every mutation: SameSite=Lax cookie + same-origin check
      if (!isSameOrigin(req)) return ctx.fail(403, 'Cross-origin request rejected.');
      if (!(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded'))
        return ctx.fail(415, 'Unsupported content type.');
      ctx.body = await readBody(req);
    }

    ctx.sid = parseCookies(req).sid || null;
    ctx.user = userFromSession(ctx.sid) || null;

    const route = routes.find(r => r.method === method && r.path.test(url.pathname));
    if (!route) return ctx.fail(404, 'Page not found.');

    ctx.params = url.pathname.match(route.path).groups || {};
    if (!route.public && !ctx.user)
      return method === 'GET' ? ctx.redirect('/login') : ctx.fail(401, 'Please log in.');
    return await route.handler(ctx);
  } catch (err) {
    if (res.headersSent) return res.end();
    // err.status means we threw it deliberately and the message is safe to show.
    if (!err.status) console.error(err);
    ctx.fail(err.status || 500, err.status ? err.message : 'Something went wrong.');
  }
}

/** First run: print an invite link for the admin account. Reuses an unused one across restarts. */
function printFirstAdminInvite() {
  if (get('SELECT 1 FROM users LIMIT 1')) return;
  const existing = get('SELECT token FROM invites WHERE is_admin = 1 AND used_at IS NULL AND expires_at > ?', now());
  const inviteToken = existing?.token || createInvite({ isAdmin: 1 });
  console.log(`\nNo users yet. Open this link to create the first (admin) account:\n  ${BASE_URL}/invite/${inviteToken}\n`);
}

const server = createServer(handle);
server.listen(PORT, () => {
  console.log(`Meshtime listening on :${PORT} as ${BASE_URL}`);
  printFirstAdminInvite();
});

const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
