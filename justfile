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

# Unit tests, both halves.
test: test-api test-web

# Backend unit tests.
test-api:
    cd backend && cargo test --workspace

# Frontend unit tests (Vitest), including the locale key-parity check.
test-web:
    cd frontend && npm test

# Type-check both halves.
check: check-api check-web

check-api:
    cd backend && cargo check --workspace

check-web:
    cd frontend && npm run typecheck

# Lint both halves, warnings denied.
lint: lint-api lint-web

lint-api:
    cd backend && cargo clippy --workspace --all-targets -- -D warnings

lint-web:
    cd frontend && npm run lint

# Format the Rust source in place.
fmt:
    cd backend && cargo fmt --all

# Fail if anything is unformatted (for CI).
fmt-check:
    cd backend && cargo fmt --all --check

# Everything a change should pass before being committed. Needs the local
# cluster running (`just db-start`), for check-migrations.
ci: fmt-check lint check-web test check-migrations

# The whole set of migrations applies to a fresh database through the API's
# own migrator, as a start would. The scratch database is created and dropped
# again; DATABASE_URL is not touched. Two migrations with one version are
# caught by `db::tests::migration_versions_are_unique` (in `just test`), which
# reads the set as sqlx embeds it.
check-migrations:
    #!/usr/bin/env bash
    set -euo pipefail
    db=portal_migrate_check_$$
    url="postgres://{{pguser}}@127.0.0.1:{{pgport}}/$db"
    createdb -h 127.0.0.1 -p {{pgport}} -U {{pguser}} "$db"
    trap 'dropdb -h 127.0.0.1 -p {{pgport}} -U {{pguser}} --if-exists "$db"' EXIT
    cd backend && DATABASE_URL="$url" cargo run -q -- migrate

# --- Airflow worker ---------------------------------------------------------
# The airflow model's solver runs in its own container (SPEC §14.2,
# docs/DEPLOY.md "Airflow worker"): the pinned OpenFOAM image plus
# `portal-cfd-worker`, which claims runs from Postgres. The API never talks
# to a container runtime. Podman by default; `CONTAINER=docker just …`.

container := env("CONTAINER", "podman")
# Files written to the host belong to the caller (rootless Podman maps ids).
as_me := if container == "podman" { "--userns=keep-id --user $(id -u):$(id -g)" } else { "--user $(id -u):$(id -g)" }

# Build the airflow worker's image.
cfd-build:
    {{container}} build -f Dockerfile.cfd-worker -t portal-cfd-worker .

# The worker does not migrate: the API must have applied migration 0030 to
# that database. The MPI process count comes from each run (the API's
# AIRFLOW_PROCESSES, 12 by default); give the worker as many CPUs. On a branch, point DATABASE_URL at a scratch database, never
# at the dev one.
#
# Run the airflow worker against DATABASE_URL until Ctrl-C.
cfd-worker cpus="12": cfd-build
    {{container}} run --rm --name portal-cfd-worker --network host --shm-size 2g \
        --cpus {{cpus}} -e DATABASE_URL="$DATABASE_URL" \
        -v portal-cfd-cases:/var/lib/portal-cfd portal-cfd-worker

# The reference case: `just cfd-reference > input.json`; the process count
# is the input's `settings.processes`.
#
# One case without a database: `just cfd-case input.json out/`.
cfd-case input out: cfd-build
    mkdir -p {{out}}
    {{container}} run --rm --shm-size 2g {{as_me}} -e HOME=/tmp -e CFD_WORK_DIR=/out/.case \
        -v "$(realpath {{input}})":/in.json:ro -v "$(realpath {{out}})":/out \
        portal-cfd-worker run-case /in.json /out

# The reference case of dc-handoff/reference/airflow-cfd as an input.
cfd-reference: cfd-build
    @{{container}} run --rm portal-cfd-worker reference-input

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

# Re-runnable: a category or document that already exists is left alone, so
# this never duplicates content or overwrites an edited document.
#
# Load the starter technical content — 6 categories, 3 documents each.
seed:
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/seeds/technical_content.sql

# Re-runnable: catalog items and the room are matched and left alone when
# they exist, so this never overwrites edits made since.
#
# Load the server room (dc-handoff/data/room.json) and the cooling catalog.
# Browser end-to-end checks on a stack of their own: a scratch database
# (created, migrated, seeded, dropped again), an API and Vite on their own
# ports (E2E_API_PORT, E2E_WEB_PORT). The dev database is never touched, so a
# branch's migrations cannot reach it before merge. Needs the cluster running;
# extra arguments go to `playwright test`, as they are.
[positional-arguments]
e2e *args:
    scripts/e2e-stack.sh run "$@"

# The same stack, kept up until Ctrl-C — for screenshots or a look by hand.
e2e-serve:
    scripts/e2e-stack.sh serve

seed-dc:
    cd backend && cargo run -q -- seed-dc

# Database-level DC rules (no-overlap, rack fit, …) against a scratch
# database that is created, migrated and dropped again. Needs the local
# cluster running; the database in DATABASE_URL is not touched.
test-db:
    #!/usr/bin/env bash
    set -euo pipefail
    db=portal_dc_test_$$
    url="postgres://{{pguser}}@127.0.0.1:{{pgport}}/$db"
    createdb -h 127.0.0.1 -p {{pgport}} -U {{pguser}} "$db"
    trap 'dropdb -h 127.0.0.1 -p {{pgport}} -U {{pguser}} --if-exists "$db"' EXIT
    (cd backend && DATABASE_URL="$url" sqlx migrate run > /dev/null)
    psql "$url" -q -v ON_ERROR_STOP=1 -f backend/tests/dc_constraints.sql

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
