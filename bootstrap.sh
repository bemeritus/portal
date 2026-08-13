#!/usr/bin/env bash
#
# First-time local bootstrap: everything between `git clone` and a running app.
#
#   ./bootstrap.sh                     set up, then start the dev server
#   ./bootstrap.sh --setup-only        set up, but do not start the server
#   ./bootstrap.sh --help              all options
#
# Works two ways:
#   * with Nix   — re-execs inside `nix develop`, which pins every tool;
#   * without it — installs what is missing using the distro's package manager
#                  (apt/dnf/pacman/zypper/apk) plus rustup, after asking.
#
# Safe to re-run: every step checks whether it is already done and skips it.
# Nothing here is meant for production — the cluster it creates trusts every
# local connection.

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
ASSUME_YES=0
NO_INSTALL=0
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="${PORTAL_ADMIN_PASSWORD:-}"
ADMIN_PASSWORD_GIVEN=0
[[ -n "$ADMIN_PASSWORD" ]] && ADMIN_PASSWORD_GIVEN=1

step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '\033[1;33m    warning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\n\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

usage() {
    cat <<'EOF'
Usage: ./bootstrap.sh [options]

  --setup-only            Prepare everything but do not start the dev server.
  -y, --yes               Never prompt: install without asking, and generate
                          the admin password instead of asking for one.
  --no-install            Never install anything; report what is missing.
  --admin-username NAME   Seed admin username (default: admin).
  --admin-password PASS   Seed admin password. Also read from
                          $PORTAL_ADMIN_PASSWORD. If neither is set you are
                          prompted; with --yes a random one is generated.
  -h, --help              This message.

The admin password is set here, at bootstrap time — you should not need to
edit .env afterwards. It seeds the first account only while the `users` table
is empty; after that, change the password in the app.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --setup-only)     SETUP_ONLY=1 ;;
        -y|--yes)         ASSUME_YES=1 ;;
        --no-install)     NO_INSTALL=1 ;;
        --admin-username) ADMIN_USERNAME="${2:?--admin-username needs a value}"; shift ;;
        --admin-password) ADMIN_PASSWORD="${2:?--admin-password needs a value}"
                          ADMIN_PASSWORD_GIVEN=1; shift ;;
        -h|--help)        usage; exit 0 ;;
        *)                die "unknown option: $1 (try --help)" ;;
    esac
    shift
done

# Ask a yes/no question. Non-interactive or --yes answers yes.
confirm() {
    (( ASSUME_YES )) && return 0
    [[ -t 0 ]] || return 0
    local reply
    printf '    %s [Y/n] ' "$1"
    read -r reply
    [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# --- 0. Platform and toolchain ---------------------------------------------

DISTRO_NAME="unknown"
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    DISTRO_NAME="$(. /etc/os-release && echo "${NAME:-unknown}")"
fi

# Debian and openSUSE keep the server binaries off PATH, one directory per
# major version. Pick the newest so initdb/pg_ctl resolve like anywhere else.
add_postgres_bin_to_path() {
    command -v initdb >/dev/null 2>&1 && return 0
    local dir
    for dir in $(ls -d /usr/lib/postgresql/*/bin /usr/lib/postgresql*/bin \
                       /usr/pgsql-*/bin 2>/dev/null | sort -V -r); do
        if [[ -x "$dir/initdb" ]]; then
            PATH="$dir:$PATH"
            export PATH
            info "using PostgreSQL binaries from $dir"
            return 0
        fi
    done
    return 1
}

detect_pkg_manager() {
    local m
    for m in apt-get dnf pacman zypper apk; do
        command -v "$m" >/dev/null 2>&1 && { echo "$m"; return 0; }
    done
    echo ""
}

# Package names differ per distro; $1 is the logical name.
pkg_for() {
    local mgr="$1" what="$2"
    case "$what:$mgr" in
        postgres:apt-get) echo "postgresql" ;;
        postgres:dnf)     echo "postgresql-server postgresql" ;;
        postgres:pacman)  echo "postgresql" ;;
        postgres:zypper)  echo "postgresql-server postgresql" ;;
        postgres:apk)     echo "postgresql postgresql-client" ;;
        buildtools:apt-get) echo "build-essential pkg-config curl" ;;
        buildtools:dnf)     echo "gcc pkgconf-pkg-config curl" ;;
        buildtools:pacman)  echo "base-devel curl" ;;
        buildtools:zypper)  echo "gcc pkg-config curl" ;;
        buildtools:apk)     echo "build-base curl" ;;
        # wasm-opt, only needed for release builds — optional for dev.
        binaryen:*)         echo "binaryen" ;;
        *) echo "" ;;
    esac
}

