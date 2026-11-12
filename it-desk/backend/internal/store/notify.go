package store

// Notifications and real-time fan-out.
//
// Mutations call notify / publishEntity inside their own transaction: the
// notification rows commit atomically with the change, and pg_notify is only
// delivered by Postgres when (and if) the transaction commits.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/realtime"
)

var errNotificationNotFound = domain.NotFound("Notification not found.")

func (s *Store) channel() string { return s.db.EventChannel() }

func publish(ctx context.Context, q querier, channel string, env realtime.Envelope) error {
	raw, err := json.Marshal(env)
	if err != nil {
		return err
	}
	if len(raw) > 7900 {
		return fmt.Errorf("realtime envelope too large (%d bytes)", len(raw))
	}
	_, err = q.Exec(ctx, `SELECT pg_notify($1, $2)`, channel, string(raw))
	return err
}

// note is a notification before it is addressed to recipients.
type note struct {
	kind, entityType, entityID, ticket string
	teamID                             *string
	title, body                        string
}

// notify stores one notification per recipient (deduped, never the actor
// themself, inactive accounts skipped) and queues the live events.
func (s *Store) notify(ctx context.Context, q querier, actor Actor, recipients []string, n note) error {
	seen := map[string]bool{actor.User.ID: true, "": true}
	var ids []string
	for _, r := range recipients {
		if !seen[r] {
			seen[r] = true
			ids = append(ids, r)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	slices.Sort(ids)
	title, body := domain.Truncate(n.title, 200), domain.Truncate(n.body, 400)
	var actorID *string
	if actor.User.ID != "" {
		actorID = &actor.User.ID
	}
	rows, err := q.Query(ctx, `INSERT INTO notifications (recipient_id, kind, entity_type, entity_id, ticket, team_id,
			title, body, actor_id, actor_name, created_at)
		SELECT u.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 FROM users u
		WHERE u.id = ANY($1) AND u.status = 'active'
		RETURNING id, recipient_id, created_at`,
		ids, n.kind, n.entityType, n.entityID, n.ticket, n.teamID, title, body, actorID, actor.User.Name, s.Now())
	if err != nil {
		return err
	}
	type made struct {
		id        int64
		recipient string
		at        time.Time
	}
	var out []made
	for rows.Next() {
		var m made
		if err := rows.Scan(&m.id, &m.recipient, &m.at); err != nil {
			rows.Close()
			return err
		}
		out = append(out, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, m := range out {
		data, err := json.Marshal(domain.Notification{ID: m.id, Kind: n.kind, EntityType: n.entityType, EntityID: n.entityID,
			Ticket: n.ticket, TeamID: n.teamID, Title: title, Body: body, ActorID: actorID, ActorName: actor.User.Name,
			CreatedAt: domain.NewTime(m.at)})
		if err != nil {
			return err
		}
		if err := publish(ctx, q, s.channel(), realtime.Envelope{Type: realtime.TypeNotification, Recipient: m.recipient, ID: m.id, Data: data}); err != nil {
			return err
		}
	}
	return nil
}

// publishEntity tells every connected client that can see the entity that
// it changed. teams scopes it for team leads (nil = org-wide: no leads).
func (s *Store) publishEntity(ctx context.Context, q querier, actor Actor, ch domain.EntityChange, teams ...*string) error {
	ch.ActorID = actor.User.ID
	data, err := json.Marshal(ch)
	if err != nil {
		return err
	}
	var scope []string
	for _, t := range teams {
		if t != nil && *t != "" && !slices.Contains(scope, *t) {
			scope = append(scope, *t)
		}
	}
	return publish(ctx, q, s.channel(), realtime.Envelope{Type: realtime.TypeEntity, Teams: scope, Data: data})
}

// publishScoped is publishEntity with a role filter (nil = every role that
// may see the teams).
func (s *Store) publishScoped(ctx context.Context, q querier, actor Actor, ch domain.EntityChange, roles []string, teams ...*string) error {
	ch.ActorID = actor.User.ID
	data, err := json.Marshal(ch)
	if err != nil {
		return err
	}
	var scope []string
	for _, t := range teams {
		if t != nil && *t != "" && !slices.Contains(scope, *t) {
			scope = append(scope, *t)
		}
	}
	return publish(ctx, q, s.channel(), realtime.Envelope{Type: realtime.TypeEntity, Roles: roles, Teams: scope, Data: data})
}

// publishMembers tells everyone who can see the teams that people (and so
// seats, counts and charts) changed.
func (s *Store) publishMembers(ctx context.Context, q querier, actor Actor, id, change string, version int, teams ...*string) error {
	return s.publishEntity(ctx, q, actor, domain.EntityChange{Entity: domain.EntityMember, ID: id, Change: change, Version: version}, teams...)
}

// publishUser tells admins an account changed and, when it touches a team's
// leads, everyone who can see those teams (directory and lead names).
func (s *Store) publishUser(ctx context.Context, q querier, actor Actor, id, change string, version int, teams ...*string) error {
	if err := s.publishScoped(ctx, q, actor, domain.EntityChange{Entity: domain.EntityUser, ID: id, Change: change, Version: version},
		[]string{"admin"}); err != nil {
		return err
	}
	var scope []*string
	for _, t := range teams {
		if t != nil && *t != "" {
			scope = append(scope, t)
		}
	}
	if len(scope) == 0 {
		return nil
	}
	return s.publishEntity(ctx, q, actor, domain.EntityChange{Entity: domain.EntityTeam, ID: *scope[0], Change: "leads"}, scope...)
}

// kickSessions makes the user's open event streams re-check their session
// immediately (they close with "session invalid" if it was revoked).
func (s *Store) kickSessions(ctx context.Context, q querier, userID string) error {
	return publish(ctx, q, s.channel(), realtime.Envelope{Type: realtime.TypeSession, Recipient: userID, Data: json.RawMessage(`{}`)})
}

// activeIT lists every active IT account.
func activeIT(ctx context.Context, q querier) ([]string, error) {
	return userIDs(ctx, q, `SELECT id FROM users WHERE role = 'it' AND status = 'active' ORDER BY id`)
}

// teamLeads lists the active leads of the given teams (nil/empty ignored),
// so a lead is only ever notified about their own team.
func teamLeads(ctx context.Context, q querier, teams ...*string) ([]string, error) {
	var ids []string
	for _, t := range teams {
		if t != nil && *t != "" {
			ids = append(ids, *t)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	return userIDs(ctx, q, `SELECT id FROM users WHERE role = 'team_lead' AND status = 'active' AND team_id = ANY($1) ORDER BY id`, ids)
}

func userIDs(ctx context.Context, q querier, sql string, args ...any) ([]string, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func teamName(ctx context.Context, q querier, id *string) string {
	if id == nil || *id == "" {
		return ""
	}
	var name string
	_ = q.QueryRow(ctx, `SELECT name FROM teams WHERE id = $1`, *id).Scan(&name)
	return name
}

func strp(s string) *string { return &s }

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ---- reads / writes for the bell -------------------------------------------

const notificationCols = `id, kind, entity_type, entity_id, ticket, team_id, title, body, actor_id, actor_name, read_at, created_at`

func scanNotifications(rows pgx.Rows) ([]domain.Notification, error) {
	defer rows.Close()
	out := []domain.Notification{}
	for rows.Next() {
		var n domain.Notification
		var read *time.Time
		var created time.Time
		if err := rows.Scan(&n.ID, &n.Kind, &n.EntityType, &n.EntityID, &n.Ticket, &n.TeamID, &n.Title, &n.Body,
			&n.ActorID, &n.ActorName, &read, &created); err != nil {
			return nil, err
		}
		if read != nil {
			t := domain.NewTime(*read)
			n.ReadAt = &t
		}
		n.CreatedAt = domain.NewTime(created)
		out = append(out, n)
	}
	return out, rows.Err()
}

// Notifications pages the caller's notifications newest first.
func (s *Store) Notifications(ctx context.Context, actor Actor, before int64, limit int, unreadOnly bool) (domain.NotificationPage, error) {
	out := domain.NotificationPage{Items: []domain.Notification{}}
	pool, err := s.pool()
	if err != nil {
		return out, err
	}
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	conds := []string{"recipient_id = $1"}
	args := []any{actor.User.ID}
	if before > 0 {
		args = append(args, before)
		conds = append(conds, fmt.Sprintf("id < $%d", len(args)))
	}
	if unreadOnly {
		conds = append(conds, "read_at IS NULL")
	}
	rows, err := pool.Query(ctx, `SELECT `+notificationCols+` FROM notifications WHERE `+strings.Join(conds, " AND ")+
		fmt.Sprintf(` ORDER BY id DESC LIMIT %d`, limit+1), args...)
	if err != nil {
		return out, err
	}
	items, err := scanNotifications(rows)
	if err != nil {
		return out, err
	}
	if len(items) > limit {
		items = items[:limit]
		next := items[len(items)-1].ID
		out.NextBefore = &next
	}
	out.Items = items
	out.Unread, err = s.UnreadCount(ctx, actor.User.ID)
	return out, err
}

// NotificationsSince returns the user's notifications after id (oldest
// first) for SSE resume.
func (s *Store) NotificationsSince(ctx context.Context, userID string, after int64, limit int) ([]domain.Notification, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `SELECT `+notificationCols+` FROM notifications WHERE recipient_id = $1 AND id > $2
		ORDER BY id LIMIT $3`, userID, after, limit)
	if err != nil {
		return nil, err
	}
	return scanNotifications(rows)
}

// UnreadCount is the bell badge.
func (s *Store) UnreadCount(ctx context.Context, userID string) (int, error) {
	pool, err := s.pool()
	if err != nil {
		return 0, err
	}
	var n int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE recipient_id = $1 AND read_at IS NULL`, userID).Scan(&n)
	return n, err
}

// ReadResult is returned by the mark-read endpoints.
type ReadResult struct {
	Updated int     `json:"updated"`
	Unread  int     `json:"unread"`
	IDs     []int64 `json:"ids,omitempty"`
	All     bool    `json:"all,omitempty"`
}

// MarkNotificationRead marks one of the caller's notifications read
// (idempotent) and syncs their other tabs.
func (s *Store) MarkNotificationRead(ctx context.Context, actor Actor, id int64) (ReadResult, error) {
	var out ReadResult
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var readAt *time.Time
		err := tx.QueryRow(ctx, `SELECT read_at FROM notifications WHERE id = $1 AND recipient_id = $2 FOR UPDATE`, id, actor.User.ID).Scan(&readAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotificationNotFound
		}
		if err != nil {
			return err
		}
		if readAt == nil {
			if _, err := tx.Exec(ctx, `UPDATE notifications SET read_at = $2 WHERE id = $1`, id, s.Now()); err != nil {
				return err
			}
			out.Updated = 1
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE recipient_id = $1 AND read_at IS NULL`, actor.User.ID).Scan(&out.Unread); err != nil {
			return err
		}
		out.IDs = []int64{id}
		if out.Updated == 0 {
			return nil
		}
		return s.publishRead(ctx, tx, actor.User.ID, out)
	})
	return out, err
}

// MarkAllNotificationsRead marks everything read.
func (s *Store) MarkAllNotificationsRead(ctx context.Context, actor Actor) (ReadResult, error) {
	var out ReadResult
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE notifications SET read_at = $2 WHERE recipient_id = $1 AND read_at IS NULL`, actor.User.ID, s.Now())
		if err != nil {
			return err
		}
		out = ReadResult{Updated: int(tag.RowsAffected()), All: true}
		if out.Updated == 0 {
			return nil
		}
		return s.publishRead(ctx, tx, actor.User.ID, out)
	})
	return out, err
}

func (s *Store) publishRead(ctx context.Context, q querier, userID string, r ReadResult) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return publish(ctx, q, s.channel(), realtime.Envelope{Type: realtime.TypeRead, Recipient: userID, Data: data})
}

// PurgeNotifications deletes read notifications older than the cutoff.
func (s *Store) PurgeNotifications(ctx context.Context, olderThan time.Duration) (int64, error) {
	pool, err := s.pool()
	if err != nil {
		return 0, err
	}
	tag, err := pool.Exec(ctx, `DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < $1`, s.Now().Add(-olderThan))
	return tag.RowsAffected(), err
}
