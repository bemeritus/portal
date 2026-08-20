# Task runner for the portal project. Run `just` to list everything.
#
# Assumes the Nix dev shell (`direnv allow`, or `nix develop`). First-time
# setup after a clone is `./bootstrap.sh` — everything here expects that to
# have run at least once.
#
# The project is two programs: `backend/` (Axum, JSON API) and `frontend/`
# (Vite + React). Recipes that concern only one are prefixed accordingly.

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

# First-time local setup: .env, Postgres cluster, database, npm install.
setup:
    ./bootstrap.sh --setup-only

# Full bootstrap and then start both dev servers.
bootstrap:
    ./bootstrap.sh

# Install the frontend's dependencies.
install:
    cd frontend && npm install

# --- Run --------------------------------------------------------------------
# Development runs two processes. Vite owns the browser's origin on :5173 and
# proxies /api and /uploads to Axum on :3000 — that is what keeps the session
# cookie same-origin in development, as it is in production.

# Both dev servers at once. Open http://127.0.0.1:5173.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT INT TERM
    just dev-api &
    just dev-web &
    wait

# The API only, on http://127.0.0.1:3000.
dev-api:
    cd backend && cargo run

# The frontend only, on http://127.0.0.1:5173.
dev-web:
    cd frontend && npm run dev

# Build the frontend, then serve everything from the API on :3000.
# This is the production shape: one origin, no CORS, no Vite.
serve: build
    cd backend && STATIC_DIR=../frontend/dist cargo run --release

# Optimised build of both halves, no server.
build: build-web build-api

build-api:
    cd backend && cargo build --release

build-web:
    cd frontend && npm run build

# Stop a dev server left holding port 3000 or 5173 after a hard kill.
stop-server:
    -pkill -f 'target/debug/portal'
    -pkill -f 'vite'
    @sleep 1
    @ss -ltn | grep -E ':3000|:5173' || echo "ports 3000/5173 free"

# Show what currently holds the app's ports.
ports:
    @ss -ltnp | grep -E ':3000|:5173' || echo "ports 3000/5173 free"

# --- Checks -----------------------------------------------------------------

# Backend unit tests.
test:
    cd backend && cargo test

# Type-check both halves.
check: check-api check-web

check-api:
    cd backend && cargo check

check-web:
    cd frontend && npm run typecheck

# Lint both halves, warnings denied.
lint: lint-api lint-web

lint-api:
    cd backend && cargo clippy --all-targets -- -D warnings

lint-web:
    cd frontend && npm run lint

# Format the Rust source in place.
fmt:
    cd backend && cargo fmt

# Fail if anything is unformatted (for CI).
fmt-check:
    cd backend && cargo fmt --check

# Everything a change should pass before being committed.
ci: fmt-check lint check-web test

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
    cd backend && sqlx migrate run

# Add a new migration: `just migrate-add category_colours`.
migrate-add name:
    cd backend && sqlx migrate add {{name}}

# Which migrations have been applied?
migrate-info:
    cd backend && sqlx migrate info

# Drop, recreate and re-migrate the database — DESTROYS all local data.
db-reset:
    @printf 'This deletes every row in "%s". Ctrl-C to abort, Enter to continue: ' {{pgdb}} && read _
    dropdb -h 127.0.0.1 -p {{pgport}} -U {{pguser}} --if-exists {{pgdb}}
    createdb -h 127.0.0.1 -p {{pgport}} -U {{pguser}} -O {{pguser}} {{pgdb}}
    cd backend && sqlx migrate run
    @echo "reset; the seed admin is recreated on the next server start"

# --- Housekeeping -----------------------------------------------------------

# Remove build artefacts from both halves.
clean:
    cd backend && cargo clean
    rm -rf frontend/dist frontend/node_modules

# Delete the local cluster entirely. `just setup` recreates it from scratch.
db-nuke:
    @printf 'This deletes the cluster in %s. Ctrl-C to abort, Enter to continue: ' {{pgdata}} && read _
    -pg_ctl -D {{pgdata}} stop
    rm -rf {{pgdata}}
