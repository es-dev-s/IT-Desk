// Package db owns the pgx connection pool: connect with retry/backoff, run
// embedded migrations under an advisory lock, and classify Postgres errors.
package db

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"itdesk/backend/internal/config"
)

type DB struct {
	Pool   *pgxpool.Pool
	Schema string
	log    *slog.Logger
	ready  atomic.Bool

	mu      sync.Mutex
	lastErr string
}

// New builds a lazily-connecting pool with sane limits and server-side
// timeouts. It does not touch the network; call Connect/Start for that.
func New(cfg config.Config, log *slog.Logger) (*DB, error) {
	pc, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, errors.New("DATABASE_URL could not be parsed")
	}
	pc.MaxConns = cfg.DBMaxConns
	pc.MinConns = cfg.DBMinConns
	pc.MaxConnLifetime = 30 * time.Minute
	pc.MaxConnLifetimeJitter = 5 * time.Minute
	pc.MaxConnIdleTime = 5 * time.Minute
	pc.HealthCheckPeriod = 30 * time.Second
	pc.ConnConfig.ConnectTimeout = 5 * time.Second
	rp := pc.ConnConfig.RuntimeParams
	rp["application_name"] = "itdesk-api"
	rp["search_path"] = cfg.DBSchema
	rp["timezone"] = "UTC"
	rp["statement_timeout"] = strconv.FormatInt(cfg.StatementTimeout.Milliseconds(), 10)
	rp["lock_timeout"] = "3000"
	rp["idle_in_transaction_session_timeout"] = "15000"

	pool, err := pgxpool.NewWithConfig(context.Background(), pc)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	return &DB{Pool: pool, Schema: cfg.DBSchema, log: log}, nil
}

func (d *DB) Ready() bool { return d.ready.Load() }

func (d *DB) LastError() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lastErr
}

func (d *DB) setErr(err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err == nil {
		d.lastErr = ""
	} else {
		d.lastErr = err.Error()
	}
}

// Connect pings until the database answers, backing off exponentially (with
// jitter) from 500ms up to 30s. attempts <= 0 retries until ctx is cancelled.
func (d *DB) Connect(ctx context.Context, attempts int) error {
	backoff := 500 * time.Millisecond
	for i := 1; ; i++ {
		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := d.Pool.Ping(pingCtx)
		cancel()
		if err == nil {
			d.setErr(nil)
			d.log.Info("database reachable", "attempt", i)
			return nil
		}
		d.setErr(err)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if attempts > 0 && i >= attempts {
			return fmt.Errorf("database unreachable after %d attempts: %w", i, err)
		}
		sleep := backoff/2 + time.Duration(rand.Int64N(int64(backoff/2)+1))
		d.log.Warn("database not reachable yet, retrying", "attempt", i, "retry_in", sleep.Round(time.Millisecond), "err", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(sleep):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// Start connects (retrying forever), applies migrations if asked and flips the
// ready flag. Run it in a goroutine so the HTTP server can come up first and
// report 503 from /readyz until the database is usable.
func (d *DB) Start(ctx context.Context, migrate bool) {
	backoff := time.Second
	for {
		if err := d.Connect(ctx, 0); err != nil {
			return
		}
		if !migrate {
			break
		}
		err := Migrate(ctx, d.Pool, d.Schema, d.log)
		if err == nil {
			break
		}
		d.setErr(err)
		d.log.Error("migration failed, retrying", "err", err, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
	d.ready.Store(true)
	d.log.Info("database ready", "schema", d.Schema)
}

func (d *DB) MarkReady() { d.ready.Store(true) }

func (d *DB) Close() { d.Pool.Close() }

// Error classification ------------------------------------------------------

func Code(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return ""
}

// Constraint returns the name of the constraint a PostgreSQL error is about.
func Constraint(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.ConstraintName
	}
	return ""
}

// IsRetryable reports serialization failures and deadlocks, which are safe to
// retry as a whole transaction.
func IsRetryable(err error) bool {
	switch Code(err) {
	case "40001", "40P01":
		return true
	}
	return false
}

// IsSeatConflict reports a unique/exclusion violation (seat double-booking).
func IsSeatConflict(err error) bool {
	switch Code(err) {
	case "23505", "23P01":
		return true
	}
	return false
}

func IsTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	switch Code(err) {
	case "57014", "55P03": // query_canceled (statement_timeout), lock_not_available
		return true
	}
	return false
}

// IsUnavailable reports errors meaning the database cannot be reached right
// now (connection refused/reset, server shutting down). The API maps these to
// 503 + Retry-After so clients back off and retry.
func IsUnavailable(err error) bool {
	if err == nil {
		return false
	}
	var ce *pgconn.ConnectError
	var ne net.Error
	if errors.As(err, &ce) || errors.As(err, &ne) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	c := Code(err)
	return strings.HasPrefix(c, "08") || c == "57P01" || c == "57P02" || c == "57P03" || c == "53300"
}

// EventChannel is the LISTEN/NOTIFY channel for real-time events. It is
// per schema so parallel test schemas (and other apps) never cross-talk.
func (d *DB) EventChannel() string { return EventChannel(d.Schema) }

// EventChannel names the notify channel for a schema.
func EventChannel(schema string) string { return "itdesk_events_" + schema }
