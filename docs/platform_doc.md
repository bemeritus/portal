# Technical Specification (TS)
## Knowledge Base / Technical Documentation Platform

*O'zbekcha: [platform_doc.uz.md](./platform_doc.uz.md)*

**Technology:** Rust (Axum) backend + React (TypeScript) frontend
**Version:** 2.0 — split into a JSON API and a single-page app; §3, §7, §8 and
§10 rewritten for the new shape. The domain model, the permission rule and the
database schema are unchanged from 1.2.
**Date:** 2026

> This document describes what the platform **does**. Where an earlier version
> described an intent the code never took up, the section says so explicitly
> rather than leaving the reader to find out from a guard. The open items are
> collected in §12 and in the README's *Known gaps*.

---

## 1. Project Overview

The platform is an **internal knowledge base** where authorized users create and read technical documents (articles). These documents are not plain articles — they are structured in a **question-and-answer (Q&A)** format. Each document contains a sequence of questions with their corresponding answers.

Core ideas:
- **No public signup.** Only an **admin** can create users.
- Every user has permissions (read / write / edit / delete), granted **per
  category** — a non-admin reaches exactly the categories they were granted.
- Documents are organized into **categories**.
- Documents can be filtered by **title** and by **category**.
- Content is a mix of text and images.

---

## 2. Goals and Objectives

| Goal | Description |
|------|-------------|
| Centralized knowledge | Store technical documents in one place |
| Controlled access | Only admin-approved users can log in |
| Structured content | Q&A format makes information easy to navigate |
| Fast lookup | Filtering by title and category |

---

## 3. Technology Stack

The platform is **two programs**, versioned together and deployed as one:

| | | |
|---|---|---|
| `backend/` | Rust | a JSON API under `/api`; in production also the static host for the frontend |
| `frontend/` | TypeScript | a single-page app; the only thing a browser talks to |

They meet at exactly one place — the HTTP contract in §7 — and at nothing else.
Version 1.x was a single Leptos program where the same Rust types were compiled
for both the server and the browser, which made the boundary implicit and free.
It is now explicit and has a cost: `frontend/src/api/types.ts` mirrors
`backend/src/models.rs` by hand, and nothing checks that it still does. That is
the price of the split and it should be paid deliberately — a struct changed on
one side is a change owed on the other.

### Backend
- **Language:** Rust (stable, pinned to 1.96 for builds)
- **Web framework:** Axum 0.8
- **DB driver:** SQLx 0.8, **runtime-checked** queries (`query`/`query_as`, not
  the compile-time `query!` macros — so nothing touches a database at build
  time, which is what lets the Docker image build without one)
- **Database:** PostgreSQL 15
- **Migrations:** `sqlx-cli` (`sqlx migrate`); also embedded in the binary and
  applied on startup
- **Static files:** `tower-http`'s `ServeDir`, with a fallback to `index.html`
  so the client router owns deep links

### Authentication & Security
- **Sessions:** `tower-sessions` 0.14, in-memory store, `HttpOnly` cookie
- **Password hashing:** `argon2` 0.5
- **Guards:** Axum extractors (`CurrentUser`, `AdminUser`) — a handler that
  takes one cannot run without it
- **CSRF protection:** *not implemented.* The API relies on the `SameSite=Lax`
  session cookie and on being same-origin with the SPA. A token would be the
  next step.
- **Validation:** hand-written per handler (non-empty username, password ≥ 6
  characters, status normalized, upload MIME whitelist).

### Frontend
- **Framework:** React 19, built by **Vite 6**
- **Language:** TypeScript, `strict`
- **Routing:** `react-router-dom` 7 (client-side)
- **Server state:** TanStack Query 5 — caching, request cancellation, and the
  "keep the old rows while the next page loads" behaviour the log needs
- **Styling:** one hand-written stylesheet, `frontend/src/styles/main.css`, four
  themes (no framework)
- **Content editing:** Markdown in a textarea; images uploaded inline

### Files (images)
- **Upload:** Axum multipart handler at `POST /api/upload`
- **Storage:** local `uploads/` folder, served by `ServeDir` **behind the
  session**

### How they run

```
development                          production
───────────                          ──────────
browser → Vite :5173                 browser → Axum :3000
            │  /api, /uploads                   ├── /api/*      JSON
            └─ proxied to :3000                 ├── /uploads/*  files, behind the session
                                                └── /*          index.html + assets
```

Development proxies rather than pointing the frontend at `:3000` directly, and
that is a security decision, not a convenience: through the proxy the session
cookie is same-origin in development exactly as it is in production. Pointed
straight at the API it would be cross-site, `SameSite=Lax` would drop it, and
the app would sign in and immediately appear signed out. `CORS_ORIGINS` exists
for the same reason and is empty in production, where there is nothing
cross-origin left to allow.

