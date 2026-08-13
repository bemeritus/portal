#!/usr/bin/env bash
#
# First-time local bootstrap: everything between `git clone` and a running app.
#
#   ./bootstrap.sh              set up, then start the dev server
#   ./bootstrap.sh --setup-only set up, but do not start the server
#
# Safe to re-run: every step checks whether it is already done and skips it.
# Nothing here is meant for production — the cluster it creates trusts every
# local connection and the seed admin password lives in a plain-text .env.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Must agree with the DATABASE_URL written into .env below.
PGDATA_DIR=".pgdata"
PG_PORT=5433
PG_SOCKET_DIR="/tmp"
PG_USER="postgres"
PG_DB="portal"
DATABASE_URL="postgres://${PG_USER}@127.0.0.1:${PG_PORT}/${PG_DB}"

SETUP_ONLY=0
[[ "${1:-}" == "--setup-only" ]] && SETUP_ONLY=1

step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '\033[1;33m    warning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\n\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 0. Toolchain -----------------------------------------------------------
# The tools come from the Nix devshell. If we are outside it, re-exec inside so
# that `./bootstrap.sh` really is the only command needed after a clone.

need_tools=(initdb pg_ctl psql createdb pg_isready cargo cargo-leptos)
missing=()
for t in "${need_tools[@]}"; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
done

if (( ${#missing[@]} > 0 )); then
    if [[ -n "${PORTAL_BOOTSTRAP_REEXEC:-}" ]]; then
        die "still missing inside the dev shell: ${missing[*]}"
    fi
    if [[ -f flake.nix ]] && command -v nix >/dev/null 2>&1; then
        step "Entering the Nix dev shell (missing: ${missing[*]})"
        info "first run downloads the toolchain; this can take a while"
        export PORTAL_BOOTSTRAP_REEXEC=1
        exec nix develop --command "${BASH_SOURCE[0]}" "$@"
    fi
    die "missing tools: ${missing[*]}
Install Nix and re-run, or provide manually: Rust stable + the
wasm32-unknown-unknown target, cargo-leptos, and PostgreSQL 15 client+server."
fi

# --- 1. Environment file ----------------------------------------------------
# .env is gitignored, so a fresh clone has none. .env.example ships a different
# DATABASE_URL (port 5432, password auth) than the cluster created below, so the
# URL is rewritten rather than copied verbatim.

step "Configuring .env"
if [[ -f .env ]]; then
    info ".env already exists — left untouched"
    existing_url="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
    if [[ -n "$existing_url" && "$existing_url" != "$DATABASE_URL" ]]; then
        warn "its DATABASE_URL is '$existing_url', not '$DATABASE_URL'."
        warn "this script manages the cluster at the latter; make them agree if the app cannot connect."
    fi
else
    [[ -f .env.example ]] || die ".env.example is missing; cannot generate .env"
    sed -E "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" .env.example > .env
    info "wrote .env from .env.example (DATABASE_URL -> ${DATABASE_URL})"
    warn "ADMIN_PASSWORD is still the example value — change it before exposing this."
fi

# --- 2. Postgres cluster ----------------------------------------------------

step "Preparing the Postgres cluster in ${PGDATA_DIR}/"
if [[ -d "$PGDATA_DIR" && -f "$PGDATA_DIR/PG_VERSION" ]]; then
    info "cluster already initialised"
else
    [[ -e "$PGDATA_DIR" ]] && die "$PGDATA_DIR exists but is not a Postgres cluster; move it aside"
    # -A trust: local development only. -U postgres so the role matches the URL
    # above; initdb would otherwise name the superuser after the OS user.
    initdb -D "$PGDATA_DIR" -U "$PG_USER" -A trust >/dev/null
    info "initialised (superuser '${PG_USER}', trust auth — dev only)"
fi

step "Starting Postgres on port ${PG_PORT}"
if pg_isready -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null; then
    info "already accepting connections on ${PG_PORT}"
else
    # The port lives only in this command: postgresql.conf leaves `port`
    # commented out, so omitting -p silently starts on 5432 and the app then
    # fails with a pool timeout. README.md's setup omits it.
    pg_ctl -D "$PGDATA_DIR" -o "-k ${PG_SOCKET_DIR} -p ${PG_PORT}" -l "$PGDATA_DIR/log" start >/dev/null
    for _ in $(seq 1 30); do
        pg_isready -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null && break
        sleep 1
    done
    pg_isready -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null \
        || die "Postgres did not come up; see ${PGDATA_DIR}/log"
    info "started (log: ${PGDATA_DIR}/log)"
fi

step "Ensuring the '${PG_DB}' database exists"
if psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'" | grep -q 1; then
    info "database already present"
else
    createdb -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -O "$PG_USER" "$PG_DB"
    info "created"
fi

# Schema is not applied here: the server runs sqlx::migrate! from ./migrations
# on every startup, so the migrations stay a single source of truth.
info "migrations in ./migrations are applied by the server on startup"

# --- 3. Uploads directory ---------------------------------------------------

step "Preparing the uploads directory"
mkdir -p uploads
info "uploads/ ready"

# --- 4. Port availability ---------------------------------------------------
# 3000 serves the app, 3001 is cargo-leptos's hot-reload socket. A cargo-leptos
# killed with SIGKILL leaves 3001 held, which surfaces as a confusing
# "Reload TCP port already in use" on the next run.

step "Checking ports 3000 and 3001"
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&-; return 0; } || return 1; }
for port in 3000 3001; do
    if port_busy "$port"; then
        warn "port ${port} is in use — either the app is already running, or a"
        warn "previous cargo-leptos was killed and left the socket held. Check with:"
        warn "  ss -ltnp | grep -E ':3000|:3001'"
        warn "and if it is a leftover: pkill -f 'cargo-leptos leptos watch'"
    else
        info "port ${port} free"
    fi
done

# --- 5. Done ----------------------------------------------------------------

admin_user="$(grep -E '^ADMIN_USERNAME=' .env | head -1 | cut -d= -f2- || true)"
admin_pass="$(grep -E '^ADMIN_PASSWORD=' .env | head -1 | cut -d= -f2- || true)"

step "Bootstrap complete"
info "app:      http://127.0.0.1:3000  (redirects to /login)"
info "sign in:  ${admin_user:-admin} / ${admin_pass:-<see .env>}"
info "the seed admin is created on first boot only if the users table is empty"
printf '\n'
info "stop the database later with: pg_ctl -D ${PGDATA_DIR} stop"

if (( SETUP_ONLY )); then
    info "re-run without --setup-only, or start it yourself: cargo leptos watch"
    exit 0
fi

step "Starting the dev server (Ctrl-C to stop)"
info "the first build compiles the whole dependency tree — expect several minutes"
exec cargo leptos watch
