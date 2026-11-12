-- IT staff directory: the people in IT a request can be routed to when it is
-- raised ("Assign to"). These are directory entries, not login accounts; the
-- account-based assignee (assignee_id → users) keeps working alongside.

CREATE TABLE it_staff (
    id          text PRIMARY KEY,
    name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
    title       text NOT NULL DEFAULT '' CHECK (length(title) <= 80),
    active      boolean NOT NULL DEFAULT true,
    sort_order  int NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    version     int NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE UNIQUE INDEX it_staff_name_key ON it_staff (lower(btrim(name)));

-- Initial directory (from the IT team roster). Idempotent.
INSERT INTO it_staff (id, name, title, sort_order) VALUES
    ('its_manish_yadav',  'Manish Kumar Yadav', 'IT Cell Lead',                      0),
    ('its_akash_adhikari','Akash Adhikari',     'Associate IT',                      1),
    ('its_abash_thapa',   'Abash Thapa',        'Associate IT',                      2),
    ('its_ujjal_dahal',   'Ujjal Dahal',        'Inventory and Purchase Assistant',  3),
    ('its_nabin_baraili', 'Nabin Baraili',      'Inventory and Purchase Officer',    4)
ON CONFLICT DO NOTHING;

-- Optional IT staff member a request is routed to. The name is snapshotted so
-- the ticket still reads right if the directory entry is renamed or removed.
ALTER TABLE it_requests
    ADD COLUMN staff_id   text REFERENCES it_staff(id) ON DELETE SET NULL,
    ADD COLUMN staff_name text CHECK (staff_name IS NULL OR length(staff_name) <= 80);
CREATE INDEX it_requests_staff_idx ON it_requests (staff_id) WHERE staff_id IS NOT NULL;
