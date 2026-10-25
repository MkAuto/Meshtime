import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { db, get, now } from './db.js';
import { userFromSession, sessionOwner, createInvite } from './auth.js';
import { logEvent } from './log.js';
import { routes } from './routes.js';
import { syncAll } from './sync.js';
import { errorPage } from './views.js';
import { BASE_URL, pickLanguage } from './lib.js';

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
  if (!ok) {
    console.warn('Rejected cross-origin POST', { host, origin, referer, 'sec-fetch-site': fetchSite });
  }
  return ok;
}

// ---- request plumbing ----

// Invite and feed links carry their secret token in the path: keep it out of errors.log.
const withoutSecrets = url => url.pathname.replace(/^\/(invite|feed)\/[\w-]+/, '/$1/<token>') + url.search;

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
        reject(Object.assign(new Error('errors.tooLarge'), { status: 413 }));
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
    lang: null,  // the language the answer is in (pickLanguage in lib.js)
    body: null,  // URLSearchParams on POST
    sid: null,   // raw session cookie value
    // Client address for rate limiting. Caddy sets X-Forwarded-For in production; only trust it there,
    // since anyone can send that header when they reach Node directly.
    ip: (PROD && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress,

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
    // `msg` is a key in src/locales (errors.*), shown in the visitor's language
    fail(status, msg) {
      this.html(errorPage(status, msg, this.user, { lang: this.lang, path: url.pathname + url.search }), status);
    },
  };
}

async function handle(req, res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const url = new URL(req.url, BASE_URL);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const ctx = makeCtx(req, res, url);
  const cookies = parseCookies(req);
  const acceptLanguage = req.headers['accept-language'];
  // Before anything can fail, so every error page is in it too; a logged-in member's own pick comes below.
  ctx.lang = pickLanguage(null, cookies.lang, acceptLanguage);

  try {
    if (method === 'GET' && STATIC_FILES.has(url.pathname)) {
      const file = STATIC_FILES.get(url.pathname);
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=3600' });
      return res.end(req.method === 'HEAD' ? undefined : file.body);
    }

    if (method === 'POST') { // every mutation: SameSite=Lax cookie + same-origin check
      if (!isSameOrigin(req)) {
        return ctx.fail(403, 'errors.crossOrigin');
      }
      if (!(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
        return ctx.fail(415, 'errors.contentType');
      }
      ctx.body = await readBody(req);
    }

    ctx.sid = cookies.sid || null;
    ctx.user = userFromSession(ctx.sid) || null;
    if (ctx.user) {
      ctx.user.hour12 = cookies.hour12 === '1'; // the device's clock, set by app.js: pages write times like it
      // their language (users.language, or the browser's) and the page asked for: views.js reads both from the user
      ctx.user.lang = ctx.lang = pickLanguage(ctx.user.language, cookies.lang, acceptLanguage);
      ctx.user.path = url.pathname + url.search;
    }
    if (ctx.sid && !ctx.user) {
      // A cookie with no live session: it expired, or a password change logged this device out.
      // Log it once, then clear the cookie so the next request does not log it again.
      const owner = sessionOwner(ctx.sid);
      logEvent({ ip: ctx.ip, user: owner ?? '(session gone)', known: Boolean(owner), action: 'session timeout' });
      ctx.setCookie('sid', '', 0);
    }

    const route = routes.find(r => r.method === method && r.path.test(url.pathname));
    if (!route) {
      return ctx.fail(404, 'errors.notFound');
    }

    ctx.params = url.pathname.match(route.path).groups || {};
    if (!route.public && !ctx.user) {
      return method === 'GET' ? ctx.redirect('/login') : ctx.fail(401, 'errors.logIn');
    }
    return await route.handler(ctx);
  } catch (err) {
    // err.status means we threw it deliberately and the message (a key in src/locales) is safe to show.
    // The rest is a bug: logged (and so in errors.log) with what is needed to reproduce it. Never the body,
    // which can hold a password.
    if (!err.status) {
      console.error(`Request failed: ${req.method} ${withoutSecrets(url)}`, {
        user: ctx.user ? { id: ctx.user.id, name: ctx.user.name } : null,
        ip: ctx.ip,
        userAgent: req.headers['user-agent'],
        referer: req.headers.referer,
        formFields: ctx.body ? [...ctx.body.keys()] : undefined,
      }, err);
    }
    if (res.headersSent) {
      return res.end();
    }
    ctx.fail(err.status || 500, err.status ? err.message : 'errors.generic');
  }
}

/** First run: print an invite link for the admin account. Reuses an unused one across restarts. */
function printFirstAdminInvite() {
  if (get('SELECT 1 FROM users LIMIT 1')) {
    return;
  }
  const existing = get('SELECT token FROM invites WHERE is_admin = 1 AND used_at IS NULL AND expires_at > ?', now());
  const inviteToken = existing?.token || createInvite({ isAdmin: 1 });
  console.log('\nNo users yet. Open this link to create the first (admin) account:');
  console.log(`  ${BASE_URL}/invite/${inviteToken}\n`);
}

const server = createServer(handle);
server.listen(PORT, () => {
  console.log(`Meshtime listening on :${PORT} as ${BASE_URL}`);
  printFirstAdminInvite();
});

// Calendar Integration: every member's own calendars are read at start and then every hour.
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
syncAll();
const syncTimer = setInterval(syncAll, SYNC_INTERVAL_MS);

const shutdown = () => {
  clearInterval(syncTimer);
  server.close(() => { db.close(); process.exit(0); });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
