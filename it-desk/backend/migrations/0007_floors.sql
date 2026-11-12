-- Floors: buildings, floor plans drawn on a grid, team zones and seats that
-- people actually sit on. Replaces the fixed per-team 5x8 seat banks.
--
-- A floor has a working draft (jsonb, edited by the admin builder with
-- autosave) and a published layout (floor_cells). Only published cells are
-- seats people can be assigned to; publishing reconciles floor_cells with the
-- draft in one transaction. Zone (team) changes and member seat moves apply
-- directly to the published layout, so a published floor never needs to be
-- unpublished to be changed.

CREATE TABLE buildings (
    id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{1,40}$'),
    name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    sort_order  int  NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO buildings (id, name) VALUES ('hq', 'HQ');

CREATE TABLE floors (
    id                text PRIMARY KEY,
    building_id       text NOT NULL DEFAULT 'hq' REFERENCES buildings(id),
    name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    level             int  NOT NULL DEFAULT 0 CHECK (level BETWEEN -10 AND 200),
    sort_order        int  NOT NULL DEFAULT 0,
    seat_prefix       text NOT NULL DEFAULT '' CHECK (seat_prefix ~ '^[A-Z0-9-]{0,8}$'),
    cols              int  NOT NULL CHECK (cols BETWEEN 4 AND 120),
    rows              int  NOT NULL CHECK (rows BETWEEN 2 AND 80),
    notes             text NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
    status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    -- Working layout: {"cols":n,"rows":n,"elements":[...]}.
    draft             jsonb NOT NULL DEFAULT '{"elements":[]}'::jsonb,
    draft_version     int  NOT NULL DEFAULT 1,
    draft_updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Bumped on every change to the published layout, zones or meta.
    version           int  NOT NULL DEFAULT 1,
    published_at      timestamptz,
    published_by      text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX floors_name_uq ON floors (building_id, lower(name));

-- Published elements. Seats are 1x1 with a code unique on the floor and an
-- optional team zone; blocks (desk islands / aisles), voids, walls, doors,
-- rooms (labelled landmarks such as Washroom or Server) and free labels can
-- span w x h cells.
CREATE TABLE floor_cells (
    id         text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,40}$'),
    floor_id   text NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('seat', 'block', 'void', 'wall', 'door', 'room', 'label')),
    x          int  NOT NULL CHECK (x >= 0),
    y          int  NOT NULL CHECK (y >= 0),
    w          int  NOT NULL DEFAULT 1 CHECK (w BETWEEN 1 AND 120),
    h          int  NOT NULL DEFAULT 1 CHECK (h BETWEEN 1 AND 80),
    code       text CHECK (code IS NULL OR code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
    label      text NOT NULL DEFAULT '' CHECK (length(label) <= 80),
    team_id    text REFERENCES teams(id) ON DELETE SET NULL,
    -- Seat reserved for the team lead (shown with the lead badge even when empty).
    lead_seat  boolean NOT NULL DEFAULT false,
    CONSTRAINT floor_cells_seat_shape CHECK (kind <> 'seat' OR (code IS NOT NULL AND w = 1 AND h = 1)),
    CONSTRAINT floor_cells_seat_only CHECK (kind = 'seat' OR (code IS NULL AND team_id IS NULL AND NOT lead_seat))
);
CREATE INDEX floor_cells_floor_idx ON floor_cells (floor_id);
CREATE INDEX floor_cells_team_idx ON floor_cells (team_id) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX floor_cells_code_uq ON floor_cells (floor_id, code) WHERE kind = 'seat';

-- Members now sit on a real seat. Dropping the old text column also drops its
-- pattern check and the per-team exclusion constraint.
DROP TABLE reserved_seats;
ALTER TABLE members DROP CONSTRAINT members_seat_requires_active;
ALTER TABLE members DROP CONSTRAINT members_active_seat_excl;
ALTER TABLE members DROP COLUMN seat;
ALTER TABLE members ADD COLUMN seat_id text REFERENCES floor_cells(id) ON DELETE RESTRICT;
ALTER TABLE members ADD COLUMN is_lead boolean NOT NULL DEFAULT false;
ALTER TABLE members ADD CONSTRAINT members_seat_requires_active CHECK (status = 'active' OR seat_id IS NULL);
-- No two active people on one seat, anywhere. Deferred to commit so swaps
-- inside one transaction work.
ALTER TABLE members ADD CONSTRAINT members_active_seat_excl EXCLUDE USING btree (seat_id WITH =)
    WHERE (status = 'active' AND seat_id IS NOT NULL) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX members_seat_idx ON members (seat_id) WHERE seat_id IS NOT NULL;

-- Snapshots keep the human-readable code; the id is kept for undo.
ALTER TABLE transfer_moves ADD COLUMN from_seat_id text;
ALTER TABLE transfer_moves ADD COLUMN to_seat_id text;
ALTER TABLE exits ADD COLUMN seat_id text;

-- Admin zone changes on published floors, kept for undo.
CREATE TABLE zone_changes (
    id           text PRIMARY KEY,
    actor_id     text,
    actor_name   text NOT NULL DEFAULT '',
    summary      text NOT NULL DEFAULT '',
    -- {"cells":[{"id","teamId"}], "members":[{"id","seatId","version"}], "floors":{"id":version}}
    before       jsonb NOT NULL,
    after        jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    undone_at    timestamptz
);

-- Admins and IT are org-level: never on a team. (Already enforced by
-- users_team_matches_role; restated per role for clarity.)
ALTER TABLE users ADD CONSTRAINT users_org_roles_teamless CHECK (role = 'team_lead' OR team_id IS NULL);

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'transfer.created', 'transfer.acknowledged', 'transfer.advanced',
    'request.created', 'request.acknowledged', 'request.status', 'request.assigned',
    'request.comment', 'request.cancelled', 'request.rejected', 'floor.seats'));
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_entity_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_entity_type_check CHECK (entity_type IN ('transfer', 'it_request', 'floor'));
