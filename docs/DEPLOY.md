# Deploying to an Ubuntu server

*O'zbekcha: [DEPLOY.uz.md](./DEPLOY.uz.md)*

Target: **Ubuntu 22.04 / 24.04 LTS**. The result is a systemd-managed service
listening on `127.0.0.1:3000`, fronted by **nginx** with **HTTPS** (Let's
Encrypt), backed by **PostgreSQL**, with uploaded images on local disk.

```
Browser ──HTTPS──▶ nginx (:443) ──HTTP──▶ portal (127.0.0.1:3000) ──▶ PostgreSQL
                                                     │
                                                     └──▶ /opt/portal/uploads
```

Three ways to get there:

- **Build on the server** (simplest; needs ~2 GB RAM + swap). Steps 1–11 below.
- **Build elsewhere and copy artifacts** (keeps the server lean). See
  [Appendix A](#appendix-a--build-on-another-machine).
- **Docker**, if you would rather not install Rust and Node on the host at
  all. See [Appendix C](#appendix-c--docker).

Throughout, replace `kb.example.com` with your domain and choose strong
passwords.

---

## 1. System packages

```sh
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev curl git \
                    postgresql nginx nodejs npm \
                    certbot python3-certbot-nginx
```

`nodejs` builds the React frontend; `npm` comes with it on Ubuntu's package.
Check the version — the frontend needs **Node 20 or newer**, and Ubuntu 22.04
ships 12 by default:

```sh
node --version   # v20+ ; if older, install from https://deb.nodesource.com
```

## 2. PostgreSQL: database and role

```sh
sudo -u postgres psql <<'SQL'
CREATE ROLE portal WITH LOGIN PASSWORD 'CHANGE_ME_DB_PASSWORD';
CREATE DATABASE portal OWNER portal;
SQL
```

The app connects over TCP to `localhost:5432`. Schema **migrations run
automatically** on first startup (they are compiled into the binary), so you do
not need to run them by hand.

Connection string (used later in the env file):

```
DATABASE_URL=postgres://portal:CHANGE_ME_DB_PASSWORD@localhost:5432/portal
```

## 3. Toolchain (build-on-server)

The Rust toolchain version is pinned to the one the `Dockerfile` uses as a
build arg; keep the two in step if you change it.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
rustup toolchain install 1.96 && rustup default 1.96
```

That is all the backend needs — it is a plain server binary, with no wasm
target and no cargo-leptos. The frontend needs only the `nodejs`/`npm` from
step 1.

Low-RAM servers: add swap before building so the linker doesn't get OOM-killed.

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Production build

Both halves, in either order:

```sh
git clone <your-repo-url> portal && cd portal

# The single-page app → frontend/dist
cd frontend && npm ci && npm run build && cd ..

# The server binary → backend/target/release/portal
cd backend && cargo build --release && cd ..
```

`npm run build` runs `tsc -b` first, so a type error stops the build rather
than shipping a bundle nobody type-checked.

> Nothing here needs editing before a TLS deployment. The `Secure` flag on the
> session cookie is `SECURE_COOKIE=1` in the environment file (step 6), not a
> line of source you have to remember to change and remember to change back.

## 5. Install into /opt/portal

```sh
sudo useradd --system --create-home --home-dir /opt/portal --shell /usr/sbin/nologin portal || true
sudo install -m755 backend/target/release/portal /opt/portal/portal
sudo rm -rf /opt/portal/static && sudo cp -r frontend/dist /opt/portal/static
sudo mkdir -p /opt/portal/uploads
sudo chown -R portal:portal /opt/portal
```

Final layout:

```
/opt/portal/
├── portal          # binary
├── static/         # STATIC_DIR — the built SPA (index.html + assets/)
├── uploads/        # user-uploaded images (persistent)
└── portal.env      # created next
```

## 6. Environment file

Create `/opt/portal/portal.env` (systemd reads it as plain `KEY=VALUE`, no
quoting or shell expansion):

```ini
# --- App ---
DATABASE_URL=postgres://portal:CHANGE_ME_DB_PASSWORD@localhost:5432/portal
ADMIN_USERNAME=admin
ADMIN_PASSWORD=CHANGE_ME_ADMIN_PASSWORD
UPLOADS_DIR=/opt/portal/uploads
MAX_UPLOAD_BYTES=5242880

# --- Server ---
BIND_ADDR=127.0.0.1:3000
# Resolved relative to WorkingDirectory → /opt/portal/static
STATIC_DIR=static
# The session cookie only travels over HTTPS (SR-2). Set this before you put
# the site behind TLS, not after.
SECURE_COOKIE=1
RUST_LOG=info

# CORS_ORIGINS is deliberately absent. The SPA is served from this same
# origin, so no cross-origin request exists; setting it would only widen where
# the session cookie may be sent from.
```

```sh
sudo chown portal:portal /opt/portal/portal.env
sudo chmod 600 /opt/portal/portal.env
```

`ADMIN_USERNAME`/`ADMIN_PASSWORD` seed the first admin **only when the `users`
table is empty**. Log in and change the password, then you may remove them.

## 7. systemd service

Create `/etc/systemd/system/portal.service`:

```ini
[Unit]
Description=Portal Knowledge Base
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=portal
Group=portal
WorkingDirectory=/opt/portal
EnvironmentFile=/opt/portal/portal.env
ExecStart=/opt/portal/portal
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/portal/uploads

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory=/opt/portal` is important: `STATIC_DIR=static` is resolved
relative to it (→ `/opt/portal/static`).

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now portal
sudo systemctl status portal
journalctl -u portal -f          # watch logs; expect "listening on http://127.0.0.1:3000"
```

Quick local check on the box:

```sh
curl -s http://127.0.0.1:3000/api/health                                # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login    # 200 (the SPA)
```

The first answers even while Postgres is down, which is what makes it useful
for telling "the service is dead" apart from "the database is".

## 8. nginx reverse proxy

Create `/etc/nginx/sites-available/portal`:

```nginx
server {
    listen 80;
    server_name kb.example.com;

    # Allow 5 MB image uploads (a little headroom over MAX_UPLOAD_BYTES).
    client_max_body_size 6M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

One `location /` is enough — no SPA rewrite rule. The backend already falls
back to `index.html` for any path it does not recognise, so a deep link like
`/docs/<id>/edit` reaches the client router. Adding a `try_files` rule here
would only put a second, competing router in front of it. Enable it:

```sh
sudo ln -s /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/portal
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## 9. HTTPS with Let's Encrypt

Point `kb.example.com` DNS at the server first, then:

```sh
sudo certbot --nginx -d kb.example.com
```

Certbot adds the `443` server block and an HTTP→HTTPS redirect, and installs a
renewal timer. With `SECURE_COOKIE=1` in `portal.env`, cookies now flow only
over HTTPS.

## 10. Firewall

```sh
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Ports `3000` (app) and `5432` (Postgres) stay bound to localhost and are not
exposed.

## 11. First login

Open `https://kb.example.com/login`, sign in as the seed admin, then:

- create categories at `/categories` — do this **first**, because permissions
  are granted per category and there is nothing to grant until they exist;
- go to `/admin/users` and create real users, ticking the Read/Write/Edit/Delete
  boxes on each category they should reach. A new non-admin user with no grants
  can log in and see an empty platform;
- reset or rotate the admin password.

---

## Updating / redeploying

```sh
cd ~/portal && git pull
(cd frontend && npm ci && npm run build)
(cd backend && cargo build --release)
sudo systemctl stop portal
sudo install -m755 backend/target/release/portal /opt/portal/portal
sudo rm -rf /opt/portal/static && sudo cp -r frontend/dist /opt/portal/static
sudo chown -R portal:portal /opt/portal/static /opt/portal/portal
sudo systemctl start portal
```

New migrations in `backend/migrations/` are applied automatically on start.

> **Sessions reset on restart.** The app uses an in-memory session store, so
> every redeploy logs users out. That's fine for a single instance; to keep
> sessions (and to run more than one instance) switch to a Postgres-backed store
> — see [Appendix B](#appendix-b--persistent-sessions-recommended-for-production).

## Backups

Database (nightly, keep 14 days):

```sh
sudo -u postgres sh -c 'pg_dump portal | gzip > /var/backups/portal-$(date +\%F).sql.gz'
```

Uploaded images live in `/opt/portal/uploads` — back that directory up too
(e.g. `rsync`/`restic`). Add both to cron or a systemd timer.

---

## Appendix A — build on another machine

Build on any Linux box (or CI) with the same toolchain from step 3, then copy
just the two artifacts. The binary is dynamically linked against glibc/OpenSSL,
so build on an OS with the **same or older** glibc than the server (building on
Ubuntu of the same release is safest).

```sh
(cd frontend && npm ci && npm run build)
(cd backend && cargo build --release)
scp backend/target/release/portal  user@server:/tmp/portal
rsync -a --delete frontend/dist/   user@server:/tmp/static/
```

On the server, move them into place as in step 5 and restart the service. For a
fully static binary you could instead build for
`x86_64-unknown-linux-musl`, which avoids glibc-version mismatches.

## Appendix B — persistent sessions (recommended for production)

Replace the in-memory store with the SQLx Postgres store so sessions survive
restarts and can be shared across instances.

1. Add the dependency in `backend/Cargo.toml`:

   ```toml
   tower-sessions-sqlx-store = { version = "0.14", features = ["postgres"] }
   ```

2. In `backend/src/main.rs`, swap `MemoryStore` for the Postgres store and
   run its migration once at startup:

   ```rust
   use tower_sessions_sqlx_store::PostgresStore;

   let session_store = PostgresStore::new(state.pool.clone());
   session_store.migrate().await.expect("session store migrate");
   let session_layer = SessionManagerLayer::new(session_store)
       .with_http_only(true)
       .with_same_site(SameSite::Lax)
       // Still from the environment — do not hardcode it here either.
       .with_secure(config.secure_cookie);
   ```

3. Rebuild and redeploy.

## Appendix C — Docker

The repository ships a multi-stage `Dockerfile` (Rust builder → `bookworm-slim`
runtime, non-root, `/app/uploads` as a volume) and a `docker-compose.yml` that
pairs it with PostgreSQL. Nothing needs a Rust toolchain on the host, and the
version pins from step 3 are build args inside the image, so they cannot drift
out of step with what you install by hand.

```sh
docker compose up --build -d
docker compose logs -f app
```

Configuration is entirely `PORTAL_*` variables with defaults — set at minimum:

```sh
PORTAL_DB_PASSWORD=… PORTAL_ADMIN_PASSWORD=… docker compose up -d
```

Compose deliberately never reads the project's `.env` (its values point at the
local dev cluster on port 5433 and would be wrong inside a container), which is
why the variables are namespaced. Two named volumes hold the state: `pgdata`
and `uploads`. `docker compose down -v` deletes both.

To put this behind nginx and TLS, keep steps 8–10 and publish the app on
loopback only:

```yaml
    ports:
      - "127.0.0.1:3000:3000"
```

The container binds `0.0.0.0:3000` internally — a loopback bind inside a
container is unreachable from the host — so restrict it at the publish step, not
with `BIND_ADDR`. For `Secure` cookies set `PORTAL_SECURE_COOKIE=1` — no
rebuild, since it is read from the environment at startup.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Service exits immediately, log: `DATABASE_URL must be set` | `portal.env` missing/unreadable or `EnvironmentFile` path wrong. |
| Service exits immediately, log: `could not create the uploads directory` | `UPLOADS_DIR` not writable by the `portal` user, or missing from systemd's `ReadWritePaths`. |
| `failed to connect to Postgres` / `PoolTimedOut` | Wrong `DATABASE_URL`, role/password, or Postgres listening on another port. Test: `psql "$DATABASE_URL" -c '\q'`. |
| Blank page; the log says `no frontend build at 'static'` | `frontend/dist` was not copied to `/opt/portal/static`, or `STATIC_DIR`/`WorkingDirectory` disagree. |
| Page loads but every request 401s and login does nothing | `SECURE_COOKIE=1` while the site is served over plain HTTP — the browser accepts the cookie and never sends it back. Either finish the TLS setup or unset it. |
| The frontend build fails with a syntax error in `.ts`/`.tsx` | Node is too old. `node --version` must be v20+; Ubuntu 22.04's default is 12. |
| A frontend request returns HTML instead of JSON | nginx is answering a `/api/*` path itself. The proxy block must cover `/`, not just the SPA routes. |
| Uploads fail with 413 | Raise nginx `client_max_body_size` (and `MAX_UPLOAD_BYTES`). |
| Logged out after every deploy | Expected with the in-memory store — see Appendix B. |
| A user logs in but sees nothing at all | They have no category grants. Access comes only from the matrix at `/admin/users`; there are no global permission flags. |
