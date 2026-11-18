-- Super admin <-> team lead direct chats.
--
-- Admin <-> IT staff chats reuse the lead/staff shape (lead_id holds the admin
-- account). A chat between an admin and a team lead has no IT staff entry, so
-- staff_id becomes optional and admin_id names the admin; the lead stays in
-- lead_id. Exactly one of staff_id / admin_id is set.
ALTER TABLE it_direct_chats
    ALTER COLUMN staff_id DROP NOT NULL,
    ADD COLUMN admin_id text REFERENCES users(id) ON DELETE CASCADE,
    ADD CONSTRAINT it_direct_chats_one_peer CHECK ((staff_id IS NULL) <> (admin_id IS NULL));
CREATE UNIQUE INDEX it_direct_chats_admin_uidx ON it_direct_chats (lead_id, admin_id) WHERE admin_id IS NOT NULL;
CREATE INDEX it_direct_chats_admin_idx ON it_direct_chats (admin_id) WHERE admin_id IS NOT NULL;
