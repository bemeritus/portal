#!/usr/bin/env bash
# A throwaway stack for browser tests: its own scratch database, created,
# migrated and seeded here and dropped on exit, with its own API and Vite on
# their own ports. The dev database (DATABASE_URL in .env) is never touched,
# so a branch's migrations cannot reach it before the branch is merged.
#
#   scripts/e2e-stack.sh run [playwright args…]   run the e2e checks, then tear down
#   scripts/e2e-stack.sh serve                    keep it up until Ctrl-C (screenshots)
#
# Needs the local cluster running (`just db-start`) and the dev shell's tools.
# Ports: E2E_API_PORT (3101) and E2E_WEB_PORT (5181).
set -euo pipefail

mode=${1:-run}
[ $# -gt 0 ] && shift
root=$(cd "$(dirname "$0")/.." && pwd)
pgport=${PGPORT_DEV:-5433}
pguser=${PGUSER_DEV:-postgres}
api_port=${E2E_API_PORT:-3101}
web_port=${E2E_WEB_PORT:-5181}
user=${E2E_USER:-dcedit}
password=${E2E_PASSWORD:-testpass1}

for p in "$api_port" "$web_port"; do
    if ss -ltn | grep -q ":$p "; then
        echo "port $p is in use; set E2E_API_PORT / E2E_WEB_PORT" >&2
        exit 1
    fi
done

db=portal_e2e_$$
url="postgres://$pguser@127.0.0.1:$pgport/$db"
work=$(mktemp -d)
pids=()
cleanup() {
    for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
    wait 2>/dev/null || true
    dropdb -h 127.0.0.1 -p "$pgport" -U "$pguser" --if-exists "$db"
    rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

createdb -h 127.0.0.1 -p "$pgport" -U "$pguser" "$db"
echo "scratch database $db"

(cd "$root/backend" && cargo build -q)
bin="$root/backend/target/debug/portal"
admin=e2eadmin
admin_password=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
export DATABASE_URL="$url" BIND_ADDR="127.0.0.1:$api_port" UPLOADS_DIR="$work/uploads" \
    ADMIN_USERNAME="$admin" ADMIN_PASSWORD="$admin_password" CORS_ORIGINS=""
(cd "$root/backend" && "$bin" seed-dc)

(cd "$root/backend" && exec "$bin") > "$work/api.log" 2>&1 &
pids+=($!)
(cd "$root/frontend" && DEV_API_URL="http://127.0.0.1:$api_port" \
    exec npx vite --port "$web_port" --strictPort) > "$work/web.log" 2>&1 &
pids+=($!)

wait_for() {
    for _ in $(seq 1 120); do
        curl -s -o /dev/null "$1" && return 0
        sleep 0.5
    done
    echo "not up: $1 (logs in $work)" >&2
    cat "$work/api.log" "$work/web.log" >&2
    exit 1
}
api="http://127.0.0.1:$api_port"
wait_for "$api/api/auth/me"
wait_for "http://localhost:$web_port/"

# The test account, with edit rights on the server room.
jar="$work/admin.jar"
curl -sf -c "$jar" -H 'content-type: application/json' \
    -d "{\"username\":\"$admin\",\"password\":\"$admin_password\"}" "$api/api/auth/login" > /dev/null
id=$(curl -sf -b "$jar" -H 'content-type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$password\"}" "$api/api/users" |
    sed -n 's/.*"id": *"\([^"]*\)".*/\1/p')
curl -sf -b "$jar" -X PUT -H 'content-type: application/json' \
    -d '{"grants":[{"tool":"dc_room","level":"edit"}]}' "$api/api/users/$id/tools" > /dev/null

export E2E_BASE_URL="http://localhost:$web_port" E2E_USER="$user" E2E_PASSWORD="$password"
case "$mode" in
    run)
        (cd "$root/frontend" && npx playwright test "$@")
        ;;
    serve)
        echo "serving $E2E_BASE_URL (API $api) on $db as $user / $password; Ctrl-C to drop it"
        wait
        ;;
    *)
        echo "unknown mode: $mode (run | serve)" >&2
        exit 2
        ;;
esac