---

## 4. User Roles and Permission System

### 4.1. Roles

| Role | Description |
|------|-------------|
| **Admin** | Creates, deletes, and manages users and their permissions. Has all rights. |
| **User** | Works within the permissions granted by the admin. |

### 4.2. Permissions

The following permissions are individually enabled/disabled per user **per
category**:

| Permission | Capability |
|------------|-----------|
| `READ` | View and filter documents in that category |
| `WRITE` | Create new documents (Q&A) in that category |
| `EDIT` | Edit existing documents in that category |
| `DELETE` | Delete documents in that category |

> **Note:** Permissions are independent of each other. A user may hold only
> `READ` on one category and `READ`+`WRITE` on another. `WRITE` alone lets a
> user create a document they then cannot edit: authorship is not a permission
> (§4.2.1), so modifying it needs `EDIT` in that category too.

### 4.2.1. Scope: permissions are category grants

Every permission a non-admin holds is a **grant on one category**, stored as a
row in `user_category_permissions` (§6.6). There is no second scope:

```
allowed(user, category, perm) =
      user.is_admin                      // admins hold everything, everywhere
   OR grant(user, category, perm)        // a grant on this category
```

This is `User::has_in` in `src/models.rs`, and `backend::require_in_category` is
the only way anything is authorized. There is deliberately no category-less
variant of that guard: a permission with no category attached is exactly what
would let one flag reach into categories the user was never given.

Consequences of this rule:

- A user is **confined** to the categories they were granted something on. That
  is the only shape a non-admin account has; "platform-wide access" for a
  non-admin is expressed by granting them every category, or not at all.
- A user with **no** grant on a category cannot see it: its documents are
  excluded from listings and it does not appear in the category dropdowns.
- Permission checks are always made against **the category the document is in**.
  Moving a document to another category therefore requires rights in the
  destination as well as in the source (see SR-8).
- **Authorship confers nothing.** Reading, editing and deleting one's own
  document each require the grant on its current category (§12, decided 1).

#### The legacy global columns

`users.can_read` / `can_write` / `can_edit` / `can_delete` still exist in the
schema and are still selected into the `User` struct, but **no guard reads
them**: `create_user` leaves them at `FALSE`, the admin screen offers no
checkboxes for them, and there is no `update_permissions` server function. Only
`seed_admin` sets them, on a row that is `is_admin` anyway.

They are therefore inert. Either drop them in a migration, or restore the
additive rule by adding `|| self.can_<perm>` to `User::has_in` — but until one
of those happens, a reader of the schema alone will draw the wrong conclusion
about who can do what, which is why this paragraph exists.

### 4.3. Authentication Flow

```
Admin  --->  Creates a user (username + initial password + admin flag
             + per-category permissions)
User   --->  Logs in (username + password)
Server --->  Issues a session cookie
Each request  --->  Session + permission (for the relevant category)
                    are validated (guard)
```

- **No signup.** The `/register` route does not exist at all.
- Only `/login` exists.
- Password resets are also performed by the admin.
- Anonymous requests to anything other than `/login`, `/pkg/*` and the server
  function endpoints are redirected to `/login` by an Axum middleware, before
  any markup is rendered — a client-side check would have to stream the page
  first and correct it after hydration, which both leaks the content and shows
  a flash of the wrong page. `/api/upload` is **not** exempt: it is a plain
  handler with no authorization of its own.

---

## 5. Functional Requirements

### 5.1. Authentication
- FR-1: A user logs in with a username and password.
- FR-2: On invalid credentials, a clear error is shown (but "user not found" vs. "wrong password" are not distinguished — for security).
- FR-3: State is kept via a session cookie; a logout button exists.
- FR-4: An inactive user (`is_active = false`) cannot log in.

### 5.2. Admin Panel (user management)
- FR-5: Admin creates a new user: username, password, the admin flag, and
  per-category permissions.
- FR-6: ~~Admin changes a user's global permissions.~~ **Withdrawn in v1.2** —
  there are no global permissions to change (§4.2.1). Rights are changed through
  the category matrix, FR-22.
- FR-7: Admin blocks/activates a user.
- FR-8: Admin resets a user's password.
- FR-22: Admin assigns per-category permissions as a matrix (category × READ/WRITE/EDIT/DELETE) both when creating a user and afterwards. Saving replaces the user's grants wholesale; a category with nothing ticked is stored as no grant at all.
- FR-23: The user list shows, per user, their role, a collapsible Categories
  cell holding their grants, their active status and a password reset.

