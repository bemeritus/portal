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

**The room list** (`/dc`) shows each room as a card: a plan drawn from the
room (racks with a warning in red), its size, racks, devices, the share of
units used and the known power ("for 81 of 96" devices), the last change in
words, and the ways in — 3D, plan, racks, history. Beside it: the catalog
and the recent changes across rooms. A new room comes with the room builder.

In the drawing theme a room opens on its **plan**; in the other themes on 3D,
in the **realistic** mode — after that in the mode you used last (saved per
user, `user_settings.dc_mode`). A link that says what to show wins — the 3D
tab (`?view=3d`), a mode (`?mode=`), a camera (`?cam=`), a selection
(`#device-7`, as on a QR sticker) — and so does a saved view opened from the
plan. Switching the theme while the room is open moves nothing.
`?rev=N` shows the room as it was at revision N, read only.

- **Units**: every length on screen, in the PNG export and in length fields
  is in your unit (mm whole, cm to one decimal, m to three; ranges as
  `5.54–5.55 m`, with the decimal separator of your language). The API and
  DXF stay in millimetres.
- **Modes** (bottom bar): `schema` (outlines; overhead objects
  dashed on the plan only), `realistic` (after
  the photos: white walls and ceiling, terracotta tiles, tube lights in
  fixtures on the ceiling; racks with square-hole rails, U numbers every 5U,
  perforated or glass doors, side panels in two, a plinth on levelling
  feet, status LEDs that show at any distance, fans and power supplies on
  the servers' backs and cable bundles to the cable manager, drawn within
  4 m of the camera; shelf cells under an air conditioner look as they
  are, with a thin outline and hatch in the warning colour only while
  hovered or selected; `schema` and `fill` paint them red),
  `fill` (used units, free runs), `power` (power per rack against the
  room's budget; without one, on an absolute 0 → 10 kW scale with a link
  to set the budget; a rack with devices of unknown power says how many),
  `owners` (devices by owner, eight colours in a fixed order, the rest
  grey under «другие»; the legend lists devices and units per owner).
  Views: overview (the racks' fronts from above the shelf side, about 40°
  down, what is in the way faded), top, aisle (photo 03's camera, from the
  door corner), racks. The bar is grouped: modes · views · undo / redo ·
  Export ▾ (PNG, DXF, CSV, QR stickers) · «⋯»: actions (import CSV, reset
  the layout, history, saved views), then toggles with a check mark and
  their key (orthographic, walk, X-ray, fade what is in the way).
- **The plan** is a plan: orthographic, straight down, no orbit — pan and
  zoom. Turning it (right drag, the view cube, a view) goes to 3D. Chain
  dimensions stand outside the outline: the rack row along the bottom, the
  last rack's line across the room on the right; inside only the labels and
  the short gaps.
