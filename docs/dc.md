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
left as it is, so edits made in the app are never overwritten. (Catalog
items seeded before they had a body finish get it from migration `0023`,
which runs on startup like every migration.)

Then grant access (below) and open the server room entry in the sidebar
(`/dc`).

## Permissions

Server room access is part of the **internal tools** permission
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
and the sidebar has no server room entry. State-changing DC requests also need
the session's CSRF token in `X-CSRF-Token` — the SPA does this; for scripts,
`GET /api/dc/csrf` first.

The registry also holds `port_checker`, `mail_tester`, `online_pinger` and
`dns_checker`. They are registered so the admin page and guards are ready;
the existing port checker page is **not** gated by its key yet (it stays open
to every signed-in user, as before).

## Using it

The module opens full screen in its own chrome (mockups in
`dc-handoff/design/`): the sections **3D / plan / racks / catalog**, search
(⌘K / Ctrl+K), the length unit **mm / cm / m** and the themes **studio /
drawing / light**; the unit and the theme are saved per user
(`user_settings`; with no theme chosen it follows the portal's dark mode).
The arrow at the top left goes back to the portal.

In the drawing theme a room opens on its **plan**; in the other themes on 3D. A link
that says what to show wins — the 3D tab (`?view=3d`), a camera (`?cam=`), a
selection (`#device-7`, as on a QR sticker) — and so does a saved view opened
from the plan. Switching the theme while the room is open moves nothing.

- **Units**: every length on screen, in the PNG export and in length fields
  is in your unit (mm whole, cm to one decimal, m to three; ranges as
  `5.54–5.55 m`, with the decimal separator of your language). The API and
  DXF stay in millimetres.
- **Modes** (bottom bar): `schema` (outlines and every tape measurement as a
  dimension; overhead objects dashed on the plan only), `realistic` (after
  the photos: white walls and ceiling, terracotta tiles, tube lights; shelf
  cells under an air conditioner look as they are, with a thin outline and
  hatch in the warning colour only while hovered or selected; `schema` and
  `fill` paint them red),
  `fill` (used units, free runs), `power` (power per rack against the
  room's budget; unknown power hatched, never zero). Views: overview, top,
  aisle (photo 03's camera, from the door corner), racks.
- **Dimensions**: the value is the tape reading (or both readings). Where the
  model differs from the tape by more than 5 mm the dimension has a dot; its
  tooltip gives tape, model and the difference. Labels never overlap: at a
  distance the less important ones step aside; zoom in to see them all.
- **Show assumptions** (eye at the bottom of the tool rail, off by
  default) outlines and badges what rests on assumptions.
- **Clearance**: a violated service clearance is a thin red zone on the floor
  with one label; zones that are fine show while editing. The inspector says
  what a shortfall means: how much room there is and to what (a wall or an
  object), what servicing needs, and what will not work (the rear door may
  not open fully, a server on rails may not slide out). The numbers are the
  measured ones and the requirement is not lowered; it is a warning from the
  measurements, not an error in the model. Clicking it selects the rack and
  draws the gap with its dimension, as the ruler does, in every mode.
- **Tools** (left rail): view, edit (drag with snapping to walls and
  neighbours within 25 mm, or the grid; arrows 10 mm, Shift 100 mm, `R`
  90°), ruler, note.
- **Ruler**: hover shows what a click will snap to — vertex, edge midpoint,
  edge, face, centre — with its own marker. Two faces measure square to each
  other (face ⟂ face), wherever they are clicked; the object-gap mode
  gives the smallest floor gap between two objects or an object and a wall.
  In the top view it measures in plan (Alt: in 3D); Shift keeps to one axis.
  The result names its snaps (`face ⟂ face · 59.5 cm`, in your language); both ends are
  listed with coordinates you can type. Objects are measured by their
  envelope, so an open frame still has faces.
- **Inspector** (right): the selection's KPIs, its dimensions — tape, and the
  model where they differ — open rack, find space; then the tabs
  object, capacity (the finder), measurements, views, ruler — one row in every
  theme and language: the labels' padding shrinks first, then the last tabs
  move into «⋯»; ←/→, Home/End go through all of them. A shelf cell under
  an air conditioner says why it cannot be used.
- **Racks**: the elevation editor in the inspector or on the racks page: click a free
  unit to add a device, drag a device or its top edge, or edit as text
  (`10-11 DELL R740 | 450 W | Client X`). A rack whose contents were never
  recorded says so.
- **⌘K**: racks, devices (name, serial, owner) and cells; actions — find free
  space (its values come only from the query: a unit count and a power in
  kW or W, typed in Russian, Uzbek or English, in any order; the row shows
  them. Without a unit count nothing is assumed: the row asks for one, and
  Enter or Tab opens the fields with units empty — Enter is refused until
  1–42. Empty power means any. Esc writes the fields back into the query),
  highlight a client (Tab, then pick), compare
  with a revision, save the view and copy its link, QR stickers for the
  selected rack or shelf, mode, theme, unit. Keyboard only; it takes ⌘K from
  the portal's own palette while the module is open.
- **Owner highlight**: one client's devices and cells in colour, the rest
  dimmed; a chip shows the count and clears it.
- **Saved views** (views tab): camera, mode, highlight and selection; shared
  with everyone who can see the room, or personal (the server hides it
  from others). Copy link gives the link to exactly this screen:
  `/dc/<room>?mode=…&owner=…&cam=…#obj-<id>` (also `#device-<id>`,
  `#cell-<shelf>-<n>`, `?view=plan`).
- **Catalog** (`/dc/catalog/<section>`): a sidebar of sections and filters
  (purpose, type and manufacturer with counts, cooling and width ranges in
  your unit, 24/7, published sensible capacity) — every filter, the sort,
  the view and the items picked for comparison are in the URL, so a
  filtered list can be shared. Cards (a 3D picture drawn in the browser
  from the item's own template and finish, cached per session and theme)
  or a table sortable by every column. Pick up to three items with the
  icon on a card's picture; the tray's *Compare* opens
  `/dc/catalog/compare?ids=…`, the rows that differ highlighted. An item
  has its own page, `/dc/catalog/item/<id>`: the 3D view (3D / front /
  side / top; dimensions, airflow and a 42U rack for scale as toggles;
  drag, wheel, F), the key figures, the specification with the source of
  every value and its rating conditions, and where it is used. Unknown
  values read "no data" with the reason, never 0.
- **QR stickers**: Export → QR stickers, A4 (or ⌘K with a rack or shelf
  selected): racks, devices, shelves and occupied cells, three per row. Each
  code is a deep link. Print → *Save as PDF* gives the PDF.
- **Undo/redo**: `Ctrl+Z` / `Ctrl+Shift+Z` undo your own changes in this
  session. **History** lists every revision with a diff; restore
  restores one as a new revision.
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
   WHERE id = 1;  -- the seeded room: SELECT id, name FROM dc_rooms
  ```

  `measurements` holds the re-measured numbers (`entries[]` with `key`,
  `value`, `min`/`max`, `src`, `note`, `objects`), `floor_plan` the
  `[[x, z], …]` polygon, `height_mm` the height. The API decodes these into
  typed structs and refuses unknown fields, so keep their shape. A changed
  wall can make an existing object "outside the room": the room view lists
  such problems on the object, and the next move of it will be refused until
  it is fixed.
- **Objects** (racks, cooling, the shelf, …) are moved and edited in the app
  (edit tool), which validates them against the room and records a revision.

## How to import devices

1. Fill in `dc-handoff/data/inventory-template.csv` (or export the current
   inventory: Export → Inventory, CSV). Format: `;`-separated, UTF-8 with
   BOM, one header row; headers may be in Russian, Uzbek or English, columns
   in any order. Required: `rack`, `u_bottom`, `u_height`, `kind`, `name`.
   `kind`: server, storage, switch, router, patch, ups, pdu, kvm, blank,
   other; `face`: front (default), rear, both; `status`: active (default),
   reserved, planned, decommissioning; `power_src`: nameplate, measured,
   estimated. **Empty `power_w` means unknown** — never write 0 for unknown.
   Delete the template's three example rows.
2. Import → choose the file. The dry run lists what would be created,
   changed (field by field) or left unchanged, and every problem by line:
   unknown racks, units that do not fit, overlaps with existing devices or
   with other rows, bad values.
3. Applying the import makes one revision — all rows or none. A row whose
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
- **Inventory, CSV**: the import format, headers in your language. It has
  no length columns, so the unit setting does not apply.
- **Current view, PNG**: the 3D view as shown, with its labels in your unit.
- **QR stickers**: an A4 page to print or save as PDF (above).

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
| `GET /catalog/usage` | every object that uses a catalog item, with its room | use |

Operations: `object_create|update|delete`, `device_create|update|delete`,
`cell_set|delete`, `annotation_create|delete`. Room and catalog operations
come with phase 2.

## Development

- `just test` — Rust unit tests (geometry, capacity, CSV, DXF, seed vs
  `room.json`, model typing) and Vitest (client geometry, device grammar,
  locale key parity, every server error sentence translated).
- `just test-db` — the database-level rules (`backend/tests/dc_constraints.sql`)
  against a throwaway database; CI runs the same against a Postgres service.
- `just e2e` — Playwright (Chromium) on a stack of its own
  (`scripts/e2e-stack.sh`): a scratch database created, migrated and seeded
  for the run and dropped after it, with its own API and Vite (ports
  `E2E_API_PORT` 3101, `E2E_WEB_PORT` 5181) and its own test account. The
  dev database is never touched, so a branch's migrations cannot reach it
  before merge. `just e2e-serve` keeps the same stack up until Ctrl-C, for
  screenshots or a look by hand. The checks: the ruler's 595 mm (r1 back face → back wall) and 200 mm
  (r3–r4); the inspector's tabs on one row in every theme × language; blocked
  shelf cells in the realistic mode; where a room opens in the drawing theme;
  the palette's find-free-space parameters; the docked rail's separators;
  the clearance warning; the catalog (sizes in three units, the item page,
  the table's sorting, a picture on every card, filters, comparison).
  `E2E_USER` / `E2E_PASSWORD` name the account the stack creates
  (`dcedit` by default). The tests change that account's language and theme
  and put them back afterwards, so they run one at a time. Set `PLAYWRIGHT_BROWSERS_PATH` where Playwright's browsers
  are not downloaded — on Nix, `nix build nixpkgs#playwright-driver.browsers`
  of the same version as `@playwright/test`, and run with `LD_LIBRARY_PATH`
  unset (the dev shell's glibc is older than the browsers').
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
- The three air conditioners are ducted units of unknown model (FEEDBACK-1):
  one catalog item, a ducted unit with its model not specified, 1145 mm wide; the
  1250 mm unit overrides its width per object (allowed only for units of
  unknown model). Each has one supply outlet from the subtype's default
  (`supply_outlets`, §14.1, `source: catalog_default`); editing the angles is
  phase 2. Ducts are not drawn.
- Shelf cells are numbered from the top board, left to right as seen from the
  front; the shelf faces the room (rotation 180).
- With no per-rack power budget set (the default — none was given), `power`
  shows known power in one neutral colour and says it is not judged; the
  capacity finder lists power without judging it.
- One cable tray, behind the racks (wire mesh, near the ceiling); none on the
  left wall.
- Settings (theme, unit) live in a table of their own, `user_settings`
  (migration `0022`), so `users` is not altered.
- The tube lights in `realistic` are lighting, not equipment: not objects,
  not selectable, not exported (FEEDBACK-1 §1 seeds nothing else from the
  photos).
- A rack's KPIs show «—» while its contents are not recorded (all four are,
  until someone enters them) — never zero.

## Phase 1 acceptance (SPEC §17.1)

- [x] **Migrations create the schema; seed from `data/room.json` creates the
  room, catalog items and objects at the given positions (within 1 mm).**
  Migrations `0021_dc.sql`, `0022_user_settings.sql`; `just seed-dc`.
  `dc::seed` tests check every rack (`front_z` 2250 / 2260 / 2220 / 2215),
  the shelf (z0 = 0), the air conditioners, the locker, the tray and the door
  against `room.json` v2 (rack gaps 530/465/440/200 mm exactly;
  half-millimetre values within 1 mm).
- [x] **`user_tool_permissions` with the five registry keys; admin section
  "internal tools" grants and revokes; changes audited.** Migration
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
  matches `room.json` within 1 mm.** `ezdxf` 1.4.3 on the current export:
  strict read, 0 audit errors, 0 fixes; dimensions are the tape values, with
  a circle where tape and model differ by more than 5 mm; a unit test checks
  walls and rack outlines against `room.json`. **Not checked: opening it in
  LibreCAD** (not installed here). The ezdxf check is manual, not in CI.
- [~] **Four phase 1 modes render; performance budget met on the reference
  laptop.** All four render in the three themes without console errors
  (headless Firefox and Chromium). `realistic` now has ambient occlusion
  (GTAO, only in that mode). **The performance budget was not measured** —
  no access to the reference laptop (Intel UHD 620). Rendering is on
  demand, so an idle view costs nothing. Not done from SPEC §10: instancing
  and texture atlases; a bundled HDR (three's procedural room environment
  instead — no file, no network).
- [x] **Assumed values marked in 3D and listed in the measurement status
  panel.** In 3D behind "show assumptions" (off by default): outlines and
  "≈" badges with the assumed keys. The measurements tab lists every measurement with its
  provenance, the assumed catalog properties, what to re-measure and what is
  not modelled; its tab shows the count.
- [x] **Every tape measurement on `data/drawing-hand.png` is visible as a
  dimension in `schema`; differences above 5 mm between model and tape are
  marked.** Every number of the drawing is a measurement with drawing
  endpoints (`dc::seed` test `every_number_on_the_hand_drawing_is_a_dimension`);
  `schema` draws them all, tape value or range (`149.5–150 cm`). Marked with a
  dot and a tooltip (tape, model, difference): r1 back 610 vs 595, r2 back
  555 vs 585, r4 to the right wall 1495–1500 vs 1510 — checked in the
  browser. At the overview distance the labels do not overlap, so the less
  important ones step aside; zooming in shows each.
- [x] **Unit switch mm / cm / m changes every displayed length without
  reload.** Top bar, saved per user (`/api/dc/settings`, default cm);
  labels, inspector, panels, ruler, inputs, PNG. Unit tests: formatting
  (integers / one decimal / three, ranges) and an exact round trip through
  the input fields, every 7th millimetre from −50 to 12 000, in every unit
  and language. API and DXF stay in mm.
- [x] **Ruler: face-to-face between rack r1's back face and the back wall
  returns 595 mm wherever on the faces the clicks land; object gap r3–r4
  returns 200 mm (unit tests + one Playwright test).** `model/ruler.test.ts`
  (9 tests: many click positions, both modes, snaps, plan, Shift) and
  `frontend/e2e/ruler.e2e.ts` (`just e2e`, Chromium; passes:
  "face ⟂ face · 595 mm" and "object gap · 200 mm", in Russian). Not in
  `just ci`, which runs no servers.
- [x] **No cable tray on the left wall; air conditioners are ducted units
  under the ceiling above the shelf; no ducts are drawn.** Seed tests
  (`air_conditioners_are_ducted_units_of_unknown_model`, one tray behind the
  racks); in 3D the units hang on rods from the ceiling, no ducts.
- [x] **`realistic` view from the camera position of photo 03 is
  recognisably the same room.** The aisle view puts the camera at the door corner:
  r4 with perforated double doors in front, r3 glass, r2 perforated, r1 open
  frame at the far end; the shelf on the right with white number plates;
  white walls and ceiling, tube lights, terracotta tiles. Side by side with
  photo 03 in a screenshot (a judgement, not a test). Differences: no ducts,
  chairs or cables (not seeded, by FEEDBACK-1); the tile pattern is drawn,
  not photographed.
- [x] **Catalog browser shows all 20 seeded cooling units as 3D cards with
  filters; the detail view's dimensions match the catalog in mm; in-row and
  perimeter units are visibly different from comfort units.** 21 cards (the
  20 plus the measured unit of unspecified model); section, type, brand,
  sensible-capacity range, width, sort, search, compare; parametric templates
  per subtype.
- [x] **`just ci` passes.**

### FEEDBACK-2 (review of e041f29)

1. **Inspector tabs on one row** — a segmented control (`ui/InspectorTabs.tsx`):
   padding shrinks from 12 to 5 px a side, then the last tabs go into «⋯»
   (the active one always stays in the row); ←/→, Home/End, roving focus,
   `aria-selected`; the font is the theme's. RU fits all five everywhere;
   UZ and EN put one or two into «⋯». Tests: `ui/tabsFit.test.ts`,
   `e2e/inspector-tabs.e2e.ts` (3 themes × 3 languages: one `top`, no
   horizontal scroll, font size, every tab reachable).
2. **Blocked cells in `realistic`** — no fill; an outline and hatch in the
   warning token for the hovered or selected cell only; `schema`, `fill` and
   `power` keep the red fill; the inspector and the hover tooltip say why.
   Tests: `engine/renderers/shelf.test.ts`, `e2e/blocked-cells.e2e.ts`.
3. **The drawing theme opens on the plan** — unless the link has `?view=`, `?cam=` or a
   selection; the 3D tab now links `?view=3d`; a saved view opened on the
   plan goes to 3D with its camera; a theme switch moves nothing. Tests:
   `ui/landing.test.ts`, `e2e/plan-landing.e2e.ts`.
4. **Palette parameters** — the row shows "2U · 0.8 kW" (or "any
   power"); Tab or → opens fields for units and kW, Enter runs, Esc returns
   to the list with the query and values kept (also for the owner list).
   Tests: `model/spaceParams.test.ts`, `e2e/palette.e2e.ts`.

### FEEDBACK-3 (review of 790cd9f)

1. **One rule between tool groups in the docked rail** (drawing theme): the
   `<hr>` draws nothing there and the button above it ends in a 2 px rule
   instead of 1 px; the floating rail (studio, light) is unchanged. Test:
   `e2e/rail.e2e.ts` — every pair of horizontal rules has at least half a
   button between them (the review asked for 2 px, but the reported lines
   were 3 px apart, so 2 px would not have caught them), plus the computed
   styles of the `<hr>` and the button above it.
2. **No silent 1U** in find-free-space: the parser
   (`model/spaceParams.ts`: RU / UZ / EN unit words, kW or W, any order)
   fills the row and the fields from the query; nothing is assumed or
   remembered between openings; Enter is refused until 1–42 units. Tests:
   `model/spaceParams.test.ts` (table-driven), `e2e/palette.e2e.ts` (a query
   with inline parameters, one without).
3. **The clearance warning says what it means** — new title, front and rear
   lines, note and plan legend in all three languages; clicking selects the
   rack and draws the gap like a ruler result. Test: `e2e/clearance.e2e.ts`.
   The optional per-warning acknowledgement was **not built** (see the
   report): the note still asks to mark an intended shortfall, and there is
   no control for that yet.

### FEEDBACK-4 (catalog polish, before phase 2a)

1. **Sizes in one unit** — width and depth were raw millimetres next to a
   height in the user's unit; all three (and the inspector's W × D × H) now
   go through the unit formatter. Test: `model/catalog.test.ts` (mm / cm /
   m × RU / UZ / EN).
2. **Pictures that read** — the templates (also used by the room) are
   rebuilt from shared parts: bevelled bodies, perforated faces with a
   lighter frame and the fans visible behind them (pitch chosen from the
   face's size on screen, mipmapped), displays, plinths with feet, seams;
   per subtype the details FEEDBACK-4 lists. The body's colour and surface
   come from the item (`props.finish`). Previews: a 30° / 17° front
   three-quarter view framed with the same margin for every item (ceiling
   cassettes from below), ACES, a PMREM environment, key and rim lights, a
   soft contact shadow, a backdrop from the theme. The room's lower quality
   tiers drop the small detail. Tests: `engine/studio.test.ts` (direction,
   framing), `engine/renderers/shelf.test.ts`, `e2e/catalog.e2e.ts` (every
   card has a non-blank picture). 21 cards draw in about 0.8 s here on
   software WebGL (SwiftShader); not measured on the reference laptop.
3. **The section reworked** — list, table, comparison and item page as
   in `design/CatalogList.png` and `CatalogItem.png`, in all three themes
   and RU / UZ / EN; themed controls only; the sidebar becomes a sheet and
   the item page stacks on narrow screens. Tests: `model/catalog.test.ts`
   (filters in the URL, sorting, comparison, airflow faces against the
   templates), `e2e/catalog.e2e.ts`.

Not in the data, so not shown: datasheet page numbers (sources link to the
datasheet without a page).

Before phase 1 is accepted: re-measure the items in `room.json` →
`remeasure` (listed in the app under the measurements tab). Calculations in phases 3–5
have no external review (team decision, FEEDBACK-1 §6): every formula ships
with hand-computed tests, every rule with a seed room that triggers it, and
every result shows its inputs, formula and the "estimate" / "calculation" label.
