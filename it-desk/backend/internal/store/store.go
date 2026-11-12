// Package store is the repository layer: every read and write the API makes,
// with transactional, lock-ordered mutations so concurrent requests can never
// double-book a seat or move the same person twice.
package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
)

type Store struct {
	db         *db.DB
	log        *slog.Logger
	UndoWindow time.Duration
	Now        func() time.Time
}

func New(d *db.DB, log *slog.Logger, undoWindow time.Duration) *Store {
	return &Store{db: d, log: log, UndoWindow: undoWindow, Now: func() time.Time { return time.Now().UTC() }}
}

// Actor is the authenticated user on whose behalf a request runs. It is built
// by the HTTP layer from a validated session, never from client input.
type Actor struct {
	User      domain.User
	RequestID string
	IP        string
}

// TeamScope is the team a request is confined to: the lead's own team, or ""
// for org-wide roles (admin, IT). Every read/write that touches team data
// filters on it, so scoping does not depend on the UI.
func (a Actor) TeamScope() string {
	if a.User.Role == "team_lead" {
		return a.User.TeamID
	}
	return ""
}

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func (s *Store) pool() (*pgxpool.Pool, error) {
	if !s.db.Ready() {
		return nil, domain.ErrUnavailable
	}
	return s.db.Pool, nil
}

// withTx runs fn in a transaction, retrying the whole thing on serialization
// failures and deadlocks with a short exponential backoff.
func (s *Store) withTx(ctx context.Context, opts pgx.TxOptions, fn func(pgx.Tx) error) error {
	pool, err := s.pool()
	if err != nil {
		return err
	}
	var last error
	for attempt := 0; attempt < 4; attempt++ {
		err := pgx.BeginTxFunc(ctx, pool, opts, fn)
		if err == nil {
			return nil
		}
		if !db.IsRetryable(err) || ctx.Err() != nil {
			return err
		}
		last = err
		s.log.Warn("retrying transaction", "attempt", attempt+1, "err", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(25<<attempt) * time.Millisecond):
		}
	}
	return last
}

var writeTx = pgx.TxOptions{IsoLevel: pgx.ReadCommitted}
var snapshotTx = pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}

func NewID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func audit(ctx context.Context, q querier, actor Actor, action, entity, entityID string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	name := actor.User.Name
	if name == "" {
		name = "system"
	}
	_, err = q.Exec(ctx, `INSERT INTO audit_log (actor, actor_id, action, entity, entity_id, request_id, data, ip)
		VALUES ($1, NULLIF($2, ''), $3, $4, $5, $6, $7, $8)`, name, actor.User.ID, action, entity, entityID, actor.RequestID, raw, actor.IP)
	return err
}

func (s *Store) Ping(ctx context.Context) error {
	pool, err := s.pool()
	if err != nil {
		return err
	}
	return pool.Ping(ctx)
}

func (s *Store) PoolStats() map[string]int32 {
	st := s.db.Pool.Stat()
	return map[string]int32{
		"total":    st.TotalConns(),
		"idle":     st.IdleConns(),
		"acquired": st.AcquiredConns(),
		"max":      st.MaxConns(),
	}
}

func (s *Store) undoDeadline(created time.Time) time.Time { return created.Add(s.UndoWindow) }
