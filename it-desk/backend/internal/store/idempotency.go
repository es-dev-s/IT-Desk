package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type IdemRecord struct {
	Hash   string
	Status *int
	Body   []byte
}

// IdemBegin claims key for scope. started=true means this request owns it and
// must call IdemComplete or IdemAbort; otherwise rec holds the earlier attempt.
func (s *Store) IdemBegin(ctx context.Context, key, scope, hash string) (rec IdemRecord, started bool, err error) {
	pool, err := s.pool()
	if err != nil {
		return rec, false, err
	}
	tag, err := pool.Exec(ctx, `INSERT INTO idempotency_keys (key, scope, request_hash) VALUES ($1, $2, $3)
		ON CONFLICT (key, scope) DO NOTHING`, key, scope, hash)
	if err != nil {
		return rec, false, err
	}
	if tag.RowsAffected() == 1 {
		return rec, true, nil
	}
	err = pool.QueryRow(ctx, `SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1 AND scope = $2`,
		key, scope).Scan(&rec.Hash, &rec.Status, &rec.Body)
	if errors.Is(err, pgx.ErrNoRows) { // aborted in between: let the client retry
		return rec, false, nil
	}
	return rec, false, err
}

func (s *Store) IdemComplete(ctx context.Context, key, scope string, status int, body []byte) error {
	_, err := s.db.Pool.Exec(ctx, `UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE key = $1 AND scope = $2`,
		key, scope, status, body)
	return err
}

func (s *Store) IdemAbort(ctx context.Context, key, scope string) error {
	_, err := s.db.Pool.Exec(ctx, `DELETE FROM idempotency_keys WHERE key = $1 AND scope = $2`, key, scope)
	return err
}

// PurgeIdempotency removes keys older than ttl.
func (s *Store) PurgeIdempotency(ctx context.Context, ttl time.Duration) (int64, error) {
	pool, err := s.pool()
	if err != nil {
		return 0, err
	}
	tag, err := pool.Exec(ctx, `DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(secs => $1)`, ttl.Seconds())
	return tag.RowsAffected(), err
}
