-- Team catalogue: every team gets a URL-safe slug, and codes may be 2–3
-- letters (they label team badges). Existing rows get a slug derived from
-- their name; inserts that omit it get one the same way.

ALTER TABLE teams ADD COLUMN slug text;

CREATE FUNCTION team_slug(name text) RETURNS text
    LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS
$$ SELECT trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) $$;

UPDATE teams SET slug = team_slug(name);
-- Two names that slug the same keep their ids apart.
UPDATE teams t SET slug = t.slug || '-' || team_slug(t.id)
    WHERE EXISTS (SELECT 1 FROM teams o WHERE o.slug = t.slug AND o.id < t.id);

CREATE FUNCTION teams_fill_slug() RETURNS trigger
    LANGUAGE plpgsql SET search_path FROM CURRENT AS
$$
BEGIN
    IF NEW.slug IS NULL OR NEW.slug = '' THEN
        NEW.slug := team_slug(NEW.name);
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER teams_fill_slug BEFORE INSERT OR UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION teams_fill_slug();

ALTER TABLE teams ALTER COLUMN slug SET NOT NULL;
ALTER TABLE teams ADD CONSTRAINT teams_slug_key UNIQUE (slug);
ALTER TABLE teams ADD CONSTRAINT teams_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_code_check;
ALTER TABLE teams ADD CONSTRAINT teams_code_check CHECK (code ~ '^[A-Z]{2,3}$');

-- No lead yet is a normal state for a new team.
ALTER TABLE teams ALTER COLUMN lead_name SET DEFAULT '';
