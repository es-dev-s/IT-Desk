package seed

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CleanSummary counts what Clean removed and kept.
type CleanSummary struct {
	Deleted     map[string]int64
	TeamsKept   int
	AdminsKept  int
	UsersPurged int64
}

// cleanOrder lists operational tables child-first so every DELETE succeeds
// without relying on cascades. Teams, the IT staff directory, admin users and floor plans (buildings,
// floors, floor_cells: layout and team zones) are never touched.
var cleanOrder = []string{
	"notifications",
	"it_request_chat_reads",
	"it_request_messages",
	"it_request_events",
	"it_request_items",
	"it_requests",
	"transfer_history",
	"transfer_move_devices",
	"transfer_moves",
	"transfers",
	"exits",
	"devices",
	"zone_changes",
	"members",
	"idempotency_keys",
	"audit_log",
	"sessions",
}

// Clean empties the workspace for a fresh test run, in one transaction:
// every member (and so every seat assignment), device, transfer, exit, IT request, notification,
// audit entry, idempotency key and session is removed, and so is every
// non-admin account. The team catalogue stays (lead names cleared) and admin
// accounts keep their password. Ticket and request numbers restart at 1001.
func Clean(ctx context.Context, pool *pgxpool.Pool) (CleanSummary, error) {
	sum := CleanSummary{Deleted: map[string]int64{}}
	err := pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.Serializable}, func(tx pgx.Tx) error {
		var admins int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active'`).Scan(&admins); err != nil {
			return err
		}
		if admins == 0 {
			return fmt.Errorf("no active admin account: refusing to clean (run make seed-admin first)")
		}
		for _, t := range cleanOrder {
			tag, err := tx.Exec(ctx, `DELETE FROM `+pgx.Identifier{t}.Sanitize())
			if err != nil {
				return fmt.Errorf("clear %s: %w", t, err)
			}
			sum.Deleted[t] = tag.RowsAffected()
		}
		tag, err := tx.Exec(ctx, `DELETE FROM users WHERE role <> 'admin'`)
		if err != nil {
			return fmt.Errorf("remove non-admin accounts: %w", err)
		}
		sum.UsersPurged = tag.RowsAffected()
		if _, err := tx.Exec(ctx, `UPDATE teams SET lead_name = ''`); err != nil {
			return err
		}
		for _, seq := range []string{"ticket_seq", "request_seq"} {
			if _, err := tx.Exec(ctx, `ALTER SEQUENCE `+pgx.Identifier{seq}.Sanitize()+` RESTART WITH 1001`); err != nil {
				return fmt.Errorf("restart %s: %w", seq, err)
			}
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM teams`).Scan(&sum.TeamsKept); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&sum.AdminsKept)
	})
	return sum, err
}

// PruneCredentials rewrites the credentials file so it lists only admin
// accounts (the others no longer exist). Comments, the header and blank lines
// are kept; nothing is printed. A missing file is not an error.
func PruneCredentials(path string, now time.Time) (removed int, err error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		t := strings.TrimSpace(line)
		first := ""
		if f := strings.Fields(t); len(f) > 0 {
			first = f[0]
		}
		if t == "" || strings.HasPrefix(t, "#") || first == "ROLE" || first == "admin" {
			out.WriteString(line + "\n")
			continue
		}
		removed++
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	fmt.Fprintf(&out, "# %s db-clean: only admin accounts remain (team lead / IT demo accounts were removed)\n", now.Format("2006-01-02 15:04"))
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out.Bytes(), 0o600); err != nil {
		return 0, err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return 0, err
	}
	return removed, os.Rename(tmp, path)
}
