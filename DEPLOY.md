# Deploying to an Ubuntu server

Target: **Ubuntu 22.04 / 24.04 LTS**. The result is a systemd-managed service
listening on `127.0.0.1:3000`, fronted by **nginx** with **HTTPS** (Let's
Encrypt), backed by **PostgreSQL**, with uploaded images on local disk.

```
Browser ──HTTPS──▶ nginx (:443) ──HTTP──▶ portal (127.0.0.1:3000) ──▶ PostgreSQL
                                                     │
                                                     └──▶ /opt/portal/uploads
```

Two ways to produce the binary:

- **Build on the server** (simplest; needs ~2 GB RAM + swap). Steps 3–4.
- **Build elsewhere and copy artifacts** (keeps the server lean). See
  [Appendix A](#appendix-a--build-on-another-machine).

Throughout, replace `kb.example.com` with your domain and choose strong
passwords.

---

## 1. System packages

```sh
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev curl git \
                    postgresql nginx binaryen \
                    certbot python3-certbot-nginx
```

`binaryen` provides `wasm-opt`, used by the release wasm build.

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

Install Rust and the exact tools the project needs. Versions matter:
`wasm-bindgen-cli` **must** match the `wasm-bindgen` version pinned in
`Cargo.toml` (currently `0.2.121`).

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
cargo install cargo-leptos --locked
cargo install wasm-bindgen-cli --version 0.2.121 --locked
```

> If you bump `wasm-bindgen` in `Cargo.toml`, reinstall `wasm-bindgen-cli` at the
> same version.

Low-RAM servers: add swap before building so the linker doesn't get OOM-killed.

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Production build

Before building for HTTPS, make the session cookie `Secure` (it is `false` for
local HTTP dev). In `src/main.rs`:

```rust
let session_layer = SessionManagerLayer::new(MemoryStore::default())
    .with_http_only(true)
    .with_same_site(SameSite::Lax)
    .with_secure(true);   // was false — enable behind TLS (SR-2)
```

Then build:

```sh
git clone <your-repo-url> portal && cd portal
cargo leptos build --release
```

This produces:

- `target/release/portal` — the server binary
- `target/site/` — hashed JS/WASM in `pkg/` plus static assets

## 5. Install into /opt/portal

```sh
sudo useradd --system --create-home --home-dir /opt/portal --shell /usr/sbin/nologin portal || true
sudo install -m755 target/release/portal /opt/portal/portal
sudo rm -rf /opt/portal/site && sudo cp -r target/site /opt/portal/site
sudo mkdir -p /opt/portal/uploads
sudo chown -R portal:portal /opt/portal
```

Final layout:

```
/opt/portal/
├── portal          # binary
├── site/           # LEPTOS_SITE_ROOT (contains pkg/ + assets)
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

# --- Leptos runtime (tells the binary where the site files are) ---
LEPTOS_OUTPUT_NAME=portal
LEPTOS_SITE_ROOT=site
LEPTOS_SITE_PKG_DIR=pkg
LEPTOS_SITE_ADDR=127.0.0.1:3000
LEPTOS_ENV=PROD
RUST_LOG=info
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

`WorkingDirectory=/opt/portal` is important: `LEPTOS_SITE_ROOT=site` is resolved
relative to it (→ `/opt/portal/site`).

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now portal
sudo systemctl status portal
journalctl -u portal -f          # watch logs; expect "listening on http://127.0.0.1:3000"
```

Quick local check on the box:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login   # 200
```

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

The app is server-rendered, so every route (including `/docs/:id`) is handled by
the backend — no SPA fallback rule is needed. Enable it:

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
renewal timer. Since you built with `.with_secure(true)`, cookies now flow only
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

- go to `/admin/users` and create real users with the permissions they need;
- reset or rotate the admin password;
- create categories at `/categories`.

---

## Updating / redeploying

```sh
cd ~/portal && git pull
cargo leptos build --release
sudo systemctl stop portal
sudo install -m755 target/release/portal /opt/portal/portal
sudo rm -rf /opt/portal/site && sudo cp -r target/site /opt/portal/site
sudo chown -R portal:portal /opt/portal/site /opt/portal/portal
sudo systemctl start portal
```

New migrations in `migrations/` are applied automatically on start.

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
cargo leptos build --release
scp target/release/portal        user@server:/tmp/portal
rsync -a --delete target/site/   user@server:/tmp/site/
```

On the server, move them into place as in step 5 and restart the service. For a
fully static binary you could instead build for
`x86_64-unknown-linux-musl`, which avoids glibc-version mismatches.

## Appendix B — persistent sessions (recommended for production)

Replace the in-memory store with the SQLx Postgres store so sessions survive
restarts and can be shared across instances.

1. Add the dependency (server-only) in `Cargo.toml` under the `ssr` deps:

   ```toml
   tower-sessions-sqlx-store = { version = "0.14", features = ["postgres"], optional = true }
   ```
   and add `"dep:tower-sessions-sqlx-store"` to the `ssr` feature list.

2. In `src/main.rs`, swap `MemoryStore` for the Postgres store and run its
   migration once at startup:

   ```rust
   use tower_sessions_sqlx_store::PostgresStore;

   let session_store = PostgresStore::new(state.pool.clone());
   session_store.migrate().await.expect("session store migrate");
   let session_layer = SessionManagerLayer::new(session_store)
       .with_http_only(true)
       .with_same_site(SameSite::Lax)
       .with_secure(true);
   ```

3. Rebuild and redeploy.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Service exits immediately, log: `DATABASE_URL must be set` | `portal.env` missing/unreadable or `EnvironmentFile` path wrong. |
| `failed to connect to Postgres` | Wrong `DATABASE_URL`, role/password, or Postgres not running. Test: `psql "$DATABASE_URL" -c '\q'`. |
| Page loads but is unstyled / no interactivity | `site/` not deployed next to the binary, or `LEPTOS_SITE_ROOT`/`WorkingDirectory` wrong. Check `/pkg/portal.wasm` returns 200. |
| `wasm-bindgen` version error during build | `wasm-bindgen-cli` version ≠ the `wasm-bindgen` pin in `Cargo.toml`. Reinstall the CLI to match. |
| Uploads fail with 413 | Raise nginx `client_max_body_size` (and `MAX_UPLOAD_BYTES`). |
| Logged out after every deploy | Expected with the in-memory store — see Appendix B. |
