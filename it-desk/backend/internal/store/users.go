package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
)

const managedCols = `u.id, u.name, u.email, u.title, u.role, u.team_id, u.status, u.must_change_password,
	u.password_hash IS NOT NULL, u.locked_until, u.failed_attempts, u.last_login_at, u.created_at, u.updated_at, u.version,
	(SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())`

func scanManaged(row pgx.Row, now time.Time) (domain.ManagedUser, error) {
	var m domain.ManagedUser
	var team *string
	var locked, last *time.Time
	var created, updated time.Time
	err := row.Scan(&m.ID, &m.Name, &m.Email, &m.Title, &m.Role, &team, &m.Status, &m.MustChangePassword,
		&m.HasPassword, &locked, &m.FailedAttempts, &last, &created, &updated, &m.Version, &m.ActiveSessions)
	if err != nil {
		return m, err
	}
	setTeam(&m.User, team)
	if locked != nil && locked.After(now) {
		t := domain.NewTime(*locked)
		m.LockedUntil = &t
	}
	if last != nil {
		t := domain.NewTime(*last)
		m.LastLoginAt = &t
	}
	m.CreatedAt, m.UpdatedAt = domain.NewTime(created), domain.NewTime(updated)
	return m, nil
}

func loadManaged(ctx context.Context, q querier, id string, now time.Time) (domain.ManagedUser, error) {
	m, err := scanManaged(q.QueryRow(ctx, `SELECT `+managedCols+` FROM users u WHERE u.id = $1`, id), now)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, domain.NotFound("User not found.")
	}
	return m, err
}

// ListUsers returns every account (admin only), admins first, then by name.
func (s *Store) ListUsers(ctx context.Context) ([]domain.ManagedUser, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `SELECT `+managedCols+` FROM users u
		ORDER BY array_position(ARRAY['admin','team_lead','it'], u.role), lower(u.name), u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := s.Now()
	out := []domain.ManagedUser{}
	for rows.Next() {
		m, err := scanManaged(rows, now)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) GetUser(ctx context.Context, id string) (domain.ManagedUser, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.ManagedUser{}, err
	}
	return loadManaged(ctx, pool, id, s.Now())
}

func mapUserWriteErr(err error) error {
	switch db.Code(err) {
	case "23505":
		return domain.Invalid("Check the highlighted fields.", map[string]string{"email": "An account with this email already exists"})
	case "23503":
		return domain.Invalid("Check the highlighted fields.", map[string]string{"teamId": "Choose an existing team"})
	}
	return err
}

func teamExists(ctx context.Context, q querier, id string) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM teams WHERE id = $1)`, id).Scan(&ok)
	return ok, err
}

// teamLeadTakenMessage is the only copy the product shows for a second lead.
const teamLeadTakenMessage = "This team already has a Team Lead assigned."