### 5.3. Categories
- FR-9: Admin (or a permitted user) creates/edits/deletes categories.
- FR-10: Each document belongs to exactly one category.
- FR-24: Deleting a category also removes every per-category grant referencing it (`ON DELETE CASCADE`); it still fails while documents reference it.

### 5.4. Documents (Question-Answer format)
- FR-11: A user with `WRITE` **in the chosen category** creates a new document: title + category.
- FR-12: A document contains multiple **Q&A blocks** (question + answer).
- FR-13: Images can be embedded within an answer's text.
- FR-14: Q&A blocks are ordered (by position/order).
- FR-15: A user with `EDIT` **in the document's current category** can edit a document and its Q&A blocks. Changing the document's category additionally requires `WRITE` or `EDIT` in the destination category.
- FR-16: Document status: `draft` or `published`, set in the editor and shown on
  the document. **It carries no access control**: a draft is visible to everyone
  who can `READ` its category. Anything not exactly `"published"` is stored as
  `"draft"`. See §12, still open.

### 5.5. Viewing and Filtering
- FR-17: A list of documents is shown (title, category, author, date),
  restricted in SQL to the categories the caller can `READ` (an admin sees all).
  **A caller's own documents in categories they cannot read are not included** —
  the query filters on category alone. See §12, still open.
- FR-18: Search/filter **by title** (via text input).
- FR-19: Filter **by category** (via dropdown/selection). The dropdown only offers categories the caller can see.
- FR-20: Both filters can work together.
- FR-21: When a document is opened, all Q&A blocks are shown in sequence.
- FR-25: The editor's category picker only offers categories the caller may write to or edit in.

