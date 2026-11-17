# Server room module (DC) — phase 1

The server room as an exact, editable 3D record: racks with their devices by
unit, the colocation shelf's cells, cooling, trays, door and safe, all in
millimetres and with the provenance of every measured number. Specification:
`dc-handoff/SPEC.md` (this is phase 1, §2 and §17.1).

## Setup

Nothing beyond the platform's own setup (`README.md`), then load the room:

```sh
just seed-dc            # or, in the Docker image: portal seed-dc
```

This loads `backend/seeds/dc/room.json` (the room as measured) and
`backend/seeds/dc/cooling.json` (20 cooling units from datasheets) — copies of
`dc-handoff/data/`. Like `just seed`, it is data, not schema: it never runs on
startup, and running it again is safe — catalog items are matched by
(kind, manufacturer, model) and the room by name, and anything that exists is
left as it is, so edits made in the app are never overwritten.

Then grant access (below) and open **Серверная** in the sidebar (`/dc`).

## Permissions

Server room access is part of the **«Внутренние инструменты»** permission
family, separate from documents: `/admin/users` → *Internal tools*, pick a
user, tick the levels.

| Level | Allows |
|---|---|
| `dc_room:use` | see rooms and the catalog, search, capacity finder, history, exports (DXF, CSV, PNG) |
| `dc_room:edit` | everything in `use`, plus moving and editing objects, devices, shelf cells, notes and views, CSV import, restoring revisions |

Administrators hold every level. `edit` implies `use`. Grants are re-read on
every request, so revoking one takes effect at once, and every grant and
revocation is in the change history (`/admin/logs`).

Without `dc_room:use` every `/api/dc` route answers 403 (401 when signed out),
and the sidebar has no Серверная entry. State-changing DC requests also need
the session's CSRF token in `X-CSRF-Token` — the SPA does this; for scripts,
`GET /api/dc/csrf` first.

The registry also holds `port_checker`, `mail_tester`, `online_pinger` and
`dns_checker`. They are registered so the admin page and guards are ready;
the existing port checker page is **not** gated by its key yet (it stays open
to every signed-in user, as before).

## Using it