// ensureSingleTeamLead refuses a second active team-lead account on teamID.
// The team row is locked so two creates cannot both pass. exceptUserID is the
// account being edited (empty when creating).
func ensureSingleTeamLead(ctx context.Context, tx pgx.Tx, teamID, exceptUserID string) error {
	if teamID == "" {
		return nil
	}
	var locked string
	err := tx.QueryRow(ctx, `SELECT id FROM teams WHERE id = $1 FOR UPDATE`, teamID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Invalid("Check the highlighted fields.", map[string]string{"teamId": "Choose an existing team"})
	}
	if err != nil {
		return err
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE role = 'team_lead' AND status = 'active' AND team_id = $1 AND id <> $2`, teamID, exceptUserID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return domain.Invalid(teamLeadTakenMessage, map[string]string{"teamId": teamLeadTakenMessage})
	}
	return nil
}

// CreateUser creates a team lead, IT or admin account with a one-time
// password hash; the user must change it on first sign-in.
func (s *Store) CreateUser(ctx context.Context, actor Actor, in domain.UserInput, tempHash string) (domain.ManagedUser, error) {
	if errs := in.Validate(); len(errs) > 0 {
		return domain.ManagedUser{}, domain.Invalid("Check the highlighted fields.", errs)
	}
	var out domain.ManagedUser
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if in.TeamID != "" {
			if ok, err := teamExists(ctx, tx, in.TeamID); err != nil {
				return err
			} else if !ok {
				return domain.Invalid("Check the highlighted fields.", map[string]string{"teamId": "Choose an existing team"})
			}
		}
		if in.Role == "team_lead" {
			if err := ensureSingleTeamLead(ctx, tx, in.TeamID, ""); err != nil {
				return err
			}
		}
		id := NewID("usr")
		if _, err := tx.Exec(ctx, `INSERT INTO users (id, email, name, title, role, team_id, password_hash, must_change_password, created_by)
			VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,true,$8)`, id, in.Email, in.Name, in.Title, in.Role, in.TeamID, tempHash, actor.User.ID); err != nil {
			return mapUserWriteErr(err)
		}
		if err := audit(ctx, tx, actor, "user.created", "user", id, map[string]any{"email": in.Email, "role": in.Role, "teamId": in.TeamID}); err != nil {
			return err
		}
		var err error
		if out, err = loadManaged(ctx, tx, id, s.Now()); err != nil {
			return err
		}
		return s.publishUser(ctx, tx, actor, id, "created", out.Version, strp(out.TeamID))
	})
	return out, err
}

// lockTarget loads and row-locks the account being administered.
func lockTarget(ctx context.Context, tx pgx.Tx, id string) (role, status string, version int, err error) {
	err = tx.QueryRow(ctx, `SELECT role, status, version FROM users WHERE id = $1 FOR UPDATE`, id).Scan(&role, &status, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		err = domain.NotFound("User not found.")
	}
	return
}

// ensureOtherAdmin fails if removing admin rights from `id` would leave the
// organisation without an active admin. Admin rows are locked so two
// concurrent demotions can't both pass.
func ensureOtherAdmin(ctx context.Context, tx pgx.Tx, id string) error {
	rows, err := tx.Query(ctx, `SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE`)
	if err != nil {
		return err
	}
	others := 0
	for rows.Next() {
		var aid string
		if err := rows.Scan(&aid); err != nil {
			rows.Close()
			return err
		}
		if aid != id {
			others++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if others == 0 {
		return domain.Conflict("last_admin", "At least one active admin is required.")
	}
	return nil
}

func revokeAll(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	tag, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, userID)
	return tag.RowsAffected(), err
}

// UpdateUser edits identity, role and team. Changing role, team or email
// revokes the user's sessions so new permissions apply immediately.
func (s *Store) UpdateUser(ctx context.Context, actor Actor, id string, in domain.UserInput) (domain.ManagedUser, error) {
	if errs := in.Validate(); len(errs) > 0 {
		return domain.ManagedUser{}, domain.Invalid("Check the highlighted fields.", errs)
	}
	var out domain.ManagedUser
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		role, status, version, err := lockTarget(ctx, tx, id)
		if err != nil {
			return err
		}
		if in.ExpectedVersion != nil && *in.ExpectedVersion != version {
			return domain.Conflict("stale_user", "This account was changed by someone else. Refresh and try again.")
		}
		if role == "admin" && in.Role != "admin" {
			if id == actor.User.ID {
				return domain.Conflict("self_action", "You can't remove your own admin role.")
			}
			if status == "active" {
				if err := ensureOtherAdmin(ctx, tx, id); err != nil {
					return err
				}
			}
		}
		if in.TeamID != "" {
			if ok, err := teamExists(ctx, tx, in.TeamID); err != nil {
				return err
			} else if !ok {
				return domain.Invalid("Check the highlighted fields.", map[string]string{"teamId": "Choose an existing team"})
			}
		}
		if in.Role == "team_lead" {
			if err := ensureSingleTeamLead(ctx, tx, in.TeamID, id); err != nil {
				return err
			}
		}
		var prevEmail string
		var prevTeam *string
		if err := tx.QueryRow(ctx, `SELECT email, team_id FROM users WHERE id = $1`, id).Scan(&prevEmail, &prevTeam); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET email = $2, name = $3, title = $4, role = $5, team_id = NULLIF($6,''),
			version = version + 1, updated_at = now() WHERE id = $1`, id, in.Email, in.Name, in.Title, in.Role, in.TeamID); err != nil {
			return mapUserWriteErr(err)
		}
		pt := ""
		if prevTeam != nil {
			pt = *prevTeam
		}
		privChange := role != in.Role || pt != in.TeamID || prevEmail != in.Email
		if privChange && id != actor.User.ID {
			if _, err := revokeAll(ctx, tx, id); err != nil {
				return err
			}
		}
		if in.Role == "team_lead" {
			if _, err := tx.Exec(ctx, `UPDATE teams SET lead_name = $2 WHERE id = $1`, in.TeamID, in.Name); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, actor, "user.updated", "user", id, map[string]any{
			"email": in.Email, "role": in.Role, "teamId": in.TeamID, "previousRole": role, "sessionsRevoked": privChange}); err != nil {
			return err
		}
		if out, err = loadManaged(ctx, tx, id, s.Now()); err != nil {
			return err
		}
		if privChange && id != actor.User.ID {
			if err := s.kickSessions(ctx, tx, id); err != nil {
				return err
			}
		}
		return s.publishUser(ctx, tx, actor, id, "updated", out.Version, prevTeam, strp(in.TeamID))
	})
	return out, err
}

