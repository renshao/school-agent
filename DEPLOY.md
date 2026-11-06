# Deploying the web chat (school.shao.io)

One small Node process behind Caddy on a droplet. Caddy terminates TLS (automatic Let's Encrypt); the app listens on
`127.0.0.1:8080` only. State is one SQLite file plus the Flexischools token cache, both in `.state/`.

## 1. Google sign-in (once)

In the Google Cloud Console (any project, e.g. "school-agent"):

1. **APIs & Services → OAuth consent screen.** If `shao.io` is a Google Workspace domain, choose **Internal** (only
   accounts in the domain can sign in, no review). Otherwise choose **External**, leave it in **Testing**, and add
   the addresses from `ALLOWED_USERS` as test users. Scopes: `openid`, `email`, `profile` (no sensitive scopes, so no
   verification is needed).
2. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorized redirect URIs:
   - `https://school.shao.io/auth/google/callback`
   - `http://localhost:8080/auth/google/callback` (optional, for running it on your Mac)
3. Copy the client ID and secret into the env file below.

The app's own allowlist (`ALLOWED_USERS`) decides who gets in, whatever the consent screen allows.

## 2. DNS

An `A` record (and `AAAA` if the droplet has IPv6) for `school.shao.io` pointing at the droplet.

## 3. The droplet

```sh
# Node 24+ (26 recommended), Caddy, git
sudo useradd --system --create-home --home-dir /opt/school-agent school
sudo -u school git clone <repo> /opt/school-agent/app
cd /opt/school-agent/app && sudo -u school npm ci --omit=dev     # no build step: Node runs the .ts directly
```

`/opt/school-agent/app/.env` (owner `school`, mode `0600`):

```sh
FLEXISCHOOL_USERNAME=...
FLEXISCHOOL_PASSWORD=...
ANTHROPIC_API_KEY=...
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
PUBLIC_URL=https://school.shao.io
ALLOWED_USERS=you@example.com=Ren,partner@example.com=Eva    # email=display name, comma-separated
PORT=8080
# optional: AGENT_MODEL, AGENT_EFFORT, TODAY_SERVICES (regex, default "lunch"), SCHOOL_DB
```

`/etc/systemd/system/school-agent.service`:

```ini
[Unit]
Description=School agent web chat
After=network-online.target
Wants=network-online.target

[Service]
User=school
WorkingDirectory=/opt/school-agent/app
ExecStart=/usr/bin/node --env-file=.env src/web.ts
Restart=on-failure
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/school-agent/app/.state

[Install]
WantedBy=multi-user.target
```

```sh
sudo -u school mkdir -m 700 /opt/school-agent/app/.state
sudo systemctl daemon-reload && sudo systemctl enable --now school-agent
journalctl -u school-agent -f      # "school-agent web on http://127.0.0.1:8080 (public https://school.shao.io) ..."
```

`/etc/caddy/Caddyfile`:

```
school.shao.io {
	reverse_proxy 127.0.0.1:8080
}
```

`sudo systemctl reload caddy`. Caddy streams `text/event-stream` responses without buffering, so the live updates work
as is. Do not add `encode` to this site (compression can buffer the event stream).

## 4. Use it

Open https://school.shao.io, sign in with Google. On an iPhone, Share → **Add to Home Screen** makes it an app (and is
what Web Push will need later).

## Updating

```sh
cd /opt/school-agent/app && sudo -u school git pull && sudo -u school npm ci --omit=dev && sudo systemctl restart school-agent
```

Chat history survives restarts. Proposals waiting for approval do not (by design): they show as expired; ask again.

## Backups

Everything worth keeping is `.state/school.db` (history, sessions). A consistent copy while running:
`sqlite3 /opt/school-agent/app/.state/school.db ".backup /some/backup/school-$(date +%F).db"` (cron it, or use
Litestream later). Losing it loses chat history only; orders live in Flexischools.

## Security notes

- Only allowlisted, Google-verified emails get a session; sessions last 30 days (`__Host-` cookie, HttpOnly, Secure,
  SameSite=Lax; only a hash is stored). Sign out deletes it.
- The app binds to 127.0.0.1; only Caddy is exposed. Keep the droplet firewall to 22/80/443.
- `DEV_LOGIN=1` refuses to start unless `PUBLIC_URL` is localhost.
- Approve / Reject are the only paths that spend money, and they need a signed-in human (the model cannot reach them).
