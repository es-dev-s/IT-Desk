package db

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"itdesk/backend/migrations"
)

const migrationLock = 7_301_626_431 // arbitrary app-wide advisory lock id

// Migrate applies pending embedded migrations, each in its own transaction,
// serialised across processes with a Postgres advisory lock.
func Migrate(ctx context.Context, pool *pgxpool.Pool, schema string, log *slog.Logger) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		return fmt.Errorf("advisory lock: %w", err)
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", migrationLock) }()

	ident := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA IF NOT EXISTS "+ident); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	if _, err := conn.Exec(ctx, "SET search_path TO "+ident); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]bool{}
	rows, err := conn.Query(ctx, "SELECT version FROM schema_migrations")
	if err != nil {
		return err
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()

	files, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, f := range files {
		if applied[f] {
			continue
		}
		body, err := fs.ReadFile(migrations.FS, f)
		if err != nil {
			return err
		}
		err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(body)); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", f)
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %s: %w", f, err)
		}
		log.Info("migration applied", "version", f)
	}
	return nil
}

// DropSchema removes the app schema. It refuses unless the schema carries our
// schema_migrations table, so it can never drop something we did not create.
func DropSchema(ctx context.Context, pool *pgxpool.Pool, schema string) error {
	var ours bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations')`, schema).Scan(&ours)
	if err != nil {
		return err
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)`, schema).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if !ours {
		return fmt.Errorf("refusing to drop schema %q: it was not created by IT-Desk", schema)
	}
	_, err = pool.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
	return err
}