- **Layers** (the rail's layers button, `L`): the room's overall dimensions
  (on), the plan's chain dimensions (on), gaps between objects, the other
  tape measurements, the selection's own dimensions (on), service zones
  (on; only violated ones are drawn), object labels (on), lighting (the
  ceiling's tubes as dashed outlines in schema and on the plan), and
  assumptions. Every dimension belongs to exactly one layer
  (`engine/dimensions.ts`, checked by a unit test). With a selection only
  its own dimensions and its gaps to its neighbours show. Remembered in
  this browser.
- **Dimensions**: the value is the tape reading (or both readings). Where the
  model differs from the tape by more than 5 mm the dimension has a dot; its
  tooltip gives tape, model and the difference. Labels never overlap each
  other or a dimension line: the less important one steps aside and comes
  back while its object is hovered or selected.
- **Clearance**: decided by the tape where the tape read that very gap,
  otherwise by the model. A violated service clearance is a thin red zone
  on the floor with a pin («сзади 55,5 см»); where model and tape disagree
  about it, an amber one; zones that are fine show while editing. A pin or
  the summary's card selects the rack and frames the gap. The inspector says
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
- **Inspector** (right): with nothing selected, the room's summary —
  revision and time, size, devices, units used, known power, a row per
  rack with its fill and a warning mark, the warnings as cards (an empty
  room offers the import). A rack: its size and units, four figures (used,
  power, longest free run, devices without power; "no data" when unknown)
  beside a mini elevation, its own dimensions (the model only where it
  differs), open rack, find space; a device, its card. Then the tabs
  object, capacity (the finder), measurements, views, ruler — one row in every
  theme and language: the labels' padding shrinks first, then the last tabs
  move into «⋯»; ←/→, Home/End go through all of them. A shelf cell under
  an air conditioner says why it cannot be used.
- **Racks page**: every rack on one screen — four fit 1440 px; each card has
  its fill and power bars, its warning, the elevation with U numbers,
  devices coloured by kind (servers, storage, network, power, other) and
  free runs of 2U or more outlined with their size. Front / rear, the owner
  highlight (click an owner), find space, import, add a device; the
  selected device's card on the right (power and source, serial, depth,
  last change; show in 3D, edit). Click a free unit to add a device, drag a
  device or its top edge, or edit as text in the inspector
  (`10-11 DELL R740 | 450 W | Client X`). With no contents recorded, one
  message and the CSV template.
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
- **Saved views** (views tab): camera, mode, highlight, selection and the
  view state — layers, X-ray, hidden and locked objects, isolation, the
  section box, open doors; shared with everyone who can see the room, or
  personal (the server hides it from others). Each has a small render of
  itself, its author and who sees it; on hover open, update from the
  current view, delete; a caption and a hold time. Copy link gives the
  link to exactly this screen: `/dc/<room>?mode=…&owner=…&cam=…#obj-<id>`
  (also `#device-<id>`, `#cell-<shelf>-<n>`, `?view=plan`).
- **Tour**: drag the saved views into an order, then «Показать по порядку»:
  full screen, every panel hidden, the camera flies between them (1.2 s,
  ease-in-out) and holds each (6 s unless the view says otherwise), its
  name and caption in the lower third; → / ← move, Space pauses, Esc ends.
  A playback of saved state, so a tour can go from realistic to fill to a
  section through a rack.
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
  session. **History** lists every revision as a sentence ("2 servers moved
  from «Стойка 1» to «Стойка 3»", "CSV import: 92 devices", "Room created
  from the measurements"), filtered to all, mine or imports; a revision's
  detail has plans before and after with what it touched, its changes with
  old → new, opens the room in 3D at that revision, and restores it as a
  new revision.
- The view polls the room's revision every 15 s; if someone else saved first,
  your change is re-applied on top when it still fits, otherwise you are told
  and your input is kept.

### The viewport (FEEDBACK-7 §4)

The room works like a 3D tool, not only looks like one. All of this is
navigation and view state: nothing edits the room beyond what phase 1
allows, and none of it is in the room's revisions.

- **Framing** fits the part of the canvas no panel covers — the inspector,
  the rail and the outliner, the bars, the chips — and centres the view
  there, so nothing is framed under a panel; a label whose anchor falls
  under a panel is hidden, not cut. «Frame selected» looks from whichever
  of eight directions (35° down) hides the object least, the current one on
  a tie; what still stands in the way fades to 15 % (on by default; «⋯»).
- **Grid**: one shader grid without an edge, fading with distance, 100 mm /
  1 m lines that step to 1 m / 10 m when zoomed out; the room's x axis red
  and z blue through its origin corner, named on the plan. None in
  realistic.
- **View cube**: drawn without perspective; the face names stand upright and
  fade as a face turns away. «Фронт стоек» is the side the racks' fronts
  face, «Тыл стоек» the other.
- **Outliner** (`O`, the rail): the room, racks with their devices by unit,
  the shelf with its occupied cells, cooling, cable trays, the rest; a
  warning mark, an eye (hide) and a lock (no selection) per object, for
  this viewer; search by name, model, owner, serial. Selection is shared
  with the view both ways.
- **X-ray** (`Alt+Z`, the rail): every object at 30 %, outlines kept.
  **Isolate** (`/`): only the selection, framed, until Esc.
- **Section** (`Shift+B`, the rail): a box that clips the scene; drag the
  balls on its faces, or a preset — a horizontal cut at a typed height, a
  vertical cut through the rack row. Cut faces are capped in the object's
  colour with a hatch. Saved in views; `DcEngine.sectionBox()` and
  `onViewState` are where the airflow slices will attach.
- **Hover a device** (300 ms): name, kind, units, power and its source,
  owner; outlined in the view. `H` highlights its owner: that owner's
  equipment keeps its colour, the rest dims.
- **Doors**: double-click a rack opens its front door; Shift+double-click
  turns the camera to its rear and opens that. A door swings outwards, into
  the aisle, 110°; its hinge side is the rack's (`door_hinge`, left by
  default, seen from the face; in the rack's editor and details). Where the
  swing would pass through a neighbour or a wall it opens as far as it can
  and a hint names what is in the way. A view setting.
- **Status bar** (24 px, under the bottom bar): the tool's hint, the
  selection («Стойка 3 · 31/42U · 9 кВт»), the scene and the cursor's
  floor coordinates.

**Keys** (`?` shows them; the number row and the numpad alike; none while
a text field has focus):

| Key | Action |
|---|---|
| `F` / `.` | frame selected |
| `Home` | frame all |
| `1` / `Ctrl+1` | front of the racks / their rear |
| `3` / `Ctrl+3` | right / left |
| `7` / `Ctrl+7` | top (plan) / the same turned 180° |
| `5` | orthographic / perspective |
| `Alt+Z` | X-ray |
| `/` | isolate |
| `O` | outliner |
| `L` | layers |
| `M` | ruler |
| `Shift+B` | section |
| `H` | highlight the owner of the device under the pointer |
| `Esc` | close the keymap, leave isolation, the tool, the selection — one at a time |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |

The modes no longer have number keys (1–4 were modes and 5–8 views before
FEEDBACK-7): the numbers are the camera's, as in Blender.

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

1. Download the template (racks page, or the import dialog): headers in
   your language, this room's racks, three example rows — or export the
   current inventory (Export → Inventory, CSV). Format: `;`-separated, UTF-8 with
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
   with other rows, bad values (with the values a coded column takes).
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
| `GET /rooms/{id}/revisions` · `/revisions/{n}` · `POST /revisions/{n}/restore` | history (each revision with its author id and a `digest`: what it added, moved, re-owned, whether it created the room, imported or restored), a revision with its diff, restore as a new revision (`{base_revision}`) | use / edit |
| `GET /rooms/{id}/capacity?u=&power_w=&face=` · `GET /rooms/{id}/search?q=` | capacity finder, search | use |
| `POST /rooms/{id}/import/devices?dry_run=true` | CSV import | edit |
| `GET /rooms/{id}/import/template.csv` | the import template: the user's headers, the room's racks, examples | use |
| `GET /rooms/{id}/export/plan.dxf` · `/export/inventory.csv` | exports | use |
| `GET /catalog?kind=` | catalog | use |
| `GET /catalog/usage` | every object that uses a catalog item, with its room | use |
| `GET /rooms/{id}/airflow` | the airflow model: a worker available or not, the assumptions of a run of the room as it stands, the latest run, the latest result (marked `outdated` when the room changed since) — see [Airflow model](#airflow-model-how-it-is-computed-and-how-to-read-it) | use |
| `POST /rooms/{id}/airflow/runs` · `POST /rooms/{id}/airflow/runs/{run}/cancel` | queue a run of the room as it stands (201; 200 with the existing run when the same input is already queued, running or finished); cancel one | edit |
| `PUT /rooms/{id}/airflow/assumptions` | `{base_revision, supply_temp_c, assumed_rack_heat_w, units: [{object_id, airflow_m3h}], racks: [{object_id, heat_w}]}` — one change set (a new revision, audited), then a new run | edit |
| `GET /rooms/{id}/airflow/runs/{run}/summary` · `/grid` · `/streamlines` | a converged run's numbers and checks; its browser grid (f16, gzip); its streamline sets (JSON, gzip). A run that did not converge gives only its checks, and no grid or streamlines (409) | use |

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
  the table's sorting, a picture on every card, filters, comparison); and
  FEEDBACK-7's: a cooling unit moved over occupied cells, every dimension in a
  layer, no label cut by a panel at 1440 and 1920 px, the default view at the
  racks' fronts, the outliner and the view sharing the selection, no key
  acting while typing, a tour of two views, and no 404 in a session.
  `E2E_USER` / `E2E_PASSWORD` name the account the stack creates
  (`dcedit` by default). The tests change that account's language and theme
  and put them back afterwards, so they run one at a time. Set `PLAYWRIGHT_BROWSERS_PATH` where Playwright's browsers
  are not downloaded — on Nix, `nix build nixpkgs#playwright-driver.browsers`
  of the same version as `@playwright/test`, and run with `LD_LIBRARY_PATH`
  unset (the dev shell's glibc is older than the browsers').
- Airflow: `cargo test -p portal-cfd` — the case writer against
  `make_case.py` + `bc.py` and the post-processing against `post.py` on
  checked-in fixtures (`backend/cfd/tests/fixtures/README.md`), the OpenFOAM
  reader, the f16 grid, the checks and batch means — and `dc::airflow` (the
  input from the seeded room). A whole run: `just cfd-reference > ref.json`,
  then `just cfd-case ref.json out/` (the input's `settings.processes`, 4 by
  default — about 17 minutes with 12 on 12 cores). The
  uncertainty of any run's bands from its probes:
  `portal-cfd-worker uncertainty INPUT.json postProcessing/intakes/0/T 1500 2000`.
  Against a database: `just cfd-worker` (on a branch, with `DATABASE_URL` set
  to a scratch database such as the one `just e2e-serve` prints).
- DXF check: `pip install ezdxf`, then
  `python -c "import ezdxf; from ezdxf import recover; d,a=recover.readfile('plan.dxf'); print(len(a.errors), len(a.fixes))"`
  — both must be 0.

Code: `backend/src/dc/` (model, pure algorithms, store, change sets, seed,
the airflow input `airflow.rs` and runs `airflow_store.rs`),
`backend/src/routes/dc.rs`, `backend/src/routes/dc_airflow.rs`, `backend/cfd/`
(the airflow model's pure algorithms), `backend/cfd-worker/` (the worker), `backend/src/tool_access.rs`;
`frontend/src/dc/` (`model/` pure code with tests, `engine/` three.js outside
React with one renderer per catalog kind, `ui/` pages and panels).

## Airflow model: how it is computed and how to read it

The backend half (PROMPT-AIRFLOW part A). The mode that draws it (`airflow`)
comes with part B. **Every number here is a model, not a measurement, and
it is not calibrated** until sensors exist (SPEC §14.2, phase 5).

### How it is computed

1. **The room becomes an input** (`backend/src/dc/airflow.rs`), derived from
   the room as it stands. Everything a run depends on is in it, so the same
   input gives the same result. Phase 1 kinds are boxes:

   | Object | In the model |
   |---|---|
   | rack | a solid plinth (to U1), a 60 mm top cap and 50 mm side panels (none on an open frame); the interior is a fluid zone whose fan carries the rack's heat from front to rear at the flow that warms the air by 10 K; 100 mm behind each door is left out of the fan zone. Doors are not modelled (all open) |
   | cooling unit | a solid body; supply grilles from its `supply_outlets` (position, size, pitch, yaw), else the subtype's default; return grilles on the face the catalog's `openings` names, else the subtype's default (ducted: under the rear half). Supply is a fixed velocity whose normal flux is the unit's airflow over its meshed grille area, tilted by the pitch and turned by the yaw; returns are pressure outlets, so the mass balance closes itself |
   | shelf | posts and 35 mm boards; on every recorded cell a 200 × 440 × 460 mm tower case, its heat (the cell's power, else 120 W) released in the 100 mm of air behind it |
   | structure | a solid box; doors, windows and walls are not (the door is closed) |
   | cable tray | a solid box for a sheet tray; wire baskets and ladders are not modelled |

   An object within 50 mm of a wall, the floor or the ceiling is modelled
   against it (a thinner gap of air breaks the mesh; the reference's
   lessons). A face with a grille is never moved.

2. **The worker runs it** (`backend/cfd-worker/`, `docs/DEPLOY.md` Appendix
   D) in the pinned OpenFOAM image: `blockMesh` (70 mm cells) →
   `snappyHexMesh` with `snap false` (a castellated hex mesh, refined to
   35 mm at obstacles and 17.5 mm at grilles) → `topoSet` → `checkMesh` →
   `buoyantBoussinesqSimpleFoam` (steady, Boussinesq, k-ε) with the
   reference's schemes and relaxation, for 2000 iterations. The process
   count is the app's `AIRFLOW_PROCESSES` (default 4; set it and the
   worker's CPUs to the host's core count — a run asking for more processes
   than the worker has CPUs fails as `processes_exceed_cpus`, never
   oversubscribed), split geometrically
   (`hierarchical`); scotch in this image splits the same mesh differently
   from run to run, and two such runs gave means up to 0.8 °C apart. The
   count, the image digest and the iterations are recorded with every
   result: the same input gives the same result.

3. **The flow is pseudo-steady.** A buoyant room flow never settles: it
   keeps moving around a mean. Single iterations are not results (an
   intake band of the reference moves by up to 6 °C between snapshots 100
   iterations apart). So every number is a **mean over iterations from
   1500 on**, and each intake band carries the uncertainty of that mean:
   the 95 % interval by batch means over its per-iteration temperatures
   (5 to 10 batches, the most whose means are not correlated at lag 1,
   above 0.2; the batch count used is recorded, and a band still correlated
   at 5 batches is marked, its interval then a lower bound).

   While any band's interval is wider than ±1.0 °C, the run goes on in steps
   of 500 iterations (the mean carries on over them, so the window grows) up
   to the worker's cap (`CFD_MAX_ITERATIONS`, 4000). At the cap it is still a
   result: those bands are **flagged unstable** with their interval, and the
   summary lists them.

4. **Checks** (`backend/cfd/src/checks.rs`). A run is **not converged** —
   not a result; the API gives only its checks — only for a real failure:

   | Failure (`reason`) | When |
   |---|---|
   | `residuals` | the mean initial residual over the window above p_rgh 2·10⁻², U, T, k, ε 5·10⁻³ (the reference levels off at 8·10⁻³, 1.6·10⁻³, 1.1·10⁻³, 1.7·10⁻³, 6·10⁻⁴) |
   | `residuals_growing` | an equation's residual over the window's second half more than twice that over its first |
   | `energy_balance` | heat in vs ρ·c_p·Σ φ(T − T_supply) through the grilles, on the averaged fields, off by more than 3 % |
   | `diverged` | NaN in a field or a balance, or the solver crashed |
   | `timeout` | longer than the worker's `CFD_TIMEOUT_MIN` (120) |

   The mass balance (the net flow through the grilles) is reported; the
   pressure-outlet returns close it by construction.

   A run that cannot be computed at all ends as **failed**, also with a
   reason: `processes_exceed_cpus` (the run asks for more MPI processes than
   the worker has CPUs; both numbers in its `detail`), `mesh_failed`,
   `bad_input`, `post_failed`, `worker`.
5. **Post-processing** (`backend/cfd/src/post.rs`, a port of `post.py`)
   resamples the averaged fields onto a 2.5 cm grid (inverse distance over
   the four nearest cells) and takes from it:
   - per rack, the intake at 0.35, 1.05 and 1.75 m (the mean of five points
     across the front, 4 cm in front of it) and the exhaust (the same, 4 cm
     behind the rear, over the three heights);
   - RCI-HI, RTI and the return temperature;
   - the streamline sets: 18 lines from each supply grille, 20 traced back
     from each rack's intake, 12 from each rack's exhaust;
   - a 5 cm grid of temperature and velocity for the browser.

### How to read it

- **Intake per band**: `mean ± half_width` is the model's intake temperature
  and the 95 % interval of that mean (`batches`, `correlated`: how it was
  estimated). `unstable`: the interval was still wider than ±1 °C at the cap —
  the air there switches between sources more slowly than the run can
  average; read the band as its interval, not its mean. `std`, `min` and
  `max` say how much the band moved over the window (per-iteration
  temperatures at its points, placed around the mean). Badges (SPEC §14) go
  by the mean: up to 27 °C green, up to 32 °C yellow, above red.
- **RCI-HI** (%): 100 = no intake above the recommended 27 °C; each degree
  above it, up to the allowable 32 °C, takes a share off.
- **RTI** (%): the return air's rise over the supply, against the racks'
  10 K. Below 100, cold air goes back to the units without passing a rack;
  above 100, hot air goes round through the racks again.
- **Assumptions**: every input that was not measured is listed with its
  source (`assumed`, `manual`, `datasheet`, `devices`). Rack heat is the sum
  of the running devices' powers when every one is known, else the rack's
  `heat_w`, else the room's `assumed_rack_heat_w` (3000 W); the supply
  temperature is the room's `supply_temp_c` (18 °C); a unit's airflow is its
  `airflow_m3h`, else the catalog's highest fan step, else the subtype's
  default (ducted: 1100 m³/h).
- **Outdated**: a result whose input differs from the room as it stands.
  Once a room has had a run, every change set that changes its input queues
  a new run (and cancels an older one still waiting or running); the old
  result stays until the new one is ready.

### Editing the assumptions

`PUT /api/dc/rooms/{id}/airflow/assumptions` (`edit`): the supply
temperature and the room's heat per rack as they should be (null = the
default), and the units' airflow and the racks' heat for the objects listed
(null = the default). It is one change set — a new revision, in the history
and the audit log — and queues a run of the new revision. The same values
can be changed with ordinary change sets (`room_settings`, `object_update`).

### The reference, and what was measured

`dc-handoff/reference/airflow-cfd/` is the pipeline this ports. Its baseline
is the re-run on the pinned image, `result-v2606/summary-mean-1500-2000.json`
(the original v1912 result is like for like with it only at iteration 1800).

**The port is checked deterministically**, apart from the flow
(`backend/cfd/tests/`):

- the case writer and `make_case.py` + `bc.py` on the same input produce
  equal cases: every dictionary, STL surface and `0/` field, numbers within
  1e-9 relative; the mesh of the reference case is the same 354 631 cells;
- the post-processing and `post.py` on the same solved fields give the same
  numbers: every intake band, exhaust, return, RCI-HI and RTI within
  1.1·10⁻⁶, the heat through the grilles identical.

**The flow is not that deterministic.** Two runs that differ only in how
the mesh is split give the same bands within a few tenths of a degree,
except the ones that swing: on the reference case over iterations
1500–2000, rack 2 top is 37.7 ± 1.9 °C (run 2), rack 3 top ± 1.4, rack 4
top ± 1.0, the other nine bands ± 0.07–0.78 °C. The port's run of the same
input gave rack 2 top 41.1 ± 1.9 °C (the baseline's 37.8 by its mean field),
the other bands within 0.6 °C of the baseline — within what one window of
those bands can tell. Comparing a band with the baseline is therefore
information, read with these intervals, not a pass or fail.

**The seeded room** (through the API on a scratch database: supply 17 °C,
rack 4 at 1500 W, the others 3000 W, deflectors at 30°, nothing recorded on
the shelf; 12 processes): a result, extended to the cap of 4000 iterations
because rack 2 top would not settle — 32.9 ± 2.5 °C, flagged unstable
(range 28.4–38.5 over the window); the other bands ± 0.07–0.45 °C. Energy
balance 0.19 %, every residual within its limit and none growing. 338 430
cells; the mesh 17 s, the solve 32 minutes for 4000 iterations (sharing the
machine), post-processing under a second; 2.6 MB of grid and 0.4 MB of
streamlines, gzipped.

The seeded room's numbers differ from the reference's because its inputs
do, not because of the port (checked above): the racks carry the same
3 / 3 / 3 / 1.5 kW, but nothing is recorded on the shelf, so the reference's
22 towers (2.64 kW, released behind them) are missing — 10.5 kW in all
instead of 13.14 kW, hence the cooler intakes — and the rest is the room
model's geometry rather than the reference's hand-made boxes: the supply
outlets as recorded (75 % × 60 % of the face, not 74 % × 54 %), the shelf's
boards at 100 and 948 mm (not 120 and 950) and its posts at the section
divider only.

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

The airflow model (PROMPT-AIRFLOW part A), with the owner:

- **The mesh is the reference's** (70 mm cells refined to 35 and 17.5 mm,
  355 k cells on the seeded room), not SPEC §14.2's 20–30 mm near grilles
  and 1–4 million cells: those are the settings that converge on this room.
- **Stability is an uncertainty, not a failure** (SPEC §14.2 asks for
  convergence checks): a band's mean is reported with its 95 % interval, the
  run extends while an interval is wider than ±1 °C, and a band still wider at
  the cap is flagged unstable in a valid result. Only residuals, the energy
  balance, divergence and a timeout make a run "not converged".
- **The mass balance is reported, not a gate**: the pressure-outlet returns
  close it by construction (SPEC §14.2 lists 1 %).
- **The port is checked against the reference scripts deterministically**
  (case and post-processing); SPEC §17.1b's 1.5 °C comparison of intake
  temperatures with the re-run is reported with the bands' intervals, as
  information.
- **Process count**: fixed by the app (`AIRFLOW_PROCESSES`, default 4, set
  to the host's core count; never oversubscribed), split
  geometrically, recorded with each result; the same input gives the same
  result on the same count.

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

### FEEDBACK-6 (design pass closing phase 1)

1. **The room is calm by default** — realistic (drawing: the plan), then
   the user's last mode; layers; only the room's overall dimensions and the
   labels in 3D; chains outside the plan; labels never on each other or on
   a dimension line; warnings as pins; the room summary; the grouped bar;
   a 64 px view cube with clickable edges and corners. Tests:
   `e2e/phase1-design.e2e.ts`, `e2e/clearance.e2e.ts`.
2. **The selected rack** — its figures, mini elevation, own dimensions and
   buttons; «Открыть стойку» selects it on the racks page.
3. **Realistic looks like the renders** — plain square terracotta tiles,
   the tube lights as area lights, soft shadows, ACES exposure; blanking
   panels in a recorded rack's free units; the cable-entry slot that read
   as a white plate on the rack tops is drawn in realistic only.
4. **Racks page** — as in `design/Racks.png`; the empty state.
5. **Room list** — as in `design/Rooms.png`.
6. **History** — as in `design/History.png`; the sentences come from the
   server's `digest` (`backend/src/dc/digest.rs`) and are written
   impersonally, so they need no grammatical gender. Tests:
   `model/history.test.ts`, `dc::digest` unit tests.
7. **Small things** — the breadcrumb chip only with a selection; the
   revision moved into the summary; the legend clear of the cube.
8. **Import** — the template with the room's racks
   (`/import/template.csv`), allowed values named in errors; 91 devices
   import in about 0.05 s here, one revision (`e2e/phase1-design.e2e.ts`).

The browser checks run on a scratch database of their own (`just e2e`);
before/after screenshots of every screen in three themes are on the
[`screenshots` branch](https://github.com/bemeritus/portal/tree/screenshots/docs/dc/screenshots/feedback-6) (never merged into `main`), with the example inventory
(`frontend/e2e/inventory.ts`, example data, not the room's).

### FEEDBACK-7 (the last phase 1 pass; the design is frozen after it)

1. **Bugs** — a cooling unit moves over occupied shelf cells: only a change
   that puts or moves something *into* a blocked cell is refused
   (`dc::ops::refused_cell`); a unit over equipment is a warning
   («Под кондиционером оборудование: ячейки 3, 4 — риск конденсата»: a pin,
   the inspector, the summary; `analysis.cooling_over_cells`), and the
   blocked cells follow the unit while it is dragged. The plan's chains are
   a layer of their own; every dimension belongs to exactly one layer.
   Framing and labels respect the panels. Labels: the overlap test covers
   every kind; a dimension's label slides along its line, never onto the
   selection; with a selection the room's dimensions step back; compact
   rack labels in fill and power. The views tab and the «⋯» menu redone.
   Power without a budget on an absolute scale, and a room settings form
   (budget, clearances; the `room_settings` change, undoable). Lights in a
   fixture, or dashed on the ceiling behind a layer. Fill bars neutral in
   drawing.
2. **Cameras** — the default view at the racks' fronts; frame selected from
   where the object is least hidden; the view cube without perspective,
   named after the room.
3. **Small things** — the mini elevation 72 px with U ticks and free runs;
   pins on the racks' top edge; catalog pictures drawn on-screen first,
   with a silhouette until then; the browser's `/favicon.ico` 404 gone (an
   inline icon in `index.html`).
4. **The viewport** — above, «The viewport».
5. **Realistic racks** — above, «Modes».
6. **Drawing** — warm paper (`#f6f4ee`, panels `#fbfaf6`), chrome at 1 px
   `#2b2b2b` 60 %, the grid at 20 % ink, zones hatched (red 45°, amber
   cross-hatch, grey dots for blocked cells), headings only in uppercase.
7. **Catalog** — a comfort unit's card and page say it is not built for
   round-the-clock duty.

Tests: `e2e/phase1-finish.e2e.ts`; `engine/dimensions.test.ts`,
`model/owners.test.ts`, the client's `blockedCells` against the server's,
and `dc::ops` tests for both sides of the blocked-cell rule. Migration 0029
lets `owners` be a user's last mode. Before/after screenshots are on the
`screenshots` branch: [FEEDBACK-7](https://github.com/bemeritus/portal/tree/screenshots/docs/dc/screenshots/feedback-7) and [its
follow-up](https://github.com/bemeritus/portal/tree/screenshots/docs/dc/screenshots/feedback-7-followup).

Not in the data, so not shown: datasheet page numbers (sources link to the
datasheet without a page).

Before phase 1 is accepted: re-measure the items in `room.json` →
`remeasure` (listed in the app under the measurements tab). Calculations in phases 3–5
have no external review (team decision, FEEDBACK-1 §6): every formula ships
with hand-computed tests, every rule with a seed room that triggers it, and
every result shows its inputs, formula and the "estimate" / "calculation" label.
