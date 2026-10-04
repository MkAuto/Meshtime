# Meshtime

A small self-hosted web app for a group of friends:

- **Calendar**: click a day to say you're free (hold it on a phone, or double-click it, for just the morning, afternoon or evening). Everyone's free days are overlaid, and the group can add events: all day or with times, over one day or several, in a color of their choice.
- **Polls**: propose a few dates, everyone answers yes / maybe / no. When everyone has answered (or the creator closes it), the best date is shown with an **Add to calendar** button.
- **Birthdays**: give yours in Profile and it shows on everyone's calendar every year (each member can hide them in Settings).
- **Passkeys**: add one in Profile and log in with a fingerprint, face or device PIN instead of a password.
- **Calendar feeds**: each member gets private ICS links to subscribe from Google Calendar, Apple Calendar or Outlook. No OAuth, no API keys.

One npm dependency, [`mustache`](https://github.com/janl/mustache.js) for the HTML templates in `src/templates/`. Everything else is Node built-ins (`node:http`, `node:sqlite`, `node:crypto`), passkeys included.

## Run locally

```sh
node --version   # >= 24
npm install      # once, and again after pulling a change to package.json
npm start        # http://localhost:3000, database in ./data/app.db
```

On first start the console prints a one-time **admin invite link**. Open it, pick a name and password. Then go to **Administration → Create invite link** to invite friends (links last 7 days, single use). The Administration page is only shown to admins; Profile holds your name, birthday, color, password and passkeys; Settings holds calendar feeds and display preferences.

```sh
npm test         # unit tests: date and event validation, poll ranking, ICS output, passkey verification, page rendering
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

Settings → *Calendar feeds* lists one events feed per group you are in (the events created by that group's members, with a *Copy* button; each group's panel on the **Groups** page shows its own too), and the **Birthdays** feed (each member's birthday from their Profile, repeating every year).

| App | How | Refresh |
|---|---|---|
| Google Calendar (web) | Other calendars → **+** → *From URL* → paste the https link | every 12–24 h, cannot be forced |
| Apple Calendar | click the *webcal* link, or File → *New Calendar Subscription* | pick the interval when subscribing |
| Outlook (web) | Add calendar → *Subscribe from web* → paste the https link | every few hours |

Anyone with the link can read the feed. **Rotate all feed links** in Settings invalidates every one of your feed links at once (you then re-subscribe). A group's feed also stops working when you leave that group.

## Forgot password

An admin opens **Administration** → Members → *create reset-password link* and sends it to the member. Using it logs out every device and removes the member's passkeys, so anything an intruder left on the account stops working; passkeys are re-added in Profile.

## Removing a member

**Administration** → Members → *remove*. Their sessions, passkeys, votes, free days and feed links stop working at once. Events they created are deleted (so they never reach a wider audience); polls they created are re-owned by the admin who removed them. A group they created passes to its longest-standing remaining member, and a group left empty is deleted.

## Security notes

- Passwords hashed with scrypt; sessions are random 256-bit ids stored hashed; cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Passkeys (WebAuthn) are verified in-process against the credential's stored public key: origin, relying-party id and user-presence are all checked, and every challenge is single-use so a captured login cannot be replayed. No attestation is requested or trusted.
- Passkeys are bound to `BASE_URL`. Reaching the app on a LAN IP or a different hostname offers password login only — that origin check is the spec's anti-phishing guarantee and is deliberately strict.
- Every POST must come from the app's own origin (CSRF), bodies are capped at 16 KB, all SQL is parameterized, all output is HTML-escaped.
- Strict `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`; HSTS is set by Caddy.
- Login is rate-limited per client address (20 failures per 15 minutes) and per account (10), with a global backstop of 500. The feed links are the only unauthenticated routes.
- The container runs as the unprivileged `node` user.
