package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/domain"
)

// LoginAccount is everything the login handler needs to decide on a sign-in.
type LoginAccount struct {
	User               domain.User
	Status             string
	PasswordHash       string // "" = no password set
	MustChangePassword bool
	FailedAttempts     int
	LockedUntil        *time.Time
}

const userCols = `id, name, email, title, role, team_id`

func scanUser(dst *domain.User, team **string) []any {
	return []any{&dst.ID, &dst.Name, &dst.Email, &dst.Title, &dst.Role, team}
}

func setTeam(u *domain.User, team *string) {
	if team != nil {
		u.TeamID = *team
	}
}

// AccountByEmail looks up an account for sign-in. found=false when unknown.
func (s *Store) AccountByEmail(ctx context.Context, email string) (LoginAccount, bool, error) {
	var a LoginAccount
	pool, err := s.pool()
	if err != nil {
		return a, false, err
	}
	var team, hash *string
	err = pool.QueryRow(ctx, `SELECT `+userCols+`, status, password_hash, must_change_password, failed_attempts, locked_until
		FROM users WHERE email = $1`, domain.NormalizeEmail(email)).
		Scan(append(scanUser(&a.User, &team), &a.Status, &hash, &a.MustChangePassword, &a.FailedAttempts, &a.LockedUntil)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, false, nil
	}
	if err != nil {
		return a, false, err
	}
	setTeam(&a.User, team)
	if hash != nil {
		a.PasswordHash = *hash
	}
	return a, true, nil
}

// RecordLoginFailure counts a failed password for an existing account and
// applies the lockout backoff. It returns the lock expiry (nil if not locked).
func (s *Store) RecordLoginFailure(ctx context.Context, actor Actor, userID string, now time.Time) (*time.Time, error) {
	var locked *time.Time
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var failures int
		if err := tx.QueryRow(ctx, `UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = $1
			RETURNING failed_attempts`, userID).Scan(&failures); err != nil {
			return err
		}
		data := map[string]any{"failedAttempts": failures}
		if d := auth.LockDuration(failures); d > 0 {
			until := now.Add(d)
			locked = &until
			if _, err := tx.Exec(ctx, `UPDATE users SET locked_until = $2 WHERE id = $1`, userID, until); err != nil {
				return err
			}
			data["lockedForSeconds"] = int(d.Seconds())
			if err := audit(ctx, tx, actor, "auth.lockout", "user", userID, data); err != nil {
				return err
			}
		}
		return audit(ctx, tx, actor, "auth.login_failed", "user", userID, data)
	})
	return locked, err
}

// AuthEvent records an auth event that is not tied to a write (e.g. a failed
// login for an unknown email, a throttled attempt).
func (s *Store) AuthEvent(ctx context.Context, actor Actor, action, entityID string, data map[string]any) error {
	pool, err := s.pool()
	if err != nil {
		return err
	}
	return audit(ctx, pool, actor, action, "user", entityID, data)
}

// NewSession is a session to persist. Only hashes are stored.
type NewSession struct {
	TokenHash string
	CSRFToken string
	IP        string
	UserAgent string
	ExpiresAt time.Time
}

