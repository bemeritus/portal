# Knowledge Base / Q&A Platform

*O'zbekcha: [README.uz.md](./docs/README.uz.md)*

An internal, admin-gated knowledge base where authorized users write and read
technical documents in a **question-and-answer** format. Two programs:

| | | |
|---|---|---|
| **`backend/`** | Rust — **Axum** + **SQLx** + **PostgreSQL** | a JSON API under `/api`, and in production the static host for the frontend |
| **`frontend/`** | TypeScript — **React** + **Vite** | a single-page app; the only thing a browser talks to |

The specification is [`docs/platform_doc.md`](./docs/platform_doc.md).

## Documentation

| | English | O'zbekcha |
|---|---|---|
| This file — setup, running, permissions | [`README.md`](./README.md) | [`docs/README.uz.md`](./docs/README.uz.md) |
| Technical specification | [`docs/platform_doc.md`](./docs/platform_doc.md) | [`docs/platform_doc.uz.md`](./docs/platform_doc.uz.md) |
| Production deployment | [`docs/DEPLOY.md`](./docs/DEPLOY.md) | [`docs/DEPLOY.uz.md`](./docs/DEPLOY.uz.md) |

## Quick start

```sh
./bootstrap.sh          # everything between `git clone` and a running app
```

It creates `.env`, initialises a local PostgreSQL cluster on **port 5433**,
creates the database, installs the frontend's dependencies, and starts both dev
servers. Open **http://127.0.0.1:5173**. It is safe to re-run;
`./bootstrap.sh --setup-only` stops before starting anything.

## How the two halves fit together

```
development                          production
───────────                          ──────────
browser → Vite :5173                 browser → Axum :3000
            │  /api, /uploads                   ├── /api/*      JSON
            └─ proxied to :3000                 ├── /uploads/*  files, behind the session
                                                └── /*          index.html + assets
```

In development Vite owns the browser's origin and proxies the API to Axum, so
the session cookie is same-origin exactly as it is in production. That is worth
knowing before changing it: point the frontend straight at `:3000` and the
cookie becomes cross-site, `SameSite=Lax` drops it, and the app logs in and
immediately looks logged out.

In production there is one origin and one process — `STATIC_DIR` points Axum at
`frontend/dist` — so no CORS is involved at all.

## Features