- **Modes** (top bar): *Схема* (positions and sizes, all dimensions, assumed
  values marked), *Реалистичный* (materials, shadows, labels on hover),
  *Заполнение* (used units, free runs), *Мощность* (power per rack against the
  room's per-rack budget; unknown power hatched, never shown as zero).
- **Tools**: *Обзор* (look, select, search), *Правка* (drag objects with
  snapping to walls and neighbour edges within 25 mm, or the grid; arrows move
  10 mm, Shift 100 mm, `R` turns 90°), *Линейка* (corner snapping, Shift keeps
  to one axis), *Заметка* (pin a note).
- **Racks**: select a rack for its elevation (front/rear). Click a free unit to
  add a device, drag a device to move it or onto another rack's chip, drag its
  top edge to resize, or *Правка текстом*: `10-11 DELL R740 | 450 Вт | Клиент X`.
  A rack whose contents were never recorded says so; adding its first device
  marks it recorded.
- **Capacity finder** (*Место*): units, power, face → ranked racks; *Добавить
  сюда* pre-fills the add form.
- **Замеры**: every measured number with how it was obtained; assumed values
  are also outlined in the 3D view.
- **Undo/redo**: `Ctrl+Z` / `Ctrl+Shift+Z` undo your own changes in this
  session (never anyone else's). **History** lists every revision with a diff;
  *Восстановить* restores one as a new revision.
- **Deep links**: `/dc/<room>#obj-<id>`, `#device-<id>`, `#cell-<shelf>-<n>`.
- The view polls the room's revision every 15 s; if someone else saved first,
  your change is re-applied on top when it still fits, otherwise you are told
  and your input is kept.

## How to edit the room geometry

Phase 1 edits **what is in** a room (objects, devices, cells, notes). The room
itself — floor plan, height, measurements, settings — has no editor until the
room designer (phase 2). Until then:

- **Before the room exists** (or for a fresh install): edit
  `backend/seeds/dc/room.json` (millimetres; keep `src` honest: `measured`,
  `range` with `min`/`max`, `derived`, `assumed`), run `cargo test dc::seed`
  — it checks the positions the seed computes — and `just seed-dc`.
- **For the existing room**, in SQL, then bump the revision so open browsers
  reload:

  ```sql
  -- clearances and the per-rack power budget (§4.4); null = no budget
  UPDATE dc_rooms
     SET settings = settings || '{"clearance_front_mm": 1000, "clearance_rear_mm": 600,
                                  "rack_power_budget_w": 5000}',
         revision = revision + 1, updated_at = now()
   WHERE name = 'Серверная';
  ```

  `measurements` holds the re-measured numbers (`entries[]` with `key`,
  `value`, `min`/`max`, `src`, `note`, `objects`), `floor_plan` the
  `[[x, z], …]` polygon, `height_mm` the height. The API decodes these into
  typed structs and refuses unknown fields, so keep their shape. A changed
  wall can make an existing object "outside the room": the room view lists
  such problems on the object, and the next move of it will be refused until
  it is fixed.
- **Objects** (racks, cooling, the shelf, …) are moved and edited in the app
  (*Правка*), which validates them against the room and records a revision.

## How to import devices

1. Fill in `dc-handoff/data/inventory-template.csv` (or export the current
   inventory: *Экспорт → Инвентарь, CSV*). Format: `;`-separated, UTF-8 with
   BOM, one header row; headers may be in Russian, Uzbek or English, columns
   in any order. Required: `rack`, `u_bottom`, `u_height`, `kind`, `name`.
   `kind`: server, storage, switch, router, patch, ups, pdu, kvm, blank,
   other; `face`: front (default), rear, both; `status`: active (default),
   reserved, planned, decommissioning; `power_src`: nameplate, measured,
   estimated. **Empty `power_w` means unknown** — never write 0 for unknown.
   Delete the template's three example rows.
2. *Импорт* → choose the file. The dry run lists what would be created,
   changed (field by field) or left unchanged, and every problem by line:
   unknown racks, units that do not fit, overlaps with existing devices or
   with other rows, bad values.
3. *Импортировать* applies it as one revision — all rows or none. A row whose
   rack, face and bottom unit match an existing device updates it; any other
   row adds a device; nothing is deleted. Racks that receive devices are
   marked as recorded.

Through the API: `POST /api/dc/rooms/{id}/import/devices?dry_run=true` with
the CSV as the body, then the same without `dry_run` and with
`base_revision=<revision from the dry run>`.

## Exports

- **Plan, DXF**: DXF R12 in millimetres, Windows-1251 text, layers named in
  your language; the plan from above with dimensions (measured ranges where
  recorded) and every object as a 3D box. Geometry and dimensions only.
  Made for AutoCAD, nanoCAD, BricsCAD and LibreCAD (save as DWG there);
  checked with `ezdxf`, not yet opened in any of them.
- **Inventory, CSV**: the import format, headers in your language.
- **Current view, PNG**: the 3D view as shown, with its labels.

## API

All under `/api/dc`; errors are `{"error": "…"}` like the rest of the API (a
stale write's 409 also carries `revision`, a refused import also carries its
`plan`).

| | | |
|---|---|---|
| `GET /csrf` | the session's CSRF token | use |
| `GET /rooms` · `GET /rooms/{id}` · `GET /rooms/{id}/revision` | rooms; one room with catalog items, objects, devices, cells, annotations and the server's analysis (placement problems, clearances, blocked cells); the revision for polling | use |
| `POST /rooms/{id}/changes` | `{base_revision, summary?, ops[]}` — atomic, one revision, one audit entry per op | edit |
| `GET /rooms/{id}/revisions` · `/revisions/{n}` · `POST /revisions/{n}/restore` | history, a revision with its diff, restore as a new revision (`{base_revision}`) | use / edit |
| `GET /rooms/{id}/capacity?u=&power_w=&face=` · `GET /rooms/{id}/search?q=` | capacity finder, search | use |
| `POST /rooms/{id}/import/devices?dry_run=true` | CSV import | edit |
| `GET /rooms/{id}/export/plan.dxf` · `/export/inventory.csv` | exports | use |
| `GET /catalog?kind=` | catalog | use |

Operations: `object_create|update|delete`, `device_create|update|delete`,
`cell_set|delete`, `annotation_create|delete`. Room and catalog operations
come with phase 2.

## Development

- `just test` — Rust unit tests (geometry, capacity, CSV, DXF, seed vs
  `room.json`, model typing) and Vitest (client geometry, device grammar,
  locale key parity, every server error sentence translated).
- `just test-db` — the database-level rules (`backend/tests/dc_constraints.sql`)
  against a throwaway database; CI runs the same against a Postgres service.
- DXF check: `pip install ezdxf`, then
  `python -c "import ezdxf; from ezdxf import recover; d,a=recover.readfile('plan.dxf'); print(len(a.errors), len(a.fixes))"`
  — both must be 0.

Code: `backend/src/dc/` (model, pure algorithms, store, change sets, seed),
`backend/src/routes/dc.rs`, `backend/src/tool_access.rs`;
`frontend/src/dc/` (`model/` pure code with tests, `engine/` three.js outside
React with one renderer per catalog kind, `ui/` pages and panels).

## Decisions and deviations from SPEC

Taken with the project owner before starting:

- **Language** is stored per user (`users.language`, default `ru`) and applied
  on sign-in; localStorage is only a first-paint hint.
- **Server errors** stay English sentences (house convention) and are
  translated in `frontend/src/i18n/errors.ts`; a test fails CI when a backend
  sentence has no Russian and Uzbek translation. Import row problems are codes
  translated by the client.
- **CSRF** tokens protect state-changing `/api/dc` requests only; the rest of
  the platform still relies on `SameSite=Lax` (README, Known gaps).
- **`port_checker`** is registered but its page is not gated yet.

Adjusted to the house style or the data:

- `users.id` is a UUID, so author columns are UUIDs; revisions also keep the
  author's name, like `audit_log`, and the seed's revision is by `seed`.
- The seed runs on request (`just seed-dc`), like the platform's other seed.
- The no-overlap rule is two exclusion constraints (front+both, rear+both),
  so a full-depth device conflicts with either face; triggers check rack kind,
  unit fit and shelf cell numbers.
- Lengths that `room.json` gives with a half millimetre (air conditioner
  edges, the middle shelf board) are rounded half away from zero; every
  position is within 1 mm (tested).
- The three existing air conditioners share one catalog item, «Сплит, модель
  не указана», 1145 mm wide; the 1250 mm unit overrides its width per object
  (allowed only for units of unknown model).
- Shelf cells are numbered from the top board, left to right as seen from the
  front; the shelf faces the room (rotation 180).
- With no per-rack power budget set (the default — none was given), *Мощность*
  shows known power in one neutral colour and says it is not judged; the
  capacity finder lists power without judging it.
- The cable tray is two objects (left wall, behind the racks).

## Phase 1 acceptance (SPEC §17.1)

- [x] **Migrations create the schema; seed from `data/room.json` creates the
  room, catalog items and objects at the given positions (within 1 mm).**
  Migration `0021_dc.sql`; `just seed-dc`. `dc::seed` tests check every rack,
  the shelf, the air conditioners, the safe, the trays and the door against
  `room.json` (rack gaps 530/465/440/200 mm exactly; half-millimetre values
  within 1 mm).
- [x] **`user_tool_permissions` with the five registry keys; admin section
  «Внутренние инструменты» grants and revokes; changes audited.** Migration
  `0020`; `tool_access.rs` registry and tests; admin page section; one audit
  entry per grant/revoke (`tool_permission.grant|revoke`).
- [x] **Without `dc_room:use`: 403 on every `/api/dc` route, no menu item, no
  export reachable. With `use` only: every write returns 403.** Checked
  against the running server for every route (403 without the grant, 401
  signed out; writes, restore and import 403 for a `use`-only user) and in the
  browser (no menu entry; an explanation instead of the page; no edit tools or
  import for `use`).
- [x] **Language switch RU / UZ (Latin) / EN works across the DC module
  without reload; no missing keys (CI check).** Typed `t()`, locale key-parity
  test and the server-error translation test run in CI; verified in Russian
  and Uzbek in the browser. Keys built at run time (`dc.subtype.${s}` and the
  like) cannot be type-checked; the parity test still holds the three
  languages to the same set.
- [x] **Overlapping devices on the same face fail in the database even with
  the API check bypassed.** `backend/tests/dc_constraints.sql` via
  `just test-db` (passes locally) and the new CI job (not yet seen running on
  GitHub — it is new in this branch).
- [x] **Two browsers editing one room: the second write gets 409; the UI
  recovers without losing input.** Verified in the browser: a stale write gets
  409, the room is refetched and the edit re-applied when it still fits (with
  a notice); otherwise the user is told and forms keep their input (that
  second path is implemented but was only exercised through the API).
- [x] **Own undo/redo across object moves and device edits; history page with
  diffs; restore creates a new revision.** Verified in the browser: add device
  → Ctrl+Z → Ctrl+Shift+Z (revisions 2–4), arrow-key moves and R, history with
  field-level diffs, restore as a new revision.
- [x] **Capacity finder correct on hand-made cases (tests).** `dc::capacity`:
  faces, best fit, unrecorded and full racks, budget, unknown power, ties.
- [x] **CSV import dry-run diff, atomic apply.** `dc::csv` tests (template,
  quoting, headers in three languages, every error code, overlaps with
  existing devices and between rows); dry run and apply checked against the
  server, apply goes through the change-set path (one revision, all or
  nothing).
- [~] **DXF export passes `ezdxf` audit and opens in LibreCAD; geometry
  matches `room.json` within 1 mm.** `ezdxf` 1.4.3: strict read, 0 audit
  errors, 0 fixes; a unit test checks the walls and rack outlines against
  `room.json`. **Not checked: opening it in LibreCAD** (not installed on the
  machine this was built on). The ezdxf check is manual, not in CI.
- [~] **Four phase 1 modes render; performance budget met on the reference
  laptop.** All four render without console errors (headless Firefox).
  **The performance budget was not measured** — no access to the reference
  laptop (Intel UHD 620). Rendering is on demand, so an idle view costs
  nothing. Not done from SPEC §10, to be decided: instancing and texture atlases
  (per-object meshes and per-device cached textures instead), ambient
  occlusion in Реалистичный, emissive ceiling lights (fixture positions were
  never recorded), and a bundled HDR (three's procedural room environment is
  used instead — no file, no network).
- [x] **Assumed values marked in 3D and listed in the measurement status
  panel.** Dashed outlines in every mode and «≈» badges; the *Замеры* tab lists
  every measurement with its provenance, the assumed catalog properties, what
  to re-measure and what is not modelled.
- [x] **Catalog browser shows all 20 seeded cooling units as 3D cards with
  filters; the detail view's dimensions match the catalog in mm; in-row and
  perimeter units are visibly different from comfort units.** 21 cards (the
  20 plus the measured «модель не указана» unit); section, type, brand,
  sensible-capacity range, width, sort, search, compare; parametric templates
  per subtype.
- [x] **`just ci` passes.**

Before phase 1 is accepted (from `dc-handoff/README.md`): answer SPEC §18's
open question, and re-measure the items in `room.json` → `remeasure` (listed
in the app under *Замеры*).
