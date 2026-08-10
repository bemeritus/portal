# Technical Specification (TS)
## Knowledge Base / Technical Documentation Platform

**Technology:** Rust + Leptos (full-stack)
**Version:** 1.0
**Date:** 2026

---

## 1. Project Overview

The platform is an **internal knowledge base** where authorized users create and read technical documents (articles). These documents are not plain articles — they are structured in a **question-and-answer (Q&A)** format. Each document contains a sequence of questions with their corresponding answers.

Core ideas:
- **No public signup.** Only an **admin** can create users.
- Every user has permissions (read / write / edit).
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

### 4.3. Authentication Flow

```
Admin  --->  Creates a user (username + initial password + permissions)
User   --->  Logs in (username + password)
Server --->  Issues a session cookie
Each request  --->  Session + permission are validated (guard)
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
- FR-5: Admin creates a new user: username, password, permissions.
- FR-6: Admin changes permissions (READ/WRITE/EDIT/DELETE).
- FR-7: Admin blocks/activates a user.
- FR-8: Admin resets a user's password.

### 5.3. Categories
- FR-9: Admin (or a permitted user) creates/edits/deletes categories.
- FR-10: Each document belongs to exactly one category.

### 5.4. Documents (Question-Answer format)
- FR-11: A user with `WRITE` creates a new document: title + category.
- FR-12: A document contains multiple **Q&A blocks** (question + answer).
- FR-13: Images can be embedded within an answer's text.
- FR-14: Q&A blocks are ordered (by position/order).
- FR-15: A user with `EDIT` can edit a document and its Q&A blocks.
- FR-16: Document status: `draft` or `published`.

### 5.5. Viewing and Filtering
- FR-17: A list of documents is shown (title, category, author, date).
- FR-18: Search/filter **by title** (via text input).
- FR-19: Filter **by category** (via dropdown/selection).
- FR-20: Both filters can work together.
- FR-21: When a document is opened, all Q&A blocks are shown in sequence.

---

## 6. Database Schema

### 6.1. `users`
| Column | Type | Note |
|--------|------|------|
| id | UUID (PK) | |
| username | TEXT (unique) | |
| password_hash | TEXT | argon2 |
| is_admin | BOOLEAN | admin flag |
| can_read | BOOLEAN | permission |
| can_write | BOOLEAN | permission |
| can_edit | BOOLEAN | permission |
| can_delete | BOOLEAN | permission (optional) |
| is_active | BOOLEAN | blocked/active |
| created_at | TIMESTAMPTZ | |
| created_by | UUID (FK → users.id) | who created it |

> Alternative: normalize permissions into a separate `permissions` table (many-to-many). The column-based approach is simpler for an initial version.

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

### 6.6. Relationship Diagram
```
users (1) ────< documents (N)
categories (1) ────< documents (N)
documents (1) ────< qa_blocks (N)
users (1) ────< uploads (N)
```

---

## 7. Server Functions / API

In Leptos these are written as **server functions** (`#[server]`). Approximate list:

### Auth
- `login(username, password) -> Result<User>`
- `logout() -> Result<()>`
- `current_user() -> Option<User>`

### Admin (only `is_admin`)
- `create_user(username, password, permissions) -> Result<User>`
- `update_permissions(user_id, permissions) -> Result<()>`
- `set_user_active(user_id, active) -> Result<()>`
- `reset_password(user_id, new_password) -> Result<()>`
- `list_users() -> Result<Vec<User>>`

### Categories
- `create_category(name, description) -> Result<Category>`
- `list_categories() -> Result<Vec<Category>>`
- `update_category(...)`, `delete_category(...)`

### Documents
- `create_document(title, category_id, blocks) -> Result<Document>` — requires `WRITE`
- `update_document(id, title, category_id, blocks) -> Result<()>` — requires `EDIT`
- `get_document(id) -> Result<DocumentWithBlocks>`
- `list_documents(title_filter, category_filter) -> Result<Vec<DocumentSummary>>` — requires `READ`
- `delete_document(id) -> Result<()>` — requires `DELETE`

### Files
- `upload_image(bytes, filename) -> Result<String /* URL */>`

> Every server function has a **guard**: first the session, then the permission is checked. If the permission is missing, a `403` is returned.

---

## 8. Pages (routes) and UI

| Route | Page | Access |
|-------|------|--------|
| `/login` | Login form | Public |
| `/` | Document list + filters | `READ` |
| `/docs/:id` | Single document (Q&A view) | `READ` |
| `/docs/new` | Create new document | `WRITE` |
| `/docs/:id/edit` | Edit document | `EDIT` |
| `/categories` | Manage categories | Admin/permitted |
| `/admin/users` | Manage users | Admin |

**Home page (`/`) contents:**
- Search bar at the top: title input + category dropdown.
- Document list below (cards or table).
- When a filter changes, the list updates reactively (Leptos `Resource`).

**Document page (`/docs/:id`):**
- Title, category, author.
- Q&A blocks in sequence: each shown as "Question → Answer" (e.g., accordion or plain list).

---

## 9. Security Requirements

- SR-1: Passwords are hashed with **argon2**, never stored in plaintext.
- SR-2: Session cookies are `HttpOnly`, `Secure`, `SameSite=Lax`.
- SR-3: A permission guard is mandatory in all server functions.
- SR-4: No signup endpoint exists at all.
- SR-5: On file upload, MIME type and size are validated (images only, e.g. ≤ 5MB).
- SR-6: Protection against SQL injection — SQLx parameterized queries.
- SR-7: Rate limiting on login attempts — optional but recommended.

---

## 10. Project Structure (approximate)

```
platform/
├── Cargo.toml
├── migrations/                 # sqlx migrations
│   ├── 0001_users.sql
│   ├── 0002_categories.sql
│   ├── 0003_documents.sql
│   └── 0004_qa_blocks.sql
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

---

## 12. Open Questions (to be decided by the project owner)

1. Can a user edit a document they created without the `EDIT` permission?
2. Are categories managed only by the admin, or by permitted users too?
3. Are images stored locally or in the cloud (S3)?
4. Is the `DELETE` permission needed, or are documents only archived?
5. Format for Q&A answers: markdown, plain text, or a rich-text editor?