// CompleteLogin resets the failure counter, optionally upgrades the password
// hash, revokes the session the browser presented (rotation), creates the new
// session and prunes long-dead ones.
func (s *Store) CompleteLogin(ctx context.Context, actor Actor, sess NewSession, rehash, previousTokenHash string) error {
	now := s.Now()
	return s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = $2,
			password_hash = COALESCE(NULLIF($3, ''), password_hash) WHERE id = $1`, actor.User.ID, now, rehash); err != nil {
			return err
		}
		if previousTokenHash != "" {
			if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, previousTokenHash, now); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
			VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`, sess.TokenHash, actor.User.ID, sess.CSRFToken, now, sess.ExpiresAt, sess.IP, truncate(sess.UserAgent, 300)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND (expires_at < $2 OR revoked_at < $2)`,
			actor.User.ID, now.Add(-30*24*time.Hour)); err != nil {
			return err
		}
		return audit(ctx, tx, actor, "auth.login_success", "user", actor.User.ID, map[string]any{"userAgent": truncate(sess.UserAgent, 120)})
	})
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// Principal is the authenticated caller resolved from a session token.
type Principal struct {
	User               domain.User
	SessionID          string
	CSRFToken          string
	MustChangePassword bool
	ExpiresAt          time.Time
}

var ErrNoSession = domain.Unauthenticated("Your session has ended. Please sign in again.")

// SessionPrincipal validates a session token hash: it must exist, not be
// revoked, expired or idle, and belong to an active account. last_seen_at is
// refreshed at most once a minute to keep reads cheap.
func (s *Store) SessionPrincipal(ctx context.Context, tokenHash string, idle time.Duration) (Principal, error) {
	return s.sessionPrincipal(ctx, tokenHash, idle, true)
}

// SessionStillValid re-checks a session without refreshing last_seen_at, so
// a long-lived event stream never keeps an idle session alive by itself.
func (s *Store) SessionStillValid(ctx context.Context, tokenHash string, idle time.Duration) (Principal, error) {
	return s.sessionPrincipal(ctx, tokenHash, idle, false)
}

func (s *Store) sessionPrincipal(ctx context.Context, tokenHash string, idle time.Duration, touch bool) (Principal, error) {
	var p Principal
	pool, err := s.pool()
	if err != nil {
		return p, err
	}
	now := s.Now()
	var team *string
	var lastSeen time.Time
	var revoked *time.Time
	var status string
	err = pool.QueryRow(ctx, `SELECT s.id, s.csrf_token, s.last_seen_at, s.expires_at, s.revoked_at,
		u.id, u.name, u.email, u.title, u.role, u.team_id, u.status, u.must_change_password
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, tokenHash).
		Scan(append([]any{&p.SessionID, &p.CSRFToken, &lastSeen, &p.ExpiresAt, &revoked},
			append(scanUser(&p.User, &team), &status, &p.MustChangePassword)...)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNoSession
	}
	if err != nil {
		return p, err
	}
	setTeam(&p.User, team)
	if status != "active" || !auth.SessionValid(lastSeen, p.ExpiresAt, revoked != nil, idle, now) {
		return Principal{}, ErrNoSession
	}
	if touch && now.Sub(lastSeen) > time.Minute {
		_, _ = pool.Exec(ctx, `UPDATE sessions SET last_seen_at = $2 WHERE id = $1`, tokenHash, now)
	}
	return p, nil
}

// Logout revokes one session.
func (s *Store) Logout(ctx context.Context, actor Actor, sessionID string) error {
	return s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, sessionID); err != nil {
			return err
		}
		return audit(ctx, tx, actor, "auth.logout", "user", actor.User.ID, map[string]any{})
	})
}

// PasswordHash returns the caller's current hash (for change-password).
func (s *Store) PasswordHash(ctx context.Context, userID string) (string, error) {
	pool, err := s.pool()
	if err != nil {
		return "", err
	}
	var h *string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, userID).Scan(&h); err != nil {
		return "", err
	}
	if h == nil {
		return "", nil
	}
	return *h, nil
}

// ChangePassword stores a new hash, clears must_change_password, revokes every
// session of the user and issues a fresh one (rotation).
func (s *Store) ChangePassword(ctx context.Context, actor Actor, newHash string, sess NewSession) error {
	now := s.Now()
	return s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = $3,
			failed_attempts = 0, locked_until = NULL, version = version + 1, updated_at = $3 WHERE id = $1`, actor.User.ID, newHash, now); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, actor.User.ID, now); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
			VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`, sess.TokenHash, actor.User.ID, sess.CSRFToken, now, sess.ExpiresAt, sess.IP, truncate(sess.UserAgent, 300)); err != nil {
			return err
		}
		return audit(ctx, tx, actor, "auth.password_changed", "user", actor.User.ID, map[string]any{})
	})
}

// EnsureAdmin creates an admin account with the given password hash unless an
// account with that email already exists (never overwrites a password).
func (s *Store) EnsureAdmin(ctx context.Context, email, name, hash string, mustChange bool) (bool, error) {
	pool, err := s.pool()
	if err != nil {
		return false, err
	}
	tag, err := pool.Exec(ctx, `INSERT INTO users (id, email, name, title, role, password_hash, must_change_password, created_by)
		VALUES ($1, $2, $3, 'Administrator', 'admin', $4, $5, 'bootstrap') ON CONFLICT (email) DO NOTHING`,
		NewID("usr"), domain.NormalizeEmail(email), name, hash, mustChange)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 1 {
		_ = audit(ctx, pool, Actor{User: domain.User{Name: "system"}}, "user.created", "user", domain.NormalizeEmail(email),
			map[string]any{"role": "admin", "via": "bootstrap"})
		return true, nil
	}
	return false, nil
}
