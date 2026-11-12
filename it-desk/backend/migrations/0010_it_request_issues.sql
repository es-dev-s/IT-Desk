-- IT issues: team leads (and admins) can now report a problem to IT — a broken
-- laptop, no network, a software or access problem — through the same
-- "Request IT" flow. An issue is an it_requests row with request_type = 'issue':
-- it reuses the ticket series (REQ-…), team scoping, assignment, the
-- open → in progress → resolved workflow, the timeline and notifications.
-- Issues carry a category and a short title instead of equipment items; the
-- existing notes column is the description. Existing rows become 'equipment'.

ALTER TABLE it_requests
    ADD COLUMN request_type   text NOT NULL DEFAULT 'equipment' CHECK (request_type IN ('equipment', 'issue')),
    ADD COLUMN issue_category text CHECK (issue_category IN ('hardware', 'network', 'software', 'access', 'other')),
    ADD COLUMN title          text NOT NULL DEFAULT '' CHECK (length(title) <= 120),
    -- Optional free text: asset tag or a description of the affected device.
    ADD COLUMN device         text NOT NULL DEFAULT '' CHECK (length(device) <= 80),
    ADD CONSTRAINT it_requests_issue_shape CHECK (
        (request_type = 'equipment' AND issue_category IS NULL AND title = '' AND device = '')
        OR (request_type = 'issue' AND issue_category IS NOT NULL AND length(btrim(title)) >= 3)
    );

CREATE INDEX it_requests_type_idx ON it_requests (request_type, status, created_at DESC);
