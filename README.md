# Knowledge Base / Q&A Platform

An internal, admin-gated knowledge base where authorized users write and read
technical documents in a **question-and-answer** format. Built full-stack in
**Rust + Leptos** (SSR + hydration) on **Axum**, **SQLx**, and **PostgreSQL**,
per [`platform_doc.md`](./platform_doc.md).

## Features

- **No public signup** — only an admin creates users (`/admin/users`).
- **Per-user permissions**: `READ`, `WRITE`, `EDIT`, `DELETE` (independent
  flags); plus an `admin` role that holds everything.
- **Per-category permissions**: the same four flags can instead be granted on
  individual categories, so a user is confined to the categories they were
  given. Global flag OR category grant — see spec §4.2.1.
- **Q&A documents**: a title + category and an ordered list of question/answer
  blocks; answers are **Markdown**, rendered to sanitized HTML.
- **Categories**, admin-managed; each document belongs to exactly one.
- **Filtering** on the home page by **title** (ILIKE) and **category**, live.
- **Image uploads** to a local `uploads/` folder (validated: images only, ≤5 MB).
- **Change history** (`/admin/logs`, admin only): every user, permission,
  category, document and upload change is recorded with who, when, what action
  and what changed — append-only, and entries outlive what they describe.
- **argon2** password hashing, **tower-sessions** cookie sessions, permission
  guards on every server function.

### Design decisions (spec §12 open questions)

1. A user may always **edit/delete their own** document; `EDIT`/`DELETE` extend
   that to *other* people's documents.
2. Categories are managed by the **admin** only.
3. Images are stored **locally** under `uploads/`.
4. `DELETE` is implemented.
5. Q&A answers are **Markdown**.
6. Category grants are **additive** to the global flags, not a replacement —
   accounts created before category scoping keep working unchanged.

## Prerequisites

The Nix flake provides everything: the Rust toolchain **with the wasm target**,
`cargo-leptos`, `binaryen`, `sqlx-cli`, and PostgreSQL 15.

```sh
direnv allow        # or: nix develop
```

Without Nix you need: Rust stable, `wasm32-unknown-unknown` target,
`cargo install cargo-leptos`, and a running PostgreSQL.

## Setup

1. **Configure the environment**:

   ```sh
   cp .env.example .env
   # edit DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD
   ```

2. **Start PostgreSQL** and create the database. A quick local instance:

   ```sh
   initdb -D .pgdata
   pg_ctl -D .pgdata -o "-k /tmp" -l .pgdata/log start
   createdb -h /tmp portal
   # Set DATABASE_URL accordingly, e.g.
   #   postgres://<you>@/portal?host=/tmp
   ```

3. **Migrations** run automatically on server startup, or manually:

   ```sh
   sqlx migrate run
   ```

## Run

```sh
cargo leptos watch      # dev, hot-reload, http://127.0.0.1:3000
# or
cargo leptos serve --release
```

On first boot, if the `users` table is empty, the **seed admin** is created from
`ADMIN_USERNAME` / `ADMIN_PASSWORD`. Log in at `/login`, then create users at
`/admin/users`.

## Routes (§8)

| Route | Page | Access |
|-------|------|--------|
| `/login` | Login | public |
| `/` | Document list + filters | `READ` |
| `/docs/:id` | Q&A view | `READ` |
| `/docs/new` | Create document | `WRITE` |
| `/docs/:id/edit` | Edit document | `EDIT` or owner |
| `/categories` | Manage categories | admin |
| `/admin/users` | Manage users | admin |
| `/admin/logs` | Change history | admin |

Image upload endpoint: `POST /api/upload` (multipart `file`). Uploaded files are
served from `/uploads/*`.

Navigation: a top bar (brand, "New", theme, username) plus a left rail with the
sections and **Log out** at its foot; below 760px the rail hides behind the ☰
toggle. `/login` shows neither — just the centred sign-in panel.

## Project layout

```
migrations/0001_init.sql   schema (users, categories, documents, qa_blocks, uploads)
migrations/0002_…          user_category_permissions
migrations/0003_audit_log  change history
src/
  main.rs                  Axum server: sessions, routes, upload handler, seed
  lib.rs                   crate root + wasm hydrate entry
  app.rs                   Router, route table, HTML shell, shared user resource
  models.rs                shared types (client + server)
  backend.rs               (ssr) config, pool, guards, argon2, markdown, audit
  server/                  #[server] functions: auth, users, categories, documents, audit
  pages/                   login, home, document, editor, categories, admin_users, audit
  components/              navbar (top bar), sidebar (section rail), theme, confirm
style/main.css
```

## Security notes (§9)

- Passwords hashed with argon2; the hash never leaves the server.
- Session cookies are `HttpOnly`, `SameSite=Lax`. **Set `with_secure(true)` in
  `src/main.rs` when serving over HTTPS.**
- Every server function passes an auth/permission guard before touching data;
  document guards resolve the permission **against that document's category**.
- Category scoping is enforced in SQL for listings too, not just for single
  records — hiding a link in the UI is never the only control.
- Permissions are re-read from the database on every request, so revoking a
  grant takes effect immediately rather than at the user's next login.
- SQLx parameterized queries throughout; upload MIME + size validated.
- The change history is admin-gated on the server, not just hidden from the
  navigation, and records no secrets — a password reset is logged as having
  happened, never the password.
- Sessions use an in-memory store for simplicity — swap in the tower-sessions
  Postgres store for persistence across restarts.
