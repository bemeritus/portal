# Technical Specification (TS)
## Knowledge Base / Technical Documentation Platform

**Technology:** Rust + Leptos (full-stack)
**Version:** 1.1 — adds category-scoped permissions (§4.2.1, §6.6)
**Date:** 2026

---

## 1. Project Overview

The platform is an **internal knowledge base** where authorized users create and read technical documents (articles). These documents are not plain articles — they are structured in a **question-and-answer (Q&A)** format. Each document contains a sequence of questions with their corresponding answers.

Core ideas:
- **No public signup.** Only an **admin** can create users.
- Every user has permissions (read / write / edit), granted either globally or **per category**.
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

### Backend
- **Language:** Rust (stable)
- **Framework:** Leptos (SSR + hydration, server functions)
- **Web server:** Axum (via `leptos_axum` integration)
- **ORM / DB driver:** SQLx (compile-time checked queries) — alternative: SeaORM
- **Database:** PostgreSQL
- **Migrations:** `sqlx-cli` (`sqlx migrate`)

### Authentication & Security
- **Sessions:** `tower-sessions` (or `axum-login`)
- **Password hashing:** `argon2`
- **CSRF protection:** token for server functions
- **Validation:** `validator` crate

### Frontend (inside Leptos)
- **Reactivity:** Leptos signals / resources
- **Routing:** `leptos_router`
- **Styling:** Tailwind CSS or plain CSS modules
- **Image/content editing:** markdown or simple rich-text (embed images by URL)

### Files (images)
- **Upload:** Axum multipart handler
- **Storage:** local `uploads/` folder (or S3-compatible object storage)

---

## 4. User Roles and Permission System

### 4.1. Roles

| Role | Description |
|------|-------------|
| **Admin** | Creates, deletes, and manages users and their permissions. Has all rights. |
| **User** | Works within the permissions granted by the admin. |

### 4.2. Permissions

The following permissions are individually enabled/disabled per user:

| Permission | Capability |
|------------|-----------|
| `READ` | View and filter documents |
| `WRITE` | Create new documents (Q&A) |
| `EDIT` | Edit existing documents |
| `DELETE` *(optional)* | Delete documents |

> **Note:** Permissions are independent of each other. For example, a user may have only `READ`. A user with `WRITE` needs `EDIT` as well to modify their own document (or you can adopt the rule "a user can always edit their own document" — this is decided by the project owner).

### 4.2.1. Scope: global vs. per-category

Every permission is held at one of two scopes:

| Scope | Stored in | Meaning |
|-------|-----------|---------|
| **Global** | `users.can_read` / `can_write` / `can_edit` / `can_delete` | The permission applies in **every** category. |
| **Per-category** | `user_category_permissions` (one row per user × category) | The permission applies **only** in that category. |

The two are **additive** — a per-category grant adds rights on top of the global
flags, it never takes them away:

```
effective(user, category, perm) =
      user.is_admin                      // admins hold everything
   OR user.can_<perm>                    // global flag → all categories
   OR grant(user, category, perm)        // grant on this category only
```

Consequences of this rule:

- A user meant to be **confined** to a few categories has all global flags off
  and grants on just those categories.
- A user with a global flag on keeps the platform-wide behaviour of v1.0, so
  existing accounts are unaffected by the introduction of category scoping.
- A user with **no** global flag and **no** grant on a category cannot see that
  category at all: its documents are excluded from listings and it does not
  appear in the category dropdowns.
- Permission checks are always made against **the category the document is in**.
  Moving a document to another category therefore requires rights in the
  destination as well as in the source (see SR-8).

### 4.3. Authentication Flow

```
Admin  --->  Creates a user (username + initial password
             + global permissions + per-category permissions)
User   --->  Logs in (username + password)
Server --->  Issues a session cookie
Each request  --->  Session + permission (for the relevant category)
                    are validated (guard)
```

- **No signup.** The `/register` route does not exist at all.
- Only `/login` exists.
- Password resets are also performed by the admin.

---

## 5. Functional Requirements

### 5.1. Authentication
- FR-1: A user logs in with a username and password.
- FR-2: On invalid credentials, a clear error is shown (but "user not found" vs. "wrong password" are not distinguished — for security).
- FR-3: State is kept via a session cookie; a logout button exists.
- FR-4: An inactive user (`is_active = false`) cannot log in.

