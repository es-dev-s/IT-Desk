-- IT-Desk schema. Everything lives in the dedicated schema selected by
-- search_path (DB_SCHEMA, default "itdesk"), so nothing else in the database
-- is touched.

CREATE TABLE teams (
    id          text PRIMARY KEY,
    name        text NOT NULL CHECK (length(name) >= 2),
    code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{3}$'),
    lead_name   text NOT NULL,
    location    text NOT NULL,
    sort_order  int  NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
    id           text PRIMARY KEY,
    team_id      text NOT NULL REFERENCES teams(id),
    name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
    email        text NOT NULL UNIQUE,
    title        text NOT NULL,
    preferences  jsonb NOT NULL DEFAULT '{}'::jsonb,
    version      int  NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
    id          text PRIMARY KEY,
    name        text NOT NULL CHECK (length(name) >= 2),
    email       text NOT NULL UNIQUE,
    role        text NOT NULL,
    sub_group   text NOT NULL,
    team_id     text NOT NULL REFERENCES teams(id),
    seat        text CHECK (seat ~ '^[A-E]-[1-8]$'),
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resigned', 'unknown')),
    joined_at   date NOT NULL,
    hue         int  NOT NULL CHECK (hue BETWEEN 0 AND 359),
    version     int  NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- People who left the team never hold a desk.
    CONSTRAINT members_seat_requires_active CHECK (status = 'active' OR seat IS NULL),
    -- No two active people on the same floor seat. Deferred to commit time so a
    -- swap (A→B's desk, B→A's desk) inside one transaction is allowed.
    CONSTRAINT members_active_seat_excl EXCLUDE USING btree (team_id WITH =, seat WITH =)
        WHERE (status = 'active' AND seat IS NOT NULL) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX members_team_idx ON members (team_id, status);

-- Desks on a floor occupied by people outside this workspace's view.
CREATE TABLE reserved_seats (
    team_id  text NOT NULL REFERENCES teams(id),
    seat     text NOT NULL CHECK (seat ~ '^[A-E]-[1-8]$'),
    holder   text NOT NULL DEFAULT 'Other team',
    PRIMARY KEY (team_id, seat)
);

CREATE TABLE devices (
    id         text PRIMARY KEY,
    member_id  text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('laptop','monitor','dock','phone','keyboard','mouse','headset')),
    model      text NOT NULL,
    asset_tag  text NOT NULL UNIQUE CHECK (asset_tag ~ '^IT-[A-Z]{2}-[0-9]{4}$'),
    position   int  NOT NULL DEFAULT 0
);
CREATE INDEX devices_member_idx ON devices (member_id, position);

CREATE SEQUENCE ticket_seq START 4300;

CREATE TABLE transfers (
    id              text PRIMARY KEY,
    ticket          text NOT NULL UNIQUE CHECK (ticket ~ '^IT-[0-9]{4}$'),
    direction       text NOT NULL CHECK (direction IN ('in', 'out', 'internal')),
    from_team_id    text NOT NULL REFERENCES teams(id),
    to_team_id      text NOT NULL REFERENCES teams(id),
    effective_date  date NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    initiated_by    text NOT NULL,
    note            text NOT NULL DEFAULT '' CHECK (length(note) <= 280),
    it_status       text NOT NULL DEFAULT 'requested' CHECK (it_status IN ('requested','scheduled','moved','completed')),
    version         int  NOT NULL DEFAULT 0,
    cancelled_at    timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfers_created_idx ON transfers (created_at DESC) WHERE cancelled_at IS NULL;

CREATE TABLE transfer_moves (
    transfer_id    text NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    member_id      text NOT NULL REFERENCES members(id),
    position       int  NOT NULL,
    member_name    text NOT NULL,
    from_team_id   text NOT NULL REFERENCES teams(id),
    from_seat      text,
    to_seat        text,
    version_after  int  NOT NULL DEFAULT 0,
    PRIMARY KEY (transfer_id, member_id)
);
CREATE INDEX transfer_moves_member_idx ON transfer_moves (member_id);

-- Snapshot of the kit that travels with each move (assets can change later).
CREATE TABLE transfer_move_devices (
    transfer_id  text NOT NULL,
    member_id    text NOT NULL,
    device_id    text NOT NULL,
    kind         text NOT NULL,
    model        text NOT NULL,
    asset_tag    text NOT NULL,
    position     int  NOT NULL,
    PRIMARY KEY (transfer_id, device_id),
    FOREIGN KEY (transfer_id, member_id) REFERENCES transfer_moves (transfer_id, member_id) ON DELETE CASCADE
);

CREATE TABLE transfer_history (
    transfer_id  text NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    status       text NOT NULL CHECK (status IN ('requested','scheduled','moved','completed')),
    at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (transfer_id, status)
);

CREATE TABLE exits (
    id              text PRIMARY KEY,
    batch_id        text NOT NULL,
    member_id       text NOT NULL REFERENCES members(id),
    member_name     text NOT NULL,
    status          text NOT NULL CHECK (status IN ('resigned', 'unknown')),
    seat            text,
    prev_status     text NOT NULL CHECK (prev_status IN ('active', 'resigned', 'unknown')),
    version_after   int  NOT NULL DEFAULT 0,
    effective_date  date NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    initiated_by    text NOT NULL,
    reason          text NOT NULL CHECK (length(reason) BETWEEN 2 AND 280),
    cancelled_at    timestamptz
);
CREATE INDEX exits_batch_idx ON exits (batch_id);
CREATE INDEX exits_created_idx ON exits (created_at DESC) WHERE cancelled_at IS NULL;

CREATE TABLE idempotency_keys (
    key           text NOT NULL,
    scope         text NOT NULL,
    request_hash  text NOT NULL,
    status_code   int,
    response      bytea,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key, scope)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    actor       text NOT NULL,
    action      text NOT NULL,
    entity      text NOT NULL,
    entity_id   text NOT NULL,
    request_id  text NOT NULL DEFAULT '',
    data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