- **No public signup** — only an admin creates users (`/admin/users`).
- **Per-category permissions**: `READ`, `WRITE`, `EDIT`, `DELETE` are granted to
  a user *on individual categories*. See [Permissions](#permissions).
- **Q&A documents**: a title + category + status and an ordered list of
  question/answer blocks; answers are **Markdown**, rendered and sanitized
  server-side.
- **Categories**, admin-managed; each document belongs to exactly one.
- **Filtering** on the home page by **title** (ILIKE) and **category**, live.
- **Image uploads** (PNG/JPEG/GIF/WebP, ≤5 MB), inserted straight into the
  answer you are editing.
- **Change history** (`/admin/logs`, admin only): every user, permission,
  category, document and upload change is recorded with who, when, what action
  and what changed — append-only, and entries outlive what they describe.
- **argon2** password hashing, **tower-sessions** cookie sessions, and a
  permission guard on every endpoint.

## Permissions

The model implemented in `backend/src/models.rs` and enforced in
`backend/src/auth.rs` is **grants-only**:

```
allowed(user, category, perm) =
      user.is_admin                        // admins hold everything, everywhere
   OR grant(user, category, perm)          // a row in user_category_permissions
```

There is no third term. In particular:

- **Global flags do not grant anything.** The `users.can_*` columns still exist
  in the schema but no guard reads them, no endpoint writes them, and the API
  no longer sends them to the client at all. See [Known gaps](#known-gaps).
- **Authorship grants nothing.** Reading, editing or deleting your own document
  all require the corresponding grant on the category it currently sits in.
- **Permission is always resolved against the document's category.** Moving a
  document elsewhere needs `WRITE` or `EDIT` in the destination too.
- **Permissions are re-read from the database on every request**, so revoking a
  grant takes effect immediately — mid-session, without a re-login.
- **Status is not an access control.** `draft` and `published` are stored and
  displayed, but a draft is visible to everyone who can `READ` its category.

`frontend/src/permissions.ts` mirrors this rule to decide what to *show*. It
never decides what is allowed: the server re-checks every request behind it.

## Prerequisites

The Nix flake provides everything: the Rust toolchain, **Node.js 22**,
`sqlx-cli`, `just`, and PostgreSQL 15.

```sh
direnv allow        # or: nix develop
```

Without Nix, `./bootstrap.sh` installs what is missing through the distro's
package manager (apt/dnf/pacman/zypper/apk) plus rustup, after asking. By hand
you need Rust stable, Node.js 20+, and a running PostgreSQL.

## Setup

`./bootstrap.sh --setup-only` does all of the following. By hand:

1. **Configure the environment**:

   ```sh
   cp .env.example .env
   # edit DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD
   ```

2. **Start PostgreSQL** and create the database. The local cluster this project
   expects lives in `.pgdata` and listens on **port 5433**:

   ```sh
   initdb -D .pgdata -U postgres -A trust
   pg_ctl -D .pgdata -o "-k /tmp -p 5433" -l .pgdata/log start
   createdb -h 127.0.0.1 -p 5433 -U postgres -O postgres portal
   ```

   and the matching `DATABASE_URL`:

   ```
   DATABASE_URL=postgres://postgres@127.0.0.1:5433/portal
   ```

   > **The port is not optional.** `postgresql.conf` leaves `port` commented
   > out, so dropping `-p 5433` silently starts the cluster on 5432 while the
   > app keeps dialing 5433 — which surfaces as `PoolTimedOut` at startup, not
   > as a connection refusal. `just db-start` gets this right.
   >
   > `-A trust` accepts every local connection without a password. It is fine
   > for a development cluster on a loopback port and is not acceptable
   > anywhere else — see [`docs/DEPLOY.md`](./docs/DEPLOY.md).

3. **Install the frontend's dependencies**: `just install` (`npm ci` in
   `frontend/`).

4. **Migrations** run automatically on server startup (they are compiled into
   the binary), or manually with `just migrate`.

## Run

```sh
just dev                # both halves: Vite on :5173, Axum on :3000
just dev-api            # the API alone
just dev-web            # the frontend alone
just serve              # production shape: build the SPA, serve it from Axum on :3000
just ci                 # fmt-check + clippy + eslint + tsc + tests
```

`just` on its own lists every recipe: database start/stop/reset, migrations,
`psql`, port checks, cleanup.

On first boot, if the `users` table is empty, the **seed admin** is created from
`ADMIN_USERNAME` / `ADMIN_PASSWORD`. Sign in, then create users at
`/admin/users`. Create categories **first** — permissions are granted per
category, so there is nothing to grant until they exist, and a new non-admin
user with no grants sees an empty platform.

### With Docker

```sh
docker compose up --build          # app + PostgreSQL, http://127.0.0.1:3000
docker compose logs -f app
docker compose down                # stop; named volumes survive
docker compose down -v             # stop and DELETE the database and uploads
```

The image builds both halves (Node stage → Rust stage → slim runtime) and ships
one binary plus the static bundle. Configuration comes from `PORTAL_*`
variables, all with defaults, so `docker compose up` works with no setup.

## Configuration

Read once at startup by `Config::from_env` (`backend/src/config.rs`); a local
`.env` is loaded first if present.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | *(required — the app panics without it)* | Postgres connection string |
| `ADMIN_USERNAME` | `admin` | Seed admin, used only while `users` is empty |
| `ADMIN_PASSWORD` | `admin` | Seed admin password |
| `UPLOADS_DIR` | `uploads` | Where images are written; served at `/uploads/*` |
| `MAX_UPLOAD_BYTES` | `5242880` | Per-file upload limit (SR-5) |
| `BIND_ADDR` | `127.0.0.1:3000` | Where the API listens |
| `STATIC_DIR` | `static` | The built SPA to serve; unused in development |
| `CORS_ORIGINS` | *(empty)* | Comma-separated origins allowed to send credentialed requests. **Development only** — see above |
| `SECURE_COOKIE` | `0` | `Secure` on the session cookie. Set to `1` behind TLS (SR-2) |

## API

Everything is JSON, under `/api`, and every failure has the same shape:
`{"error": "a sentence to show the user"}` with a matching status code.

| | |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | sessions |
| `GET /api/categories` · `GET /api/categories/writable` · `POST` · `PUT /{id}` · `DELETE /{id}` | categories |
| `GET /api/documents?title=&category=` · `POST` · `GET /{id}` · `GET /{id}/draft` · `PUT /{id}` · `DELETE /{id}` | documents |
| `GET /api/users` · `POST` · `PUT /{id}/permissions` · `PUT /{id}/active` · `PUT /{id}/password` | admin |
| `GET /api/audit?target_type=&search=&limit=` | change history (admin) |
| `POST /api/upload` (multipart `file`) | images |
| `GET /api/health` | liveness; does not touch the database |

`/uploads/*` serves the stored files and requires a session.

## Project layout

```
bootstrap.sh               one-command local setup
justfile                   task runner: dev, ci, db-*, migrate-*
Dockerfile                 three-stage image (node → rust → slim runtime)
docker-compose.yml         app + Postgres for a single host
backend/
  migrations/              schema; embedded in the binary and applied at startup
  src/
    main.rs                router, sessions, CORS, uploads, SPA serving, shutdown
    config.rs              the environment, read once
    db.rs                  pool, migrations, seed admin, AppState
    models.rs              the wire types + the permission rule (`has_in`)
    auth.rs                argon2, sessions, and the CurrentUser/AdminUser guards
    audit.rs               the two audit-writing helpers
    content.rs             markdown → sanitized HTML, slugify
    error.rs               ApiError → status + {"error": …}
    routes/                auth, categories, documents, users, uploads, audit
frontend/
  src/
    main.tsx               React root, QueryClient
    App.tsx                the route table
    api/                   types.ts (mirrors models.rs), client.ts, endpoints.ts
    auth/AuthContext.tsx   who is signed in
    permissions.ts         the client's copy of the permission rule
    components/            Layout, RequireAuth, ConfirmButton, ThemeSelect, …
    pages/                 Login, Home, Document, Editor, Categories, AdminUsers, AuditLog
    styles/main.css        the whole stylesheet, four themes
```

## Security notes (§9)

- Passwords hashed with argon2; the hash never leaves the server, and the API's
  `User` type has no field for it.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when
  `SECURE_COOKIE=1`. The session id is cycled on login (session fixation).
- Authentication is an **extractor**, not a call you remember to make: a
  handler taking `CurrentUser` cannot run without a session, and one taking
  `AdminUser` cannot run for a non-admin.
- The category is the unit of authorization: `require_in_category` has no
  category-less variant.
- Category scoping is enforced in SQL for listings too, not just for single
  records — hiding a link in the UI is never the only control.
- Markdown is rendered and sanitized **on the server**, because the client
  inserts the result as HTML. A sanitizer running in the browser is one the
  browser can skip.
- SQLx parameterized queries throughout; upload MIME + size validated, and the
  stored extension comes from the validated MIME type, never from the client's
  filename.
- The change history is admin-gated on the server and records no secrets — a
  password reset is logged as having happened, never the password.
- Sessions use an in-memory store — swap in the tower-sessions Postgres store
  for persistence across restarts (`docs/DEPLOY.md`, Appendix B).

## Known gaps

Things the spec describes that the code does not do. Documented rather than
quietly fixed, because each is a decision for the project owner:

1. **The global `users.can_*` columns are dead weight.** No guard consults them
   and no endpoint sets them; only `seed_admin` writes them, on a row that is
   `is_admin` anyway. Either drop them in a migration or restore the additive
   rule in `User::has_in`.
2. **`list_documents` does not surface a user's own documents** from categories
   they cannot `READ` (spec FR-17 says it should).
3. **`draft` has no privacy meaning.** The editor now says so rather than
   claiming otherwise, but if drafts are meant to be author-only the listing
   and the fetch both need a status clause.
4. **No CSRF token.** Sessions rely on `SameSite=Lax`. With the API and the SPA
   on one origin that covers the ordinary cases, but it is not a token.
5. **No rate limiting on login** (SR-7).
6. **Uploads are not scoped by category** — any signed-in user can fetch any
   `/uploads/…` URL they can guess.
