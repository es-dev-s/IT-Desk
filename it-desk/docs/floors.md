# Floors, seats and team zones

IT-Desk models the office as **buildings → floors → cells**. The admin builds each
floor plan, paints **team zones** onto seats, and publishes it. Everyone then sees
the live plan (scoped to their role), and people get seated on it.

- The admin is **org-level**. They are never on a team, and they work in an
  "All teams" view with a team switcher.
- **Team leads** seat their own people on seats inside their team's zone. A seat
  in another team's zone needs a transfer.
- **IT** gets read-only access.

## Layout lock (`FLOOR_LAYOUT_LOCKED`, on by default)

Floor layouts are **read-only**. While `FLOOR_LAYOUT_LOCKED=true` (the default, see
`backend/.env.example`):

- The API answers `403 layout_locked` to every layout write: `POST /floors`,
  `POST /floors/{id}/duplicate`, `PUT`/`PATCH`/`DELETE /floors/{id}/draft` and
  `POST /floors/{id}/publish`. Reads (including `GET …/draft`) still work.
- The UI hides **New floor**, **Duplicate** and **Edit layout**, and `/floors/{id}/edit`
  shows a "layouts are locked" notice instead of the builder. The workspace payload
  carries `floorLayoutLocked` for this.
- Everything else still works: rename & details, delete (empty floors), team zones,
  moving zones, seat numbers and seating people.
- Layouts still come in through `go run ./cmd/floors-import` (it writes through the
  store, not the HTTP API).

Set `FLOOR_LAYOUT_LOCKED=false` and restart the API to use the builder described
below again.

## Data model (migration `0007_floors.sql`)

| Table / column | Notes |
|---|---|
| `buildings` | One default building today. |
| `floors` | `name` (unique per building, case-insensitive), `level`, `sort_order`, `seat_prefix` (legacy, now always empty), `cols` 2–200, `rows` 2–200 (see *Grid limits*), `notes`, `status` `draft` \| `published`, `version`, the draft document plus `draft_version`, `published_at`. |
| `floor_cells` | The published layout: `kind`, `x`, `y`, `w`, `h`, `code`, `label`, `team_id`, `lead_seat`, `code_locked`. Seat `code` is unique per floor (`floor_cells_code_uq`). |
| `members.seat_id` | FK to a seat cell (`ON DELETE RESTRICT`), unique, so a seat can't be double-booked. `members.is_lead` marks team leads. |
| `zone_changes` | Audit and undo log for zone edits: before/after cells and members, actor, summary, `undone_at`. |
| `transfer_moves.from/to_seat_id`, `exits.seat_id` | Seat history for transfers and exits. |

### Cell kinds