install_packages() {
    local mgr="$1"; shift
    local pkgs=("$@")
    (( ${#pkgs[@]} )) || return 0

    local sudo_cmd=()
    if [[ $EUID -ne 0 ]]; then
        command -v sudo >/dev/null 2>&1 \
            || die "need root to install: ${pkgs[*]} — install them yourself, or re-run as root"
        sudo_cmd=(sudo)
    fi

    local cmd=()
    case "$mgr" in
        apt-get) cmd=("${sudo_cmd[@]}" apt-get install -y "${pkgs[@]}") ;;
        dnf)     cmd=("${sudo_cmd[@]}" dnf install -y "${pkgs[@]}") ;;
        pacman)  cmd=("${sudo_cmd[@]}" pacman -S --needed --noconfirm "${pkgs[@]}") ;;
        zypper)  cmd=("${sudo_cmd[@]}" zypper install -y "${pkgs[@]}") ;;
        apk)     cmd=("${sudo_cmd[@]}" apk add "${pkgs[@]}") ;;
        *)       die "no supported package manager found; install manually: ${pkgs[*]}" ;;
    esac

    info "about to run: ${cmd[*]}"
    confirm "Install these packages?" || die "declined; install them yourself and re-run"
    if [[ "$mgr" == "apt-get" ]]; then
        "${sudo_cmd[@]}" apt-get update
    fi
    "${cmd[@]}"
}

# The wasm-bindgen CLI must match the pinned library version exactly, so read
# it out of Cargo.toml rather than hardcoding a second copy of the number.
wasm_bindgen_pin() {
    sed -n 's/^wasm-bindgen *= *{ *version *= *"=\([0-9.]*\)".*/\1/p' Cargo.toml | head -1
}

install_rust_toolchain() {
    if ! command -v cargo >/dev/null 2>&1; then
        (( NO_INSTALL )) && die "cargo is missing and --no-install was given"
        info "installing Rust via rustup (no root needed)"
        confirm "Download and run https://sh.rustup.rs?" || die "declined"
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
        # shellcheck disable=SC1091
        source "${CARGO_HOME:-$HOME/.cargo}/env"
    fi
    export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

    # Nix (and distro-packaged Rust) provide no rustup, but can still ship the
    # wasm std — so check the sysroot rather than assume rustup is the only way.
    if command -v rustup >/dev/null 2>&1; then
        rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown \
            || { info "adding the wasm32-unknown-unknown target"; rustup target add wasm32-unknown-unknown; }
    elif [[ -d "$(rustc --print sysroot 2>/dev/null)/lib/rustlib/wasm32-unknown-unknown" ]]; then
        info "wasm32-unknown-unknown target present (provided outside rustup)"
    else
        die "the wasm32-unknown-unknown target is missing and rustup is not installed.
Install rustup, or add the target through whatever provides your Rust toolchain."
    fi

    if ! command -v cargo-leptos >/dev/null 2>&1; then
        (( NO_INSTALL )) && die "cargo-leptos is missing and --no-install was given"
        info "installing cargo-leptos (this compiles from source and takes a while)"
        confirm "Run cargo install cargo-leptos --locked?" || die "declined"
        cargo install cargo-leptos --locked
    fi

    local pin; pin="$(wasm_bindgen_pin)"
    if [[ -n "$pin" ]] && ! wasm-bindgen --version 2>/dev/null | grep -q "$pin"; then
        (( NO_INSTALL )) && die "wasm-bindgen-cli ${pin} is missing and --no-install was given"
        info "installing wasm-bindgen-cli ${pin} (must match the Cargo.toml pin)"
        confirm "Run cargo install wasm-bindgen-cli --version ${pin} --locked?" || die "declined"
        cargo install wasm-bindgen-cli --version "$pin" --locked
    fi
}

step "Checking the toolchain (${DISTRO_NAME})"