### 5.2. Admin Panel (user management)
- FR-5: Admin creates a new user: username, password, global permissions, and per-category permissions.
- FR-6: Admin changes a user's global permissions (READ/WRITE/EDIT/DELETE).
- FR-7: Admin blocks/activates a user.
- FR-8: Admin resets a user's password.
- FR-22: Admin assigns per-category permissions as a matrix (category × READ/WRITE/EDIT/DELETE) both when creating a user and afterwards. Saving replaces the user's grants wholesale; a category with nothing ticked is stored as no grant at all.
- FR-23: The user list shows, per user, the global flags and how many categories they have been granted something on.

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
- FR-16: Document status: `draft` or `published`.

### 5.5. Viewing and Filtering
- FR-17: A list of documents is shown (title, category, author, date), restricted to the categories the caller can `READ`, plus their own documents.
- FR-18: Search/filter **by title** (via text input).
- FR-19: Filter **by category** (via dropdown/selection). The dropdown only offers categories the caller can see.
- FR-20: Both filters can work together.
- FR-21: When a document is opened, all Q&A blocks are shown in sequence.
- FR-25: The editor's category picker only offers categories the caller may write to or edit in.

---

## 6. Database Schema

### 6.1. `users`
| Column | Type | Note |
|--------|------|------|
| id | UUID (PK) | |
| username | TEXT (unique) | |
| password_hash | TEXT | argon2 |
| is_admin | BOOLEAN | admin flag |
| can_read | BOOLEAN | **global** permission (all categories) |
| can_write | BOOLEAN | **global** permission (all categories) |
| can_edit | BOOLEAN | **global** permission (all categories) |
| can_delete | BOOLEAN | **global** permission (all categories, optional) |
| is_active | BOOLEAN | blocked/active |
| created_at | TIMESTAMPTZ | |
| created_by | UUID (FK → users.id) | who created it |

> These four columns are the *global* scope of §4.2.1. Category-scoped grants
> live in `user_category_permissions` (§6.6); the two are combined additively.

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
```

---

## 7. Server Functions / API

In Leptos these are written as **server functions** (`#[server]`). Approximate list:

### Auth
- `login(username, password) -> Result<User>`
- `logout() -> Result<()>`
- `current_user() -> Option<User>`

### Admin (only `is_admin`)
- `create_user(username, password, is_admin, global_permissions, category_perms_json) -> Result<()>` — `category_perms_json` is a JSON array of `CategoryPermission { category_id, can_read, can_write, can_edit, can_delete }`; pass `[]` for none
- `update_permissions(user_id, permissions) -> Result<()>` — the **global** flags only
- `update_category_permissions(user_id, category_perms_json) -> Result<()>` — replaces the user's grants wholesale
- `set_user_active(user_id, active) -> Result<()>`
- `reset_password(user_id, new_password) -> Result<()>`
- `list_users() -> Result<Vec<User>>` — each `User` carries its per-category grants

### Categories
- `create_category(name, description) -> Result<Category>`
- `list_categories() -> Result<Vec<Category>>` — the categories the caller can **see**: all of them for an admin or anyone holding a global flag, otherwise only those they hold a grant on
- `list_writable_categories() -> Result<Vec<Category>>` — the subset the caller may `WRITE` or `EDIT` in; what the editor's picker offers
- `update_category(...)`, `delete_category(...)`

### Documents
- `create_document(title, category_id, blocks) -> Result<Document>` — requires `WRITE` **in `category_id`**
- `update_document(id, title, category_id, blocks) -> Result<()>` — requires `EDIT` in the document's current category (or ownership); moving it additionally requires `WRITE`/`EDIT` in the destination
- `get_document(id) -> Result<DocumentWithBlocks>` — requires `READ` in the document's category (or ownership)
- `list_documents(title_filter, category_filter) -> Result<Vec<DocumentSummary>>` — narrowed in SQL to the caller's `READ` categories plus their own documents
- `delete_document(id) -> Result<()>` — requires `DELETE` in the document's category (or ownership)

### Files
- `upload_image(bytes, filename) -> Result<String /* URL */>`

> Every server function has a **guard**: first the session, then the permission
> is checked. Guards that concern a document or category check the permission
> **in that category** (`require_in_category`), not merely globally. If the
> permission is missing, a `403` is returned.

---

## 8. Pages (routes) and UI

| Route | Page | Access |
|-------|------|--------|
| `/login` | Login form | Public |
| `/` | Document list + filters | Any session (contents narrowed to `READ` categories) |
| `/docs/:id` | Single document (Q&A view) | `READ` in that document's category, or author |
| `/docs/new` | Create new document | `WRITE` in at least one category |
| `/docs/:id/edit` | Edit document | `EDIT` in that document's category, or author |
| `/categories` | Manage categories | Admin |
| `/admin/users` | Manage users | Admin |

