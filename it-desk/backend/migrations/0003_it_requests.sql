-- IT requests: equipment / support asks raised by admins and team leads that
-- are independent of seat moves and team transfers. They get their own ticket
-- series (REQ-1001, REQ-1002, …) so they never collide with transfer tickets.

CREATE SEQUENCE request_seq START 1001;

CREATE TABLE it_requests (
    id               text PRIMARY KEY,
    ticket           text NOT NULL UNIQUE CHECK (ticket ~ '^REQ-[0-9]{4,}$'),
    -- Who raised it (a snapshot of the name/role is kept so the trail survives
    -- the account being deleted).
    requester_id     text REFERENCES users(id) ON DELETE SET NULL,
    requester_name   text NOT NULL,
    requester_role   text NOT NULL CHECK (requester_role IN ('admin', 'team_lead')),
    -- Team the request belongs to (scoping). NULL = org-wide (raised by an admin
    -- without a team).
    team_id          text REFERENCES teams(id),
    -- Optional: the person the kit is for (a member of team_id).
    for_member_id    text REFERENCES members(id) ON DELETE SET NULL,
    for_member_name  text,
    notes            text NOT NULL CHECK (length(notes) BETWEEN 5 AND 1000),
    priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'cancelled', 'rejected')),
    assignee_id      text REFERENCES users(id) ON DELETE SET NULL,
    assignee_name    text,
    -- Resolution note, rejection reason or cancellation reason.
    resolution       text NOT NULL DEFAULT '' CHECK (length(resolution) <= 500),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    closed_at        timestamptz,
    version          int NOT NULL DEFAULT 0 CHECK (version >= 0),
    CONSTRAINT it_requests_member_needs_team CHECK (for_member_id IS NULL OR team_id IS NOT NULL),
    CONSTRAINT it_requests_rejected_has_reason CHECK (status <> 'rejected' OR length(resolution) >= 3),
    CONSTRAINT it_requests_closed_at CHECK ((status IN ('resolved', 'cancelled', 'rejected')) = (closed_at IS NOT NULL))
);
CREATE INDEX it_requests_team_idx ON it_requests (team_id, status, created_at DESC);
CREATE INDEX it_requests_status_idx ON it_requests (status, created_at DESC);
CREATE INDEX it_requests_assignee_idx ON it_requests (assignee_id) WHERE assignee_id IS NOT NULL;

-- What is being asked for: one row per kind, with a quantity. "other" must
-- describe what it is.
CREATE TABLE it_request_items (
    request_id   text NOT NULL REFERENCES it_requests(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('laptop', 'headphone', 'mouse', 'cpu', 'other')),
    quantity     int  NOT NULL CHECK (quantity BETWEEN 1 AND 10),
    description  text NOT NULL DEFAULT '' CHECK (length(description) <= 120),
    position     int  NOT NULL DEFAULT 0,
    PRIMARY KEY (request_id, kind),
    CONSTRAINT it_request_items_other_described CHECK (kind <> 'other' OR length(btrim(description)) >= 2)
);

-- Timeline: creation, assignment, status changes and comments.
CREATE TABLE it_request_events (
    id           bigserial PRIMARY KEY,
    request_id   text NOT NULL REFERENCES it_requests(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('created', 'assigned', 'status', 'comment', 'cancelled', 'rejected')),
    actor_id     text,
    actor_name   text NOT NULL,
    actor_role   text NOT NULL,
    body         text NOT NULL DEFAULT '' CHECK (length(body) <= 1000),
    from_status  text,
    to_status    text,
    at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX it_request_events_req_idx ON it_request_events (request_id, at, id);
