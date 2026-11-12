-- Request chat: one conversation per IT request, between the requester's side
-- (the lead / their team, or the admin who raised it) and IT.
--
-- IT staff are directory entries without logins for now, so IT-side messages
-- are written by an IT or admin account and shown as coming from the staff
-- member the request is routed to. The real author is always stored
-- (author_id / author_name / author_role) for the audit trail, next to the
-- staff member shown (staff_id / staff_name snapshot).

-- Ready for staff logins: link a directory entry to the account that is that
-- person. When set, their messages are attributed to their own entry.
ALTER TABLE it_staff
    ADD COLUMN user_id text UNIQUE REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE it_request_messages (
    id          text PRIMARY KEY,
    request_id  text NOT NULL REFERENCES it_requests(id) ON DELETE CASCADE,
    side        text NOT NULL CHECK (side IN ('requester', 'it')),
    author_id   text REFERENCES users(id) ON DELETE SET NULL,
    author_name text NOT NULL CHECK (length(author_name) <= 120),
    author_role text NOT NULL CHECK (author_role IN ('admin', 'team_lead', 'it')),
    staff_id    text REFERENCES it_staff(id) ON DELETE SET NULL,
    staff_name  text CHECK (staff_name IS NULL OR length(staff_name) <= 80),
    body        text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT it_request_messages_staff_is_it CHECK (side = 'it' OR staff_id IS NULL)
);
CREATE INDEX it_request_messages_request_idx ON it_request_messages (request_id, created_at, id);

-- Read state per side of each conversation: everything the other side sent
-- after read_at is unread for this side.
CREATE TABLE it_request_chat_reads (
    request_id text NOT NULL REFERENCES it_requests(id) ON DELETE CASCADE,
    side       text NOT NULL CHECK (side IN ('requester', 'it')),
    read_at    timestamptz NOT NULL,
    PRIMARY KEY (request_id, side)
);