### 5.6. Change history (logs)
- FR-26: Every change made on the platform is recorded: user created, per-category permissions changed, user blocked/activated, password reset, category created/renamed/deleted, document created/edited/deleted, image uploaded.
- FR-27: Each entry records **who** (username), **when** (timestamp), **what action** (`<subject>.<verb>`, e.g. `document.update`), **on what** (the target's name as it read at the time) and **the specifics** — which fields changed and from what to what.
- FR-28: The log is visible to administrators only, at `/admin/logs`, newest first, with a free-text search and a filter by kind (users / categories / documents / uploads).
- FR-29: The log is append-only. Nothing in the platform edits or deletes an entry, and an entry outlives the row it describes — deleting a document leaves the record of the deletion, including the title it had.

---

## 6. Database Schema

### 6.1. `users`
| Column | Type | Note |
|--------|------|------|
| id | UUID (PK) | |
| username | TEXT (unique) | |
| password_hash | TEXT | argon2 |
| is_admin | BOOLEAN | admin flag — the only thing that grants beyond a category |
| can_read | BOOLEAN | **legacy, inert** — no guard reads it |
| can_write | BOOLEAN | **legacy, inert** |
| can_edit | BOOLEAN | **legacy, inert** |
| can_delete | BOOLEAN | **legacy, inert** |
| is_active | BOOLEAN | blocked/active; an inactive user cannot log in and is treated as absent mid-session |
| created_at | TIMESTAMPTZ | |
| created_by | UUID (FK → users.id) | who created it |

> The four `can_*` columns no longer authorize anything — see the end of §4.2.1.
> All rights for a non-admin come from `user_category_permissions` (§6.6). New
> users are created with all four `FALSE`; only `seed_admin` sets them.

### 6.2. `categories`
| Column | Type | Note |
|--------|------|------|
| id | UUID (PK) | |
| name | TEXT (unique) | |
| slug | TEXT (unique) | for URLs |
| description | TEXT | optional |
| created_at | TIMESTAMPTZ | |

### 6.3. `documents`
| Column | Type | Note |
|--------|------|------|
| id | UUID (PK) | |
| title | TEXT | for search/filter |
| category_id | UUID (FK → categories.id) | |
| author_id | UUID (FK → users.id) | |
| status | TEXT | 'draft' \| 'published' |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

Indexes: `title` (for search via `GIN`/`trigram` or plain `ILIKE`), `category_id`.

### 6.4. `qa_blocks` (question-answer within a document)
| Column | Type | Note |
|--------|------|------|
| id | UUID (PK) | |
| document_id | UUID (FK → documents.id, ON DELETE CASCADE) | |
| question | TEXT | question |
| answer | TEXT | answer (markdown/HTML, with image references) |
| position | INTEGER | order |
| created_at | TIMESTAMPTZ | |

### 6.5. `uploads` (images)
| Column | Type | Note |
|--------|------|------|
| id | UUID (PK) | |
| file_path | TEXT | stored path/URL |
| original_name | TEXT | |
| uploaded_by | UUID (FK → users.id) | |
| uploaded_at | TIMESTAMPTZ | |

### 6.6. `user_category_permissions` (per-category grants)
| Column | Type | Note |
|--------|------|------|
| user_id | UUID (FK → users.id, ON DELETE CASCADE) | PK part 1 |
| category_id | UUID (FK → categories.id, ON DELETE CASCADE) | PK part 2 |
| can_read | BOOLEAN | grant, default `false` |
| can_write | BOOLEAN | grant, default `false` |
| can_edit | BOOLEAN | grant, default `false` |
| can_delete | BOOLEAN | grant, default `false` |
| granted_by | UUID (FK → users.id, ON DELETE SET NULL) | which admin assigned it |
| granted_at | TIMESTAMPTZ | |

Primary key `(user_id, category_id)` — at most one row per pair. A row with all
four flags `false` is equivalent to no row and is not stored. Index on
`category_id` for the reverse lookup ("who can touch this category?").

### 6.7. Relationship Diagram
```
users (1) ────< documents (N)
categories (1) ────< documents (N)
documents (1) ────< qa_blocks (N)
users (1) ────< uploads (N)

users (1) ────< user_category_permissions (N) >──── (1) categories

users (1) ────< audit_log (N)      # actor only; the target is by id + name, unlinked
```

### 6.8. `audit_log` (change history)
| Column | Type | Note |
|--------|------|------|
| id | UUID | PK |
| at | TIMESTAMPTZ | when, default `now()` |
| actor_id | UUID (FK → users.id, ON DELETE SET NULL) | who, for grouping after a rename |
| actor_name | TEXT | who, as the name read at the time |
| action | TEXT | `<subject>.<verb>`, e.g. `category.delete` |
| target_type | TEXT | `user` \| `category` \| `document` \| `upload` |
| target_id | UUID, **no FK** | the row acted on, if it had an id |
| target_name | TEXT | its name/title at the time |
| details | TEXT, nullable | what changed, one line; `NULL` when the action says everything |

Deliberately denormalized. `target_id` carries **no** foreign key because an
entry must survive its subject: with one, deleting a document would erase the
record that it was deleted — the entry an admin most wants. The two name columns
are stored rather than joined for the same reason, and because a join would
silently rewrite history when a user or category is later renamed. Indexes on
`at DESC`, on `(target_type, at DESC)` and on `actor_id` — the three ways the
admin screen reads it.

---

## 7. HTTP API

Everything is JSON under `/api`. Version 1.x used Leptos server functions,
which were Rust calls that happened to cross the network; these are ordinary
endpoints, so the status code carries the outcome instead of a prefix inside an
error string.

**Failures all have one shape** — `{"error": "a sentence to show the user"}` —
with the status saying which kind:

| Status | Meaning |
|---|---|
| `400` | The request is wrong: empty title, password under 6 characters, unreadable multipart. |
| `401` | No session, or one that no longer resolves to an active user. |
| `403` | Authenticated, but without the permission this needs. |
| `404` | No such row, or no such endpoint. |
| `409` | A unique or foreign-key constraint the caller can resolve: a taken username, a category that still has documents. |
| `413` | Over `MAX_UPLOAD_BYTES`. |
| `500` | Ours. The cause is logged server-side; the caller gets one generic sentence and nothing about the inside of the system. |

### Auth
| | |
|---|---|
| `POST /api/auth/login` | `{username, password}` → `User`. Returns the user, so the client needs no second request. Cycles the session id (fixation). |
| `POST /api/auth/logout` | → `204` |
| `GET /api/auth/me` | → `User`, or `401`. How the SPA decides, on load, whether to show the app or the login page. |

### Categories
| | |
|---|---|
| `GET /api/categories` | The categories the caller can **see**: all of them for an admin, otherwise those they hold a grant on. |
| `GET /api/categories/writable` | The subset they may `WRITE` or `EDIT` in — what the editor's picker offers (FR-25). |
| `POST /api/categories` | `{name, description}` → `Category`, `201`. Admin. |
| `PUT /api/categories/{id}` | `{name, description}` → `204`. Admin. |
| `DELETE /api/categories/{id}` | → `204`. Admin. `409` while documents still reference it. |

### Documents
| | |
|---|---|
| `GET /api/documents?title=&category=` | Narrowed **in SQL** to the caller's `READ` categories. Both filters optional, combinable. |
| `POST /api/documents` | `{title, category_id, status, blocks}` → `{id}`, `201`. Requires `WRITE` **in `category_id`**. |
| `GET /api/documents/{id}` | → `DocumentWithBlocks`, answers already rendered to sanitized HTML. Requires `READ` in its category. |
| `GET /api/documents/{id}/draft` | The same document as raw Markdown, for the editor. Requires `EDIT`. |
| `PUT /api/documents/{id}` | Requires `EDIT` in the current category; moving it additionally requires `WRITE`/`EDIT` in the destination (SR-8). Blocks are replaced wholesale, which is what preserves their ordering (FR-14). |
| `DELETE /api/documents/{id}` | → `204`. Requires `DELETE` in its category; blocks cascade. |

> None of these has an ownership fallback: authorship is not a permission
> (§4.2.1). The guard is the same for the author as for anyone else.

### Users (admin only)
| | |
|---|---|
| `GET /api/users` | Every user with their grants (FR-23). |
| `POST /api/users` | `{username, password, is_admin, category_perms}` → `{id}`, `201`. Grants with nothing ticked are dropped and duplicate rows for one category are OR-ed together before storing. |
| `PUT /api/users/{id}/permissions` | `{category_perms}` → `204`. Replaces the grants wholesale. |
| `PUT /api/users/{id}/active` | `{active}` → `204`. `400` on disabling your own account. |
| `PUT /api/users/{id}/password` | `{new_password}` → `204`. |

> There is no endpoint for the global `can_*` flags: with them inert (§4.2.1)
> there is nothing for one to set. The API does not even send them — `User` has
> no such field, so no client can come to depend on one.

### Files
| | |
|---|---|
| `POST /api/upload` | multipart `file` → `{url, markdown}`. The `markdown` is the `![alt](url)` snippet the editor inserts directly. |
| `GET /uploads/{file}` | The stored image. Outside `/api`, but behind the same session. |

### Change history (admin only)
| | |
|---|---|
| `GET /api/audit?target_type=&search=&limit=` | Newest first. `target_type` narrows to one kind, `search` matches actor / target / action / details, `limit` is clamped server-side to 1..500. |

> There is deliberately **no** endpoint that writes, edits or deletes an entry.
> Entries are written by the operations they describe, through `audit::audit_tx`
> (inside the transaction that makes the change, so record and change commit
> together) or `audit::audit_now` (after a change that has already committed —
> there a failed insert is logged server-side and never turned into an error the
> user sees, since the change did happen).

### Other
| | |
|---|---|
| `GET /api/health` | `{"status":"ok"}`. Touches no database, so it still answers while Postgres is down — which is the state you most want to be able to ask about. |

> **Guards are extractors.** A handler that takes `CurrentUser` cannot run
> without a session and one that takes `AdminUser` cannot run for a non-admin,
> because the request never reaches the body otherwise — where v1.x had to open
> every server function with `require_user().await?` and trust that nobody
> forgot. What no extractor can decide is the *category*, since that depends on
> which document the request names; `require_in_category` stays an explicit call
> and, as before, has no category-less variant.

> **Unmatched paths under `/api` return a JSON `404`**, not the SPA's
> `index.html`. Otherwise a mistyped endpoint comes back as a document with
> status `200` and the client fails while parsing it, reporting a syntax error
> instead of the actual mistake.

---

## 8. Pages (routes) and UI

| Route | Page | Access |
|-------|------|--------|
| `/login` | Login form | Public |
| `/` | Document list + filters | Any session (contents narrowed to `READ` categories) |
| `/docs/:id` | Single document (Q&A view) | `READ` in that document's category |
| `/docs/new` | Create new document | `WRITE` in at least one category |
| `/docs/:id/edit` | Edit document | `EDIT` in that document's category |
| `/categories` | Manage categories | Admin |
| `/admin/users` | Manage users | Admin |
| `/admin/logs` | Change history | Admin |

These are **client-side** routes owned by `react-router-dom`
(`frontend/src/App.tsx`). The server does not know them: it serves
`index.html` for any path it does not recognise, so a deep link or a refresh on
`/docs/<id>/edit` reaches the client router rather than a 404.

The "Access" column describes what the UI *shows*. Every one of these pages
makes requests that the server checks again (SR-9); the guards here exist so
that an anonymous visitor never sees a page frame before being sent to the
login form, and so that a non-admin typing `/admin/users` gets a sentence
instead of an empty table full of failed requests.

**Chrome (every page except `/login`):**
- A **top bar** with the brand, the "New" shortcut (shown when the user may
  `WRITE` somewhere), the theme switcher and the signed-in username.
- A **left rail** with the sections — Documents, plus Categories / Users / Logs
  for an admin — and **Log out** at its foot, in the danger colour so it is not
  mistaken for another section link.
- `/login` renders **neither**: it is the one public page and has nothing to
  navigate to, so it is a centred sign-in panel on an otherwise empty window.
- Below 760px the rail collapses behind the bar's ☰ toggle; the two share one
  open/closed state, held by the layout component that renders both. Following
  a section link closes it — otherwise the rail stays open over the page it
  was just asked for.

**Home page (`/`) contents:**
- Search bar at the top: title input + category dropdown.
- Document list below, as cards.
- Both filters live in the URL's query string, so a filtered list can be
  linked and survives a refresh.
- The title filter is **debounced**: one query per pause in typing, not one per
  keystroke, and each new query cancels the one before it. Without that,
  typing "postgres" is eight requests racing each other and the list settles on
  whichever happens to land last.

**Document page (`/docs/:id`):**
- Title, category, author, status.
- Q&A blocks in sequence, each shown as "Question → Answer"; a jump list
  appears above five questions.
- Answers are inserted as HTML, which is safe only because the **server**
  rendered and sanitized them (§3). Markdown rendered in the browser would put
  the sanitizer where the browser could skip it.
- The Edit / Delete buttons appear only when the viewer holds that permission
  **in this document's category**. Authoring the document does not put them
  there.

**Editor (`/docs/new`, `/docs/:id/edit`):**
- Title, category and status, then the Q&A blocks in order. Blocks can be
  added, removed and moved; the array's order is the document's order (FR-14).
- Each block has an **Insert image** button: the file is uploaded immediately
  and the returned Markdown lands at the caret in that block's answer.
- Save is disabled until there is a title and a category, and says which is
  missing rather than leaving a dead button.
- The status field says plainly that it is a label and not a permission
  (§12.9). The previous version's hint claimed drafts "stay hidden from other
  readers", which was never true.

**Users page (`/admin/users`):**
- "Create user" form: username, initial password, the admin flag, then a
  **category matrix** — one row per category with Read / Write / Edit / Delete
  checkboxes.
- User table: username, role, a collapsible **Categories** cell holding the same
  matrix pre-filled from the user's current grants (with its own Save),
  block/activate, password reset.
- Admins show "all" in the Categories column — there is nothing to edit.
- There are no global permission checkboxes anywhere, because there are no
  global permissions (§4.2.1).

**Logs page (`/admin/logs`):**
- Table: When (UTC) / Who / Action / Target / Details, newest first.
- Free-text search and a "Kind" dropdown (everything / users / categories /
  documents / uploads); a new filter restarts from the first page.
- "Load more" raises the limit by 100 while a full page comes back.
- Times are shown in **UTC** and the column says so — the browser's offset is
  not the server's, and a log that quietly shifts times is worse than one that
  is explicit about the zone.
- A document target links to the document, except where the entry records its
  deletion (that link could only 404).

---

## 9. Security Requirements

- SR-1: Passwords are hashed with **argon2**, never stored in plaintext.
- SR-2: Session cookies are `HttpOnly` and `SameSite=Lax`. `Secure` comes from
  `SECURE_COOKIE` in the environment — it is off by default for local HTTP and
  must be set for any TLS deployment (`DEPLOY.md` step 6). It was a source edit
  in v1.x, which meant a forgotten edit shipped cookies that travel in clear.
  The session id is cycled on login, so a cookie captured beforehand cannot be
  used after it (fixation).
- SR-3: A permission guard is mandatory on every endpoint. Authentication is an
  extractor, so a handler cannot run without it (§7); the category check is an
  explicit call, and `require_in_category` has no category-less variant.
- SR-4: No signup endpoint exists at all. Anonymous requests to the API get
  `401` and the SPA sends the visitor to `/login`; `/uploads/*` is behind the
  session too, so an image URL is not a way around it.
- SR-5: On file upload, MIME type and size are validated: `image/png`,
  `image/jpeg`, `image/gif`, `image/webp` only, ≤ `MAX_UPLOAD_BYTES` (5 MB by
  default). The stored filename is a fresh UUID plus an extension derived from
  the *validated MIME type*, never from the name the client sent.
- SR-6: Protection against SQL injection — SQLx parameterized queries.
- SR-7: Rate limiting on login attempts — **not implemented**; recommended.
- SR-8: Re-categorizing a document is treated as a write into the destination: without rights there, the move is rejected. Otherwise a user could push a document into a category they cannot touch and lose access to it — or place content where it was never meant to appear.
- SR-9: Category scoping is enforced server-side, in SQL, for listings as well as for single-record access. Hiding a link or a dropdown entry in the UI is presentation only and is never the sole control.
- SR-10: The current user's row **and** grants are re-read from the database on every request, so a revoked grant — or a deactivated account — takes effect immediately rather than at the next login.
- SR-11: The change history is admin-only on the server (`require_admin` in `list_audit_log`), not merely hidden in the navigation: it names who did what to accounts a non-admin cannot otherwise see.
- SR-12: The history is append-only and stores no secrets. A password reset is recorded as having happened, by whom and when — never the password itself.
- SR-13: Markdown is rendered **and sanitized on the server**. The frontend
  inserts the result as HTML, so the sanitizer is what stands between an
  authored `<script>` and every later reader; running it in the browser would
  put that control where the browser can skip it.
- SR-14: `CORS_ORIGINS` is empty in production. It exists for the development
  proxy only, and it names explicit origins rather than `*` — a wildcard cannot
  carry credentials, and credentials are the entire point of the session
  cookie.

---

## 10. Project Structure

The layout as built. Two crates' worth of separation, one repository.

On the backend, auth is not a directory: sessions, guards and hashing are one
concern and live in `auth.rs`. Neither is "server-only" a compile flag any
more — the whole crate is server-only, so the `#[cfg(feature = "ssr")]` that
used to be on nearly every item is simply gone.

```
platform/
├── bootstrap.sh                # one-command local setup
├── justfile                    # dev, ci, db-*, migrate-*
├── flake.nix                   # pinned Rust + Node + PostgreSQL 15
├── Dockerfile                  # node build → rust build → slim runtime
├── docker-compose.yml          # app + Postgres on one host
├── uploads/                    # uploaded images (runtime state)
│
├── backend/
│   ├── Cargo.toml
│   ├── migrations/             # sqlx migrations, embedded in the binary
│   │   ├── 0001_init.sql                    # users, categories, documents, qa_blocks, uploads
│   │   ├── 0002_category_permissions.sql    # user_category_permissions
│   │   └── 0003_audit_log.sql               # audit_log
│   └── src/
│       ├── main.rs             # router, session layer, CORS, uploads, SPA serving, shutdown
│       ├── config.rs           # the environment, read once
│       ├── db.rs               # pool, migrations, seed admin, AppState
│       ├── models.rs           # the wire types + the permission rule (`has_in`)
│       ├── auth.rs             # argon2, sessions, CurrentUser / AdminUser extractors
│       ├── audit.rs            # audit_tx / audit_now
│       ├── content.rs          # markdown → sanitized HTML, slugify
│       ├── error.rs            # ApiError → status + {"error": …}
│       └── routes/
│           ├── mod.rs          # the /api tree and its JSON 404
│           ├── auth.rs
│           ├── categories.rs
│           ├── documents.rs
│           ├── users.rs
│           ├── uploads.rs
│           └── audit.rs        # reading the change history (admin)
│
└── frontend/
    ├── package.json
    ├── vite.config.ts          # dev server + the /api and /uploads proxies
    ├── index.html              # the shell, plus the pre-paint theme script
    └── src/
        ├── main.tsx            # React root, QueryClient, providers
        ├── App.tsx             # the route table
        ├── api/
        │   ├── types.ts        # mirrors backend/src/models.rs — by hand (§3)
        │   ├── client.ts       # fetch wrapper, ApiError, credentials: "include"
        │   └── endpoints.ts    # one typed function per endpoint
        ├── auth/AuthContext.tsx  # who is signed in
        ├── permissions.ts      # the client's copy of the permission rule
        ├── format.ts           # dates, and the log's UTC timestamps
        ├── components/         # Layout, RequireAuth, ConfirmButton, ThemeSelect,
        │                       #   Flash, Loading
        ├── pages/              # Login, Home, Document, Editor, Categories,
        │                       #   AdminUsers, AuditLog
        └── styles/main.css     # the whole stylesheet, four themes
```

---

## 11. Development Phases (roadmap)

### Phase 1 — Foundation
- Project skeleton (Leptos + Axum + SQLx).
- DB connection and migrations.
- `users` table and admin account (seed).

### Phase 2 — Authentication
- Login/logout, session, guard.
- Admin panel: create user + permissions.

### Phase 3 — Content
- Categories CRUD.
- Document creation (with Q&A blocks).
- Image upload.

### Phase 4 — Viewing and Filtering
- Document list.
- Title + category filter.
- Document page (Q&A view).

### Phase 5 — Polish
- Editing (`EDIT`), status (draft/published).
- Security checks, error handling, design.

### Phase 6 — Category-scoped permissions
- `user_category_permissions` table and the resolution rule (§4.2.1).
- Category-aware guards on every document server function; listings narrowed in SQL.
- Admin UI: the category matrix on user creation and on each existing user.
- The global `can_*` flags dropped out of the resolution rule and out of the UI;
  the columns stayed behind. §4.2.1 records where that leaves them.

### Phase 7 — Navigation and change history
- Sections moved from the top bar into a left rail; `/login` stripped of all
  chrome; logging out moved to the foot of the rail (§8).
- `audit_log` table (§6.8) and the two recording helpers.
- Every mutating operation records who/when/what/what-changed: users,
  per-category permissions, categories, documents, uploads (§5.6).
- `/admin/logs` — admin-only listing with search, kind filter and paging.

### Phase 8 — Packaging and operations
- `bootstrap.sh`: clone-to-running-app in one command, with or without Nix.
- `justfile`: the recipes that keep the local cluster's port and role right.
- `Dockerfile` + `docker-compose.yml`, with the toolchain versions pinned as
  build args — including the `wasm-opt` pin without which the release bundle
  hydrates into an unusable page.
- `DEPLOY.md`: systemd + nginx + Let's Encrypt on Ubuntu.

### Phase 9 — Split into a backend and a frontend (v2.0)
- Leptos removed. `backend/` became a plain Axum JSON API (§7); `frontend/`
  became a Vite + React single-page app.
- Guards became extractors; errors became status codes with one JSON shape.
- The permission rule, the schema, the audit log and the stylesheet were carried
  over unchanged — this was a change of delivery, not of behaviour.
- The one thing that got *better* rather than merely different: uploads. A JSON
  response carrying the `![alt](url)` snippet let the editor insert an image
  into the answer being written, where the SSR version could only open the
  upload in a new tab for the author to copy back by hand.
- The one thing that got worse: the type boundary. §3 says what that costs.

---

## 12. Open Questions

### Decided

1. **Can a user edit a document they created without the `EDIT` permission?**
   **No.** Authorship carries no rights of its own: reading, editing and
   deleting a document each require the matching grant on the category it sits
   in. An author who loses the grant loses access to what they wrote. This is
   the one decision that reversed during implementation — the guards were
   written category-first and never grew an ownership branch — and it is worth
   re-examining, because "I can no longer open the document I wrote yesterday"
   is a surprising thing for a platform to tell someone.
2. **Are categories managed only by the admin, or by permitted users too?**
   **Admin only.** Any authenticated user may *list* the categories they can
   see (the filters need it), but create/rename/delete is `is_admin`.
3. **Are images stored locally or in the cloud (S3)?**
   **Locally**, under `UPLOADS_DIR` (default `uploads/`), served by `ServeDir`
   at `/uploads/*`. In production this is the one piece of state Postgres does
   not hold, so it needs its own backup (`DEPLOY.md`).
4. **Is the `DELETE` permission needed, or are documents only archived?**
   **`DELETE` is implemented** and deletes for real; `qa_blocks` cascade. The
   audit entry survives, carrying the title the document had.
5. **Format for Q&A answers: markdown, plain text, or rich text?**
   **Markdown**, rendered server-side by `pulldown-cmark` and sanitized by
   `ammonia` before it reaches a browser.
6. **How do category permissions combine with the global ones?**
   **They don't — the global flags are gone from the model.** A non-admin's
   rights are exactly their grants (§4.2.1). The columns remain in `users` and
   are inert; whether to drop them is item 8 below.

### Still open

7. Should uploads be scoped by category as well? Today `/uploads/…` URLs are
   readable by anyone with a session, regardless of which document embeds them.
8. Should the inert `users.can_*` columns be dropped in a migration, or should
   `has_in` be taught to read them again? Leaving them is the one option that
   keeps misleading whoever reads the schema next (§4.2.1).
9. Should `draft` mean anything for visibility? At present it does not: a draft
   is as readable as a published document to anyone with `READ` on its category
   (FR-16). If drafts are meant to be private to their author, both
   `list_documents` and `get_document` need a status clause — and that clause
   needs an author exception, which item 1 currently forbids.
10. Should `list_documents` include the caller's own documents from categories
    they cannot `READ`, as FR-17 originally said? It does not today. The answer
    follows from item 1: if authorship grants nothing, then it should not, and
    FR-17 was the thing that was wrong.
11. Rate limiting on login (SR-7) — not implemented. On an internal platform
    with no signup the exposure is small, but the login endpoint is the one
    thing an anonymous visitor can reach.
12. CSRF tokens (§3). `SameSite=Lax` plus a same-origin SPA covers the ordinary
    cases, but it is not a token, and the day the frontend moves to another
    origin it stops covering anything.
13. The wire types are mirrored by hand between `backend/src/models.rs` and
    `frontend/src/api/types.ts` (§3). Nothing checks that they agree — a field
    renamed on one side type-checks on both and fails at runtime. Generating the
    TypeScript from the Rust, or asserting the contract in a test, would close
    it; both are work the split created and neither is done.
14. Sessions are in memory, so every restart signs everyone out and a second
    instance would not share them. `DEPLOY.md` Appendix B has the Postgres
    store; nothing in the code prevents it, it simply has not been switched.
