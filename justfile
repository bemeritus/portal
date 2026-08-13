# Task runner for the portal project. Run `just` to list everything.
#
# Assumes the Nix dev shell (`direnv allow`, or `nix develop`). First-time
# setup after a clone is `./bootstrap.sh` — everything here expects that to
# have run at least once.

# DATABASE_URL and friends come from .env, so recipes match what the app sees.
set dotenv-load := true

pgdata := ".pgdata"
pgport := "5433"
pguser := "postgres"
pgdb := "portal"

# List the available recipes.
default:
    @just --list --unsorted

# --- Setup ------------------------------------------------------------------

# First-time local setup: .env, Postgres cluster, database, uploads dir.
setup:
    ./bootstrap.sh --setup-only

# Full bootstrap and then start the dev server.
bootstrap:
    ./bootstrap.sh

# --- Run --------------------------------------------------------------------

# Dev server with hot reload on http://127.0.0.1:3000.
dev:
    cargo leptos watch

# Optimised build, served locally.
serve:
    cargo leptos serve --release

# Optimised build only, no server.
build:
    cargo leptos build --release

# Stop a cargo-leptos left holding ports 3000/3001 after a hard kill.
stop-server:
    -pkill -f 'cargo-leptos leptos watch'
    @sleep 1
    @ss -ltn | grep -E ':3000|:3001' || echo "ports 3000/3001 free"

# Show what currently holds the app and reload ports.
ports:
    @ss -ltnp | grep -E ':3000|:3001' || echo "ports 3000/3001 free"

# --- Checks -----------------------------------------------------------------

# Unit tests (server-side, default `ssr` feature).
test:
    cargo test

# Type-check both sides: the server binary and the wasm hydrate bundle.
check:
    cargo check --no-default-features --features ssr
    cargo check --no-default-features --features hydrate --target wasm32-unknown-unknown

# Clippy over both feature sets, warnings denied.
lint:
    cargo clippy --no-default-features --features ssr --all-targets -- -D warnings
    cargo clippy --no-default-features --features hydrate --target wasm32-unknown-unknown -- -D warnings

# Format the source in place.
fmt:
    cargo fmt

# Fail if anything is unformatted (for CI).
fmt-check:
    cargo fmt --check

# Everything a change should pass before being committed.
ci: fmt-check lint test

# --- Database ---------------------------------------------------------------
# The port lives only in the pg_ctl invocation: postgresql.conf leaves `port`
# commented out, so dropping -p silently starts the cluster on 5432 and the app
# then fails with a pool timeout.

# Start the local Postgres cluster.
db-start:
    pg_ctl -D {{pgdata}} -o "-k /tmp -p {{pgport}}" -l {{pgdata}}/log start

# Stop the local Postgres cluster.
db-stop:
    pg_ctl -D {{pgdata}} stop

# Restart the cluster.
db-restart: db-stop db-start

# Is the database up and accepting connections?
db-status:
    @pg_isready -h 127.0.0.1 -p {{pgport}} || true
    @pg_ctl -D {{pgdata}} status || true

# Open a psql shell on the app's database.
psql:
    psql "$DATABASE_URL"

# Tail the Postgres server log.
db-log:
    tail -f {{pgdata}}/log

# Apply pending migrations. The server also does this on every startup.
migrate:
    sqlx migrate run

# Add a new migration: `just migrate-add category_colours`.
migrate-add name:
    sqlx migrate add {{name}}

# Which migrations have been applied?
migrate-info:
    sqlx migrate info

# Drop, recreate and re-migrate the database — DESTROYS all local data.
db-reset:
    @printf 'This deletes every row in "%s". Ctrl-C to abort, Enter to continue: ' {{pgdb}} && read _
    dropdb -h 127.0.0.1 -p {{pgport}} -U {{pguser}} --if-exists {{pgdb}}
    createdb -h 127.0.0.1 -p {{pgport}} -U {{pguser}} -O {{pguser}} {{pgdb}}
    sqlx migrate run
    @echo "reset; the seed admin is recreated on the next server start"

# --- Housekeeping -----------------------------------------------------------

# Remove build artefacts (both the server and wasm target dirs).
clean:
    cargo clean
    rm -rf target/front target/site

# Delete the local cluster entirely. `just setup` recreates it from scratch.
db-nuke:
    @printf 'This deletes the cluster in %s. Ctrl-C to abort, Enter to continue: ' {{pgdata}} && read _
    -pg_ctl -D {{pgdata}} stop
    rm -rf {{pgdata}}
