CREATE TABLE it_direct_chats (
    id           text PRIMARY KEY,
    lead_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    staff_id     text NOT NULL REFERENCES it_staff(id) ON DELETE CASCADE,
    lead_read_at timestamptz,
    it_read_at   timestamptz,
    UNIQUE (lead_id, staff_id)
);
CREATE INDEX it_direct_chats_staff_idx ON it_direct_chats (staff_id);

ALTER TABLE it_request_messages
    ALTER COLUMN request_id DROP NOT NULL,
    ADD COLUMN direct_chat_id text REFERENCES it_direct_chats(id) ON DELETE CASCADE,
    ADD CONSTRAINT it_messages_one_conversation CHECK ((request_id IS NULL) <> (direct_chat_id IS NULL));
CREATE INDEX it_messages_direct_idx ON it_request_messages (direct_chat_id, created_at, id) WHERE direct_chat_id IS NOT NULL;