# The Nix shell pins everything, so prefer it when the flake is present.
if [[ -f flake.nix ]] && command -v nix >/dev/null 2>&1 && [[ -z "${PORTAL_BOOTSTRAP_REEXEC:-}" ]]; then
    if ! command -v cargo-leptos >/dev/null 2>&1 || ! command -v initdb >/dev/null 2>&1; then
        info "Nix detected — re-running inside the dev shell"
        info "the first run downloads the toolchain and can take a while"
        export PORTAL_BOOTSTRAP_REEXEC=1
        exec nix develop --command "${BASH_SOURCE[0]}" "$@"
    fi
fi

add_postgres_bin_to_path || true

missing=()
for t in initdb pg_ctl psql createdb pg_isready; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
done

if (( ${#missing[@]} > 0 )); then
    info "missing PostgreSQL tools: ${missing[*]}"
    (( NO_INSTALL )) && die "install PostgreSQL (server + client) and re-run"
    mgr="$(detect_pkg_manager)"
    [[ -n "$mgr" ]] || die "no supported package manager; install PostgreSQL 15+ (server + client) manually"
    # shellcheck disable=SC2046
    install_packages "$mgr" $(pkg_for "$mgr" postgres) $(pkg_for "$mgr" buildtools)
    add_postgres_bin_to_path || true
    for t in initdb pg_ctl psql createdb pg_isready; do
        command -v "$t" >/dev/null 2>&1 || die "$t still not on PATH after installing PostgreSQL"
    done
fi

install_rust_toolchain

if ! command -v wasm-opt >/dev/null 2>&1; then
    warn "wasm-opt (binaryen) not found — only needed for release builds, dev is fine"
fi

info "toolchain OK"

# --- 1. Admin password ------------------------------------------------------
# Chosen here rather than by hand-editing .env afterwards. It seeds the first
# account and only while the `users` table is empty.

generate_password() {
    # Deliberately no `... /dev/urandom | head -c N`: head closing the pipe
    # sends SIGPIPE to tr, and under `set -o pipefail` that aborts the script.
    # Read a bounded chunk instead and slice it in the shell.
    local raw
    raw="$(LC_ALL=C tr -dc 'A-Za-z0-9@%+=_.-' < <(head -c 4096 /dev/urandom))"
    printf '%s' "${raw:0:20}"
}

# A single quote cannot appear in a single-quoted .env value, and single quotes
# are the only form dotenvy takes literally: unquoted values break on spaces and
# double-quoted ones expand $VAR, which would silently mangle a password.
validate_password() {
    local p="$1"
    [[ "$p" != *"'"* ]] || { warn "the password cannot contain a single quote (')"; return 1; }
    (( ${#p} >= 8 ))   || { warn "use at least 8 characters"; return 1; }
    return 0
}

prompt_password() {
    local first second
    while :; do
        printf '    Admin password for "%s" (input hidden, blank to generate one): ' "$ADMIN_USERNAME"
        read -rs first; printf '\n'
        if [[ -z "$first" ]]; then
            ADMIN_PASSWORD="$(generate_password)"
            info "generated: ${ADMIN_PASSWORD}"
            return 0
        fi
        validate_password "$first" || continue
        printf '    Repeat it: '
        read -rs second; printf '\n'
        [[ "$first" == "$second" ]] || { warn "they do not match, try again"; continue; }
        ADMIN_PASSWORD="$first"
        return 0
    done
}

resolve_password() {
    if (( ADMIN_PASSWORD_GIVEN )); then
        validate_password "$ADMIN_PASSWORD" || die "the supplied admin password is not usable"
        info "using the password supplied on the command line / environment"
    elif (( ASSUME_YES )) || [[ ! -t 0 ]]; then
        ADMIN_PASSWORD="$(generate_password)"
        info "no password given and not interactive — generated: ${ADMIN_PASSWORD}"
    else
        prompt_password
    fi
}

step "Configuring .env"

env_set() {  # env_set KEY 'raw value' — written single-quoted, taken literally
    local key="$1" value="$2"
    if grep -qE "^${key}=" .env; then
        # The value goes in via a file to keep sed from interpreting it.
        local tmp; tmp="$(mktemp)"
        { grep -vE "^${key}=" .env; printf "%s='%s'\n" "$key" "$value"; } > "$tmp"
        mv "$tmp" .env
    else
        printf "%s='%s'\n" "$key" "$value" >> .env
    fi
}

if [[ -f .env ]]; then
    info ".env already exists — keeping it"
    existing_url="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d "\"'")"
    if [[ -n "$existing_url" && "$existing_url" != "$DATABASE_URL" ]]; then
        warn "its DATABASE_URL is '$existing_url', not '$DATABASE_URL'."
        warn "this script manages the cluster at the latter; make them agree if the app cannot connect."
    fi
    current_pass="$(grep -E '^ADMIN_PASSWORD=' .env | head -1 | cut -d= -f2- | tr -d "\"'")"
    if (( ADMIN_PASSWORD_GIVEN )); then
        validate_password "$ADMIN_PASSWORD" || die "the supplied admin password is not usable"
        env_set ADMIN_USERNAME "$ADMIN_USERNAME"
        env_set ADMIN_PASSWORD "$ADMIN_PASSWORD"
        info "admin credentials updated in .env"
    elif [[ "$current_pass" == "change-me-now" || -z "$current_pass" ]]; then
        warn "ADMIN_PASSWORD is unset or still the example value"
        if confirm "Set the admin password now?"; then
            resolve_password
            env_set ADMIN_USERNAME "$ADMIN_USERNAME"
            env_set ADMIN_PASSWORD "$ADMIN_PASSWORD"
            info "admin credentials written to .env"
        fi
    fi
else
    [[ -f .env.example ]] || die ".env.example is missing; cannot generate .env"
    # .env.example points at a different database (port 5432, password auth)
    # than the cluster created below, so the URL is rewritten, not copied.
    sed -E "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" .env.example > .env
    resolve_password
    env_set ADMIN_USERNAME "$ADMIN_USERNAME"
    env_set ADMIN_PASSWORD "$ADMIN_PASSWORD"
    info "wrote .env (DATABASE_URL -> ${DATABASE_URL}, admin -> ${ADMIN_USERNAME})"
fi

chmod 600 .env 2>/dev/null || true

# --- 2. Postgres cluster ----------------------------------------------------

step "Preparing the Postgres cluster in ${PGDATA_DIR}/"
if [[ -d "$PGDATA_DIR" && -f "$PGDATA_DIR/PG_VERSION" ]]; then
    info "cluster already initialised"
else
    [[ -e "$PGDATA_DIR" ]] && die "$PGDATA_DIR exists but is not a Postgres cluster; move it aside"
    [[ $EUID -eq 0 ]] && die "refusing to initdb as root — run this as your normal user"
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

# The seed only fires while `users` is empty; say so rather than let someone
# wonder why a freshly set password does not work.
existing_users="$(psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT count(*) FROM users" 2>/dev/null || echo "")"
if [[ -n "$existing_users" && "$existing_users" != "0" ]]; then
    warn "the database already has ${existing_users} user(s), so the seed admin will NOT be recreated"
    warn "the ADMIN_PASSWORD in .env has no effect now — change the password inside the app"
fi

# --- 3. Uploads directory ---------------------------------------------------

step "Preparing the uploads directory"
mkdir -p uploads
info "uploads/ ready"

# --- 4. Port availability ---------------------------------------------------
# 3000 serves the app, 3001 is cargo-leptos's hot-reload socket.

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

step "Bootstrap complete"
info "app:      http://127.0.0.1:3000  (redirects to /login)"
# Report what .env actually holds, which is not necessarily what this run set:
# an existing .env is kept as-is, and its username may differ from the default.
env_username="$(grep -E '^ADMIN_USERNAME=' .env | head -1 | cut -d= -f2- | tr -d "\"'")"
info "sign in:  ${env_username:-$ADMIN_USERNAME} / ${ADMIN_PASSWORD:-<the value already in .env>}"
printf '\n'
info "stop the database later with: pg_ctl -D ${PGDATA_DIR} stop"

if (( SETUP_ONLY )); then
    info "re-run without --setup-only, or start it yourself: cargo leptos watch"
    exit 0
fi

step "Starting the dev server (Ctrl-C to stop)"
info "the first build compiles the whole dependency tree — expect several minutes"
exec cargo leptos watch
