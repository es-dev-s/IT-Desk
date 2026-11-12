-- Authentication & role-based access control.
--
-- Accounts are created only by an admin (no self sign-up). Every person who
-- signs in is a row in "users"; the former single-lead "leads" table is folded
-- into it (each lead becomes a team_lead account that has no password until an
-- admin sets one or the seed provisions it).

CREATE TABLE users (
    id                    text PRIMARY KEY,
    email                 text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
    name                  text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
    title                 text NOT NULL DEFAULT '' CHECK (length(title) <= 80),
    role                  text NOT NULL CHECK (role IN ('admin', 'team_lead', 'it')),
    team_id               text REFERENCES teams(id),
    -- argon2id PHC string; NULL = no password set (cannot sign in)
    password_hash         text,
    status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    must_change_password  boolean NOT NULL DEFAULT true,
    failed_attempts       int  NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until          timestamptz,
    last_login_at         timestamptz,
    password_changed_at   timestamptz,
    preferences           jsonb NOT NULL DEFAULT '{}'::jsonb,
    version               int  NOT NULL DEFAULT 0,
    created_by            text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    -- A team lead always belongs to exactly one team; admins and IT are org-wide.
    CONSTRAINT users_team_matches_role CHECK ((role = 'team_lead') = (team_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_team_idx ON users (team_id) WHERE team_id IS NOT NULL;

-- Opaque session tokens: only the SHA-256 of the token is stored, so a database
-- leak does not leak usable sessions. The per-session CSRF token is stored as
-- is: it is useless without the session cookie and must be re-readable by the
-- owner (GET /auth/me) after a page reload.
CREATE TABLE sessions (
    id            text PRIMARY KEY,          -- sha256(token), hex
    user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token    text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    ip            text NOT NULL DEFAULT '',
    user_agent    text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- Fold the old leads table into users.
INSERT INTO users (id, email, name, title, role, team_id, preferences, version, must_change_password, created_at, updated_at)
SELECT id, lower(email), name, title, 'team_lead', team_id, preferences, version, true, updated_at, updated_at FROM leads;
DROP TABLE leads;

-- Who (by account) started a change, so "undo" is limited to its author.
ALTER TABLE transfers ADD COLUMN initiated_by_user text;
ALTER TABLE exits ADD COLUMN initiated_by_user text;
CREATE INDEX transfers_teams_idx ON transfers (from_team_id, to_team_id);

-- Audit entries now record which account acted and from where.
ALTER TABLE audit_log ADD COLUMN actor_id text, ADD COLUMN ip text NOT NULL DEFAULT '';
CREATE INDEX audit_log_action_idx ON audit_log (action, at DESC);