**Home page (`/`) contents:**
- Search bar at the top: title input + category dropdown.
- Document list below (cards or table).
- When a filter changes, the list updates reactively (Leptos `Resource`).

**Document page (`/docs/:id`):**
- Title, category, author.
- Q&A blocks in sequence: each shown as "Question → Answer" (e.g., accordion or plain list).
- The Edit / Delete buttons appear only when the viewer holds that permission
  **in this document's category**, or authored it.

**Users page (`/admin/users`):**
- "Create user" form: username, initial password, the global permission
  checkboxes, then a **category matrix** — one row per category with Read /
  Write / Edit / Delete checkboxes.
- User table: username, role, the global flags (inline, with Save), a
  collapsible **Categories** cell holding the same matrix pre-filled from the
  user's current grants (with its own Save), block/activate, password reset.
- Admins show "all" for both permission columns — there is nothing to edit.

---

## 9. Security Requirements

- SR-1: Passwords are hashed with **argon2**, never stored in plaintext.
- SR-2: Session cookies are `HttpOnly`, `Secure`, `SameSite=Lax`.
- SR-3: A permission guard is mandatory in all server functions. Where the operation concerns a document or a category, the guard resolves the permission **against that category** (§4.2.1).
- SR-4: No signup endpoint exists at all.
- SR-5: On file upload, MIME type and size are validated (images only, e.g. ≤ 5MB).
- SR-6: Protection against SQL injection — SQLx parameterized queries.
- SR-7: Rate limiting on login attempts — optional but recommended.
- SR-8: Re-categorizing a document is treated as a write into the destination: without rights there, the move is rejected. Otherwise a user could push a document into a category they cannot touch and lose access to it — or place content where it was never meant to appear.
- SR-9: Category scoping is enforced server-side, in SQL, for listings as well as for single-record access. Hiding a link or a dropdown entry in the UI is presentation only and is never the sole control.
- SR-10: The current user's permissions (global flags **and** grants) are re-read from the database on every request, so a revoked grant takes effect immediately rather than at the next login.

---

## 10. Project Structure (approximate)

```
platform/
├── Cargo.toml
├── migrations/                 # sqlx migrations
│   ├── 0001_init.sql                    # users, categories, documents, qa_blocks, uploads
│   └── 0002_category_permissions.sql    # user_category_permissions
├── src/
│   ├── main.rs                 # start Axum + Leptos
│   ├── app.rs                  # main Leptos component + router
│   ├── auth/
│   │   ├── mod.rs
│   │   ├── session.rs
│   │   └── guard.rs            # permission checks
│   ├── models/                 # User, Document, Category, QaBlock
│   ├── server/                 # #[server] functions
│   │   ├── auth.rs
│   │   ├── users.rs
│   │   ├── documents.rs
│   │   └── categories.rs
│   ├── pages/                  # login, home, document, admin
│   └── components/             # search, filter, qa_block, navbar
├── uploads/                    # uploaded images
└── style/                      # css/tailwind
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
- `user_category_permissions` table and the additive resolution rule (§4.2.1).
- Category-aware guards on every document server function; listings narrowed in SQL.
- Admin UI: the category matrix on user creation and on each existing user.

---

## 12. Open Questions

### Decided

1. **Can a user edit a document they created without the `EDIT` permission?**
   **Yes.** Authorship always carries edit and delete rights over one's own
   document; `EDIT` / `DELETE` extend that to *other* people's documents. This
   holds under category scoping too: an author keeps access to their document
   even without a grant on its category.
2. **Are categories managed only by the admin, or by permitted users too?**
   **Admin only.** Any authenticated user may *list* the categories they can
   see (the filters need it), but create/rename/delete is `is_admin`.
6. **How do category permissions combine with the global ones?**
   **Additively** — see §4.2.1. A global flag grants the action everywhere; a
   grant adds it for one category. Chosen so that accounts predating category
   scoping keep working unchanged, and so that "restricted" is expressed by
   simply leaving the global boxes unticked.

### Still open

3. Are images stored locally or in the cloud (S3)?
4. Is the `DELETE` permission needed, or are documents only archived?
5. Format for Q&A answers: markdown, plain text, or a rich-text editor?
7. Should uploads be scoped by category as well? Today `/uploads/…` URLs are
   readable by anyone with a session, regardless of which document embeds them.
