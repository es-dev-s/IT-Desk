-- Direct messages: one continuous conversation per (team lead, IT staff member),
-- no longer tied to a request. A lead can message anyone in the IT directory;
-- request ids stay in the Requests section and are not part of chat.
--
-- IT-side messages are shown as coming from the staff member of the
-- conversation. The real author is always stored (author_id / author_name /
-- author_role) for the audit trail: an IT account without its own directory
-- entry replies on that person's behalf.

CREATE TABLE chat_messages (
    id          text PRIMARY KEY,
    lead_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    staff_id    text NOT NULL REFERENCES it_staff(id) ON DELETE CASCADE,
    side        text NOT NULL CHECK (side IN ('lead', 'it')),
    author_id   text REFERENCES users(id) ON DELETE SET NULL,
    author_name text NOT NULL CHECK (length(author_name) <= 120),
    author_role text NOT NULL CHECK (author_role IN ('admin', 'team_lead', 'it')),
    body        text NOT NULL CHECK (length(body) <= 2000),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conv_idx ON chat_messages (lead_id, staff_id, created_at, id);
CREATE INDEX chat_messages_staff_idx ON chat_messages (staff_id, created_at);
CREATE INDEX chat_messages_created_idx ON chat_messages (created_at);

CREATE TABLE chat_message_files (
    id           text PRIMARY KEY,
    message_id   text NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    data         bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 2097152),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_message_files_message_idx ON chat_message_files (message_id);

-- Read state per side of each conversation: everything the other side sent
-- after read_at is unread for this side.
CREATE TABLE chat_reads (
    lead_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    staff_id text NOT NULL REFERENCES it_staff(id) ON DELETE CASCADE,
    side     text NOT NULL CHECK (side IN ('lead', 'it')),
    read_at  timestamptz NOT NULL,
    PRIMARY KEY (lead_id, staff_id, side)
);

-- Carry over request chat between team leads and IT. A message lands in the
-- conversation with the staff member who sent it (IT side) or the one the
-- request was routed to; messages with nobody to attribute them to, and those
-- on requests raised by admins, have no direct conversation and stay behind.
INSERT INTO chat_messages (id, lead_id, staff_id, side, author_id, author_name, author_role, body, created_at)
SELECT m.id, r.requester_id, COALESCE(CASE WHEN m.side = 'it' THEN m.staff_id END, r.staff_id),
       CASE WHEN m.side = 'it' THEN 'it' ELSE 'lead' END,
       m.author_id, m.author_name, m.author_role, m.body, m.created_at
FROM it_request_messages m
JOIN it_requests r ON r.id = m.request_id
JOIN users u ON u.id = r.requester_id AND u.role = 'team_lead'
WHERE COALESCE(CASE WHEN m.side = 'it' THEN m.staff_id END, r.staff_id) IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO chat_message_files (id, message_id, name, content_type, data, created_at)
SELECT f.id, f.message_id, f.name, f.content_type, f.data, f.created_at
FROM it_request_message_files f
JOIN chat_messages c ON c.id = f.message_id
ON CONFLICT DO NOTHING;

-- Read state: a side has read a conversation up to the latest point it had
-- read any of the requests behind it.
INSERT INTO chat_reads (lead_id, staff_id, side, read_at)
SELECT r.requester_id, r.staff_id, CASE WHEN cr.side = 'it' THEN 'it' ELSE 'lead' END, max(cr.read_at)
FROM it_request_chat_reads cr
JOIN it_requests r ON r.id = cr.request_id
JOIN users u ON u.id = r.requester_id AND u.role = 'team_lead'
WHERE r.staff_id IS NOT NULL
GROUP BY 1, 2, 3
ON CONFLICT DO NOTHING;
