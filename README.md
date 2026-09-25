# Meshtime

A small self-hosted web app for a group of friends:

- **Calendar**: click a day to say you're free. Everyone's free days are overlaid, and the group can add events.
- **Polls**: propose a few dates, everyone answers yes / maybe / no. When everyone has answered (or the creator closes it), the best date is shown with an **Add to calendar** button.
- **Passkeys**: add one in Settings and log in with a fingerprint, face or device PIN instead of a password.
- **Calendar feeds**: each member gets private ICS links to subscribe from Google Calendar, Apple Calendar or Outlook. No OAuth, no API keys.

Zero npm dependencies: Node 26 built-ins only (`node:http`, `node:sqlite`, `node:crypto`) — passkeys included.

## Run locally

```sh
node --version   # >= 24
npm start        # http://localhost:3000, database in ./data/app.db
```

On first start the console prints a one-time **admin invite link**. Open it, pick a name and password. Then go to **Settings → Create invite link** to invite friends (links last 7 days, single use).

```sh
npm test         # unit tests for date validation, poll ranking, ICS output, passkey verification
```

## Deploy with Docker + HTTPS

Requires a domain pointing at the server and ports 80/443 open. Caddy obtains the TLS certificate automatically.

```sh
echo "DOMAIN=cal.example.com" > .env
docker compose up -d --build
docker compose logs app     # shows the first admin invite link
```

The SQLite database lives in the `data` volume. Back it up with:

```sh
docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/data/app.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp app:/data/backup.db ./backup.db
```

Environment variables: `BASE_URL` (public https URL, required behind a proxy), `DB_PATH`, `PORT`, `NODE_ENV=production` (sets the `Secure` cookie flag).

## Subscribing to the feeds

Settings shows two links per member: **Group events** and **Who is free**.

| App | How | Refresh |
|---|---|---|
| Google Calendar (web) | Other calendars → **+** → *From URL* → paste the https link | every 12–24 h, cannot be forced |
| Apple Calendar | click the *webcal* link, or File → *New Calendar Subscription* | pick the interval when subscribing |
| Outlook (web) | Add calendar → *Subscribe from web* → paste the https link | every few hours |

Anyone with a link can read the feed. **Rotate feed links** in Settings invalidates the old ones (you then re-subscribe).

## Forgot password

An admin opens Settings → Members → *create reset-password link* and sends it to the member.

## Security notes

- Passwords hashed with scrypt; sessions are random 256-bit ids stored hashed; cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Passkeys (WebAuthn) are verified in-process against the credential's stored public key: origin, relying-party id and user-presence are all checked, and every challenge is single-use so a captured login cannot be replayed. No attestation is requested or trusted.
- Passkeys are bound to `BASE_URL`. Reaching the app on a LAN IP or a different hostname offers password login only — that origin check is the spec's anti-phishing guarantee and is deliberately strict.
- Every POST must come from the app's own origin (CSRF), bodies are capped at 16 KB, all SQL is parameterized, all output is HTML-escaped.
- Strict `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`; HSTS is set by Caddy.
- Login is rate-limited globally (20 failures per 15 minutes). The feed links are the only unauthenticated routes.
- The container runs as the unprivileged `node` user.