// SetUserStatus disables (revoking sessions) or re-enables (clearing any
// lockout) an account.
func (s *Store) SetUserStatus(ctx context.Context, actor Actor, id string, enable bool) (domain.ManagedUser, error) {
	var out domain.ManagedUser
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		role, status, _, err := lockTarget(ctx, tx, id)
		if err != nil {
			return err
		}
		action := "user.enabled"
		if !enable {
			action = "user.disabled"
			if id == actor.User.ID {
				return domain.Conflict("self_action", "You can't disable your own account.")
			}
			if role == "admin" && status == "active" {
				if err := ensureOtherAdmin(ctx, tx, id); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE users SET status = 'disabled', version = version + 1, updated_at = now() WHERE id = $1`, id); err != nil {
				return err
			}
			if _, err := revokeAll(ctx, tx, id); err != nil {
				return err
			}
		} else {
			if role == "team_lead" {
				var teamID *string
				if err := tx.QueryRow(ctx, `SELECT team_id FROM users WHERE id = $1`, id).Scan(&teamID); err != nil {
					return err
				}
				if teamID != nil {
					if err := ensureSingleTeamLead(ctx, tx, *teamID, id); err != nil {
						return err
					}
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE users SET status = 'active', failed_attempts = 0, locked_until = NULL,
				version = version + 1, updated_at = now() WHERE id = $1`, id); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, actor, action, "user", id, map[string]any{}); err != nil {
			return err
		}
		if out, err = loadManaged(ctx, tx, id, s.Now()); err != nil {
			return err
		}
		if !enable {
			if err := s.kickSessions(ctx, tx, id); err != nil {
				return err
			}
		}
		return s.publishUser(ctx, tx, actor, id, out.Status, out.Version, strp(out.TeamID))
	})
	return out, err
}

// ResetPassword sets a one-time password, forces a change on next sign-in,
// clears any lockout and signs the user out everywhere.
func (s *Store) ResetPassword(ctx context.Context, actor Actor, id, tempHash string) (domain.ManagedUser, error) {
	var out domain.ManagedUser
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if _, _, _, err := lockTarget(ctx, tx, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, must_change_password = true, failed_attempts = 0,
			locked_until = NULL, version = version + 1, updated_at = now() WHERE id = $1`, id, tempHash); err != nil {
			return err
		}
		n, err := revokeAll(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "user.password_reset", "user", id, map[string]any{"sessionsRevoked": n}); err != nil {
			return err
		}
		if out, err = loadManaged(ctx, tx, id, s.Now()); err != nil {
			return err
		}
		if err := s.kickSessions(ctx, tx, id); err != nil {
			return err
		}
		return s.publishUser(ctx, tx, actor, id, "password_reset", out.Version)
	})
	return out, err
}

// RevokeSessions signs a user out of every device.
func (s *Store) RevokeSessions(ctx context.Context, actor Actor, id string) (domain.ManagedUser, error) {
	var out domain.ManagedUser
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if _, _, _, err := lockTarget(ctx, tx, id); err != nil {
			return err
		}
		n, err := revokeAll(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "user.sessions_revoked", "user", id, map[string]any{"count": n}); err != nil {
			return err
		}
		if out, err = loadManaged(ctx, tx, id, s.Now()); err != nil {
			return err
		}
		if err := s.kickSessions(ctx, tx, id); err != nil {
			return err
		}
		return s.publishUser(ctx, tx, actor, id, "sessions_revoked", out.Version)
	})
	return out, err
}

// DeleteUser permanently removes an account (its sessions cascade). The audit
// trail keeps the actor names.
func (s *Store) DeleteUser(ctx context.Context, actor Actor, id string) error {
	return s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		role, status, _, err := lockTarget(ctx, tx, id)
		if err != nil {
			return err
		}
		if id == actor.User.ID {
			return domain.Conflict("self_action", "You can't delete your own account.")
		}
		if role == "admin" && status == "active" {
			if err := ensureOtherAdmin(ctx, tx, id); err != nil {
				return err
			}
		}
		var email string
		var team *string
		if err := tx.QueryRow(ctx, `DELETE FROM users WHERE id = $1 RETURNING email, team_id`, id).Scan(&email, &team); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "user.deleted", "user", id, map[string]any{"email": email, "role": role}); err != nil {
			return err
		}
		if err := s.kickSessions(ctx, tx, id); err != nil {
			return err
		}
		return s.publishUser(ctx, tx, actor, id, "deleted", 0, team)
	})
}
