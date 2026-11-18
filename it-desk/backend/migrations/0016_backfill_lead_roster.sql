-- Every active team lead gets a roster record on their own team, so existing
-- leads can be edited and seated like any member (by an admin, or by the lead
-- themselves). The record starts without a seat; the lead badge comes from the
-- matching account (members.is_lead stays false, as when a lead seats
-- themselves). Leads whose email is already on any roster are left alone.
INSERT INTO members (id, name, email, role, sub_group, team_id, status, joined_at, hue)
SELECT 'mem_' || substr(md5(u.id || clock_timestamp()::text), 1, 16),
       u.name,
       lower(u.email),
       CASE WHEN length(btrim(u.title)) >= 2 THEN left(btrim(u.title), 80) ELSE 'Team Lead' END,
       'General',
       u.team_id,
       'active',
       current_date,
       abs(hashtext(lower(u.name))) % 360
FROM users u
WHERE u.role = 'team_lead' AND u.status = 'active' AND u.team_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM members m WHERE lower(m.email) = lower(u.email));
