-- Seats show plain numbers (1, 2, … 100 …) instead of codes like "L4-A01".
-- Renumber every floor once, in reading order (top row first, left to right),
-- both the published seats and the working draft, and drop the code prefix.
-- Seat ids do not change, so members, zones and history stay attached; the
-- admin can still set any number per seat afterwards.

-- Two steps so the per-floor unique index never sees a transient clash.
UPDATE floor_cells SET code = 'TMP-' || upper(substr(md5(id), 1, 11)) WHERE kind = 'seat';

UPDATE floor_cells c
SET code = n.num::text
FROM (
    SELECT id, row_number() OVER (PARTITION BY floor_id ORDER BY y, x, id) AS num
    FROM floor_cells
    WHERE kind = 'seat'
) n
WHERE c.id = n.id;

UPDATE floors f
SET seat_prefix = '',
    draft = jsonb_set(f.draft, '{elements}', COALESCE((
        SELECT jsonb_agg(
                   CASE WHEN s.n IS NULL THEN s.e
                        ELSE s.e || jsonb_build_object('code', s.n::text) END
                   ORDER BY s.ord)
        FROM (
            SELECT t.e, t.ord,
                   CASE WHEN t.e->>'kind' = 'seat' THEN
                       row_number() OVER (PARTITION BY (t.e->>'kind' = 'seat')
                                          ORDER BY (t.e->>'y')::int, (t.e->>'x')::int, t.e->>'id')
                   END AS n
            FROM jsonb_array_elements(f.draft->'elements') WITH ORDINALITY AS t(e, ord)
        ) s
    ), '[]'::jsonb))
WHERE jsonb_typeof(f.draft->'elements') = 'array';
