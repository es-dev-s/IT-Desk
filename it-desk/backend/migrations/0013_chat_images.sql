-- Screenshots on request chat, and room for a message that is only an image.
-- Messages older than a month are deleted by the API (rows cascade to files).

ALTER TABLE it_request_messages DROP CONSTRAINT IF EXISTS it_request_messages_body_check;
ALTER TABLE it_request_messages
    ADD CONSTRAINT it_request_messages_body_len CHECK (length(body) <= 2000);

CREATE TABLE it_request_message_files (
    id           text PRIMARY KEY,
    message_id   text NOT NULL REFERENCES it_request_messages(id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    data         bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 2097152),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX it_request_message_files_message_idx ON it_request_message_files (message_id);