| kind | Meaning | Drawn as |
|---|---|---|
| `seat` | A desk. It has a `code`, its seat number (for example `12`), an optional `teamId` (its zone), and `leadSeat` (the lead's desk). | A team-coloured tile with the number (small, muted) and the occupant's first name; zoomed out it shows the number only; lead desks get a crown. |
| `block` | A desk block or aisle. | Orange. |
| `void` | An unusable area (pillar, shaft). | Hatched dark. |
| `wall` | A wall segment. | Dark bar. |
| `door` | A door or exit. It may sit on a room's edge. | Sky blue, with the label. |
| `room` | A meeting room, washroom or server room. | Outlined box, with the label. |
| `label` | Free text. It may sit on top of anything. | Text. |

### Seat numbers

A seat's `code` is its number: plain `1`, `2`, `3` … per floor. Default numbering
runs in reading order (top row first, left to right), and numbers are unique per
floor. People only ever see "Seat 12"; the seat's internal `id` stays hidden and
never changes, so members, zones and history stay attached when a number changes.

New seats get the next free number automatically. Typing a number by hand **locks**
it (`codeLocked`), and publishing locks every seat number. **Number seats 1…N** in
the builder reflows unlocked numbers only and skips numbers already taken. The
server (`domain.AutoNumber`) and the client (`lib/floors.ts autoNumber`) use the
same algorithm. `seatPrefix` is still accepted by the API but is ignored and no
longer shown.

Migration `0009_plain_seat_numbers.sql` converted the old `L4-A01` style codes to
plain numbers once (reading order per floor, also inside saved drafts), and the
importer JSON in `backend/floors/` carries the same numbers, so re-importing changes
nothing.

### Seat numbers (admin, any time)

Admins can give any seat its real-world number, on draft or live floors:

- One seat: double-click the seat (or its number in the side panel), type, press Enter.
  No team is needed; the team zone is a separate, optional step.
- Many seats: select them, then **Number these seats** with a start number and direction.
- API: `PUT /floors/{id}/seat-codes` `{changes:[{seatId, code}], dryRun?}`. Codes are
  upper-cased, must match the pattern above and be unique per floor (DB unique index).
  Swaps in one call work. A clash with a seat not in the call returns
  `409 seat_code_taken` naming that seat.
- The seat's internal id never changes, so the person sitting there stays seated.
  The new number shows everywhere at once (SSE), and every change is audited.
- Re-running `cmd/floors-import` resets numbers to the ones in `backend/floors/*.json`.

### Tab order

Floors are listed highest level first; `sortOrder` (higher first) breaks ties
between floors on the same level, then the name. The imported files use
70…10 so the tabs read Level 4, 3rd Floor – West Side, Level 3 (A),
Level 2 (B), Level 2 (A), Level 1 (B), Level 1 (A) —
`TestFloorFilesTabOrder` guards it. Editing a floor's name or level in
**Manage** keeps its `sortOrder`.

### Grid limits

Floors are 2–200 columns × 2–200 rows (`floor_cells.w/h` up to 200), with at most 4000
elements per floor. One set of numbers lives in three places, and
`TestGridLimitsInSync` (backend `internal/domain`) fails if they drift:
`domain.MinCols/MaxCols/MinRows/MaxRows`, the CHECKs in `0008_floor_grid_limits.sql`,
and `GRID` in `Frontend/lib/floors.ts` (used by the New floor dialog's Zod schema, the
builder's size fields and **Fit grid**).

Rows and columns can be changed any time, including on a live floor (the change goes
live on publish). Growing never moves anything. Shrinking past placed elements
asks first (**Resize anyway / Show them / Cancel**) and never deletes them. They stay
in the draft, flagged as outside the grid, and publishing is blocked until they're
moved back inside or the grid is grown again. Large grids fit to the screen
(cells down to 6 px) and the seat layer is memoized, so hovering and dragging don't
re-render every tile.

### Validation (on publish, mirrored live in the builder)

- Every element must fit inside the grid.
- Solid elements must not overlap. Labels can sit on anything, and doors can sit on a room's edge.
- Every seat needs a code that is unique and matches `^[A-Z0-9][A-Z0-9-]{0,15}$`.
- Zone teams must exist.

## Permissions

| Permission | admin | team_lead | it |
|---|---|---|---|
| `floor.view`: published floors | ✓ (drafts too) | ✓ (other teams' occupants redacted, leads stay visible) | ✓ |
| `floors.manage`: build, publish, zones, moves, undo | ✓ | – | – |
| `seats.assign`: `PUT /members/{id}/seat` | any member → any seat | own team's members → free seats in **own zone**; anything else returns `403 forbidden` | – |

## API

Every route is under `/api/v1`. Writes take an `Idempotency-Key` header (optional)
and return the usual error envelope `{code, message, fields?, requestId}`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/floors` | – | `FloorSummary[]`, highest level first |
| GET | `/floors/{id}` | – | `Floor`: published `elements`, `occupants` {seatId → occupant}, `stats` |
| POST | `/floors` | `FloorCreateInput` | `201 FloorSummary` |
| PATCH | `/floors/{id}` | `{name?, level?, sortOrder?, seatPrefix?, notes?, expectedVersion}` | `FloorSummary` |
| DELETE | `/floors/{id}` | – | `{deleted:true}`, or `409 floor_occupied` while people sit there |
| POST | `/floors/{id}/duplicate` | `{name, keepZones}` | `201 FloorSummary` (a new draft, with nobody seated) |
| GET | `/floors/{id}/draft` | – | `FloorDraft` |
| PUT | `/floors/{id}/draft` | `{cols, rows, seatPrefix, elements[], expectedDraftVersion}` | `FloorDraft`, or `409 stale_draft` |
| PATCH | `/floors/{id}/draft` | `{upsert: Element[], delete: id[], expectedDraftVersion}` | `FloorDraft` |
| DELETE | `/floors/{id}/draft` | – | `FloorDraft` reset to the live layout (**Discard** in the builder; audited `floor.draft_discarded`; never touches zones, numbers or seated people) |
| POST | `/floors/{id}/publish` | `{expectedDraftVersion?, onConflict?, dryRun?}` | `PublishResult` |
| POST | `/floors/{id}/zones` | `{teamId \| null, seatIds? \| codes?, leadSeat?, onConflict?, dryRun?}` | `ZoneChangeResult` |
| POST | `/zones/move` | `{teamId, fromFloorId?, fromSeatIds?, toSeatIds, carry, onConflict?, dryRun?}` | `ZoneChangeResult` |
| POST | `/zone-changes/{id}/undo` | – | `{undone:true}`, or `409` once the window has passed or later changes touched the same seats |
| PUT | `/floors/{id}/seat-codes` | `{changes:[{seatId, code}], dryRun?}` | `SeatCodesResult`, or `409 seat_code_taken` |
| PUT | `/members/{id}/seat` | `{seatId \| null, expectedVersion}` | `Member` |

### Payloads

```jsonc
// FloorCreateInput — either a template, explicit elements, or a blank grid
{ "name": "Level 4", "level": 4, "sortOrder": 70, "seatPrefix": "",
  "template": "facing-rows", "templateSeats": 17,      // 2 facing rows of 17, centre block, door
  "cols": 24, "rows": 10, "elements": [ /* Element */ ], "notes": "", "publish": false }

// Element
{ "id": "el_…", "kind": "seat", "x": 3, "y": 1, "w": 1, "h": 1,
  "code": "3", "label": "", "teamId": "t_…", "leadSeat": false, "codeLocked": true }

// FloorSummary
{ "id", "buildingId", "name", "level", "sortOrder", "seatPrefix", "cols", "rows", "notes",
  "status": "draft|published", "version", "publishedAt", "draftVersion", "hasUnpublishedChanges",
  "updatedAt", "stats": { "seats", "occupied", "zoned", "free", "byTeam": {"teamId": n}, "teams": [] } }

// Occupant (Floor.occupants[seatId])
{ "memberId", "name", "teamId", "isLead", "devices", "hue", "redacted" }

// PublishResult
{ "floor": Floor, "dryRun": false, "affected": [AffectedMember], "added": 3, "removed": 1, "changed": 7 }

// ZoneChangeResult
{ "id": "zc_…", "dryRun": false, "seatsChanged": 12, "affected": [AffectedMember],
  "floors": ["fl_…"], "undoExpiresAt": "2026-10-29T10:20:00Z" }

// AffectedMember
{ "memberId", "name", "teamId", "fromSeatId", "fromSeat": "3",
  "toSeatId": "…|null", "toSeat": "L3-B07|null",
  "action": "carry|relocate|unseat|keep|conflict" }
```

### Changes that hit seated people (`onConflict`)

Publishing a layout, painting zones, and moving a zone can all touch seats that
people are sitting in. Each of these first runs as a **`dryRun: true`** preview,
and the UI lists everyone affected.

| `onConflict` | Effect on people from *other* teams whose seat changes zone or disappears |
|---|---|
| `""` (default) | They are reported as `conflict`. A real (non-dry) call fails with `409 zone_conflict`, with `fields["member.<id>"]` naming each person. |
| `relocate` | Each person is moved to a free seat in their own team's zone, on the same floor first, then other floors. If none is free, they are unseated. |
| `unseat` | They lose their seat (`seat_id = null`). |
| `keep` | They keep the desk even though it is now in another zone. The floor view shows "Outside zone". |

For `POST /zones/move` with `carry: true`, the moving team's own people go with the
zone (`action: "carry"`) and keep their relative positions.

Every zone change, move and publish runs in **one transaction**. It writes an audit
entry and sends a `floor.seats` notification (`entityType: "floor"`) to each
affected team's leads and to IT. It also publishes a live `floor` event over SSE,
so every open view refreshes. Zone changes return an `id` that can be undone
through `/zone-changes/{id}/undo` within `UNDO_WINDOW` (default 10 minutes).

## UI

**Floors** (`/floors`, every role)
- Floor tabs, a search box (person, seat number or team) and a legend.
- Seat tiles show the code and the occupant's name. **Team leads are marked
  everywhere** (here and in member lists) with an amber ring and a crown "Lead" badge.
- A lead lands on their own floor with their zone highlighted. Clicking a free
  seat in their zone seats one of their people.
- Admins can switch on **Edit zones** (key `E`) right on the live plan:
  - select seats by click, ⇧-click or dragging a box;
  - assign or unassign a team, or set a lead desk;
  - **move any team's zone here** from any floor, with people optionally moving along;
  - move any person to any free seat on any floor.

  Changes with seated people open a confirmation dialog listing them, with three
  choices: **Move them along**, **Unseat** or **Cancel**. Each change can be undone
  from the toast.

**Manage floors** (`/floors/manage`, admin)
- Cards with status (Draft / Live / Unpublished changes), seat counts and team zones.
- Actions: New floor (template or blank grid), Edit layout, Duplicate (layout only,
  or with zones), Rename & details, and Delete (only once the floor is empty).

**Builder** (`/floors/{id}/edit`, admin)
- Palette: Select `V`, Seat `S` (click or drag-paint), Seat row `R`, Block/aisle `B`,
  Door `D`, Label `L`, Room `M`, Void `X`, Eraser `E`.
- Auto-numbering with manual override (typed codes lock), Renumber, and Fit grid.
- Marquee and ⇧-click multi-select, then **Assign to team** through a searchable
  picker, Unassign, or Lead desk.
- Undo / redo: `⌘Z` / `⇧⌘Z` (whole drags undo in one step).
- An autosaved draft (debounced, version-checked) and **Publish** (`⌘↵`), which
  previews the people affected.
- Live validation with click-to-locate problems, and "Start from template".
- Other shortcuts: `⌘A`, `⌫`, arrows to nudge (with `⇧`, 5 cells), `Esc`, `⌘S`,
  `Space`-drag to pan, `⌘`-scroll to zoom, `?` for the list.

## Importing the real floors

`backend/floors/*.json` holds the seven transcribed office floors, and
`go run ./cmd/floors-import` loads them idempotently. See that command's `-h` for
details.
