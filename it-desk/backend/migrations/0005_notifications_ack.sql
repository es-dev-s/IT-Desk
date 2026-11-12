-- 0005: real-time notifications and IT acknowledgements ("Seen by … working on it").

-- Who in IT first acknowledged a transfer / request, and when.
ALTER TABLE transfers
    ADD COLUMN acknowledged_by      text REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN acknowledged_by_name text,
    ADD COLUMN acknowledged_at      timestamptz;

ALTER TABLE it_requests
    ADD COLUMN acknowledged_by      text REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN acknowledged_by_name text,
    ADD COLUMN acknowledged_at      timestamptz;

CREATE INDEX transfers_unacked_idx ON transfers (created_at DESC) WHERE acknowledged_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX it_requests_unacked_idx ON it_requests (created_at DESC) WHERE acknowledged_at IS NULL;

ALTER TABLE it_request_events DROP CONSTRAINT IF EXISTS it_request_events_kind_check;
ALTER TABLE it_request_events ADD CONSTRAINT it_request_events_kind_check
    CHECK (kind IN ('created', 'assigned', 'status', 'comment', 'cancelled', 'rejected', 'acknowledged'));

-- Per-recipient notification log. It doubles as the replay log for the SSE
-- stream: the event id is the notification id, so a reconnecting client
-- sends Last-Event-ID and receives everything it missed.
CREATE TABLE notifications (
    id           bigserial PRIMARY KEY,
    recipient_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN (
                    'transfer.created', 'transfer.acknowledged', 'transfer.advanced',
                    'request.created', 'request.acknowledged', 'request.status', 'request.assigned',
                    'request.comment', 'request.cancelled', 'request.rejected')),
    entity_type  text NOT NULL CHECK (entity_type IN ('transfer', 'it_request')),
    entity_id    text NOT NULL,
    ticket       text NOT NULL DEFAULT '',
    team_id      text,
    title        text NOT NULL CHECK (length(title) <= 200),
    body         text NOT NULL DEFAULT '' CHECK (length(body) <= 400),
    actor_id     text,
    actor_name   text NOT NULL DEFAULT '',
    read_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;
CREATE INDEX notifications_entity_idx ON notifications (entity_type, entity_id);
