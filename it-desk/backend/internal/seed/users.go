package seed

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"itdesk/backend/internal/auth"
)

// Account is one demo sign-in account.
type Account struct {
	ID, Email, Name, Title, Role, TeamID string
}

// Credential is a freshly generated password for a seeded account. It is only
// ever written to the gitignored credentials file, never logged.
type Credential struct {
	Account
	Password string
}

// Accounts derives the demo accounts from the dataset: one admin, the
// dataset's lead (Pawan) plus a lead for every other team, and two IT staff.
func Accounts(d Dataset) []Account {
	leadID := d.Lead.ID
	if leadID == "" {
		leadID = DefaultLeadID
	}
	out := []Account{{ID: "usr_admin", Email: "admin@itdesk.io", Name: "Anita Gurung", Title: "IT-Desk Administrator", Role: "admin"}}
	for _, t := range d.Teams {
		if t.ID == d.CurrentTeamID {
			title := d.Lead.Title
			if title == "" {
				title = "Team Lead"
			}
			out = append(out, Account{ID: leadID, Email: strings.ToLower(d.Lead.Email), Name: d.Lead.Name, Title: title, Role: "team_lead", TeamID: t.ID})
			continue
		}
		if strings.TrimSpace(t.LeadName) == "" {
			continue
		}
		out = append(out, Account{ID: "lead_" + t.ID, Email: emailFor(t.LeadName), Name: t.LeadName,
			Title: "Team Lead · " + t.Name, Role: "team_lead", TeamID: t.ID})
	}
	return append(out,
		Account{ID: "usr_it_bikash", Email: "bikash.thapa@itdesk.io", Name: "Bikash Thapa", Title: "IT Support Engineer", Role: "it"},
		Account{ID: "usr_it_grace", Email: "grace.lin@itdesk.io", Name: "Grace Lin", Title: "IT Operations Specialist", Role: "it"},
	)
}

func emailFor(name string) string {
	parts := strings.Fields(strings.ToLower(name))
	var b strings.Builder
	for i, p := range parts {
		if i > 0 {
			b.WriteByte('.')
		}
		for _, r := range p {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				b.WriteRune(r)
			}
		}
	}
	return b.String() + "@itdesk.io"
}

// SeedUsers creates the demo accounts with random passwords. Existing
// accounts that already have a password are left alone; accounts without one
// (e.g. migrated from the pre-auth schema) get one. Only the passwords set by
// this call are returned.
func SeedUsers(ctx context.Context, pool *pgxpool.Pool) ([]Credential, error) {
	data, err := Load()
	if err != nil {
		return nil, err
	}
	var creds []Credential
	err = pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.Serializable}, func(tx pgx.Tx) error {
		creds = creds[:0]
		var teams int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM teams`).Scan(&teams); err != nil {
			return err
		}
		if teams == 0 {
			return fmt.Errorf("no teams yet: seed the workspace first")
		}
		prefs := `{"notifications":{"scheduled":true,"moved":true,"incoming":true,"digest":false}}`
		for _, a := range Accounts(data) {
			var team any
			if a.TeamID != "" {
				var ok bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM teams WHERE id=$1)`, a.TeamID).Scan(&ok); err != nil {
					return err
				}
				if !ok {
					continue
				}
				team = a.TeamID
			}
			var hasPassword, exists bool
			err := tx.QueryRow(ctx, `SELECT true, password_hash IS NOT NULL FROM users WHERE email=$1 OR id=$2 LIMIT 1`, a.Email, a.ID).
				Scan(&exists, &hasPassword)
			if err != nil && err != pgx.ErrNoRows {
				return err
			}
			if exists && hasPassword {
				continue
			}
			// SEED_PASSWORD (local dev only) gives every demo account the same
			// fixed password instead of a random one. Refused in production.
			pw := os.Getenv("SEED_PASSWORD")
			if pw != "" && strings.EqualFold(os.Getenv("APP_ENV"), "production") {
				return fmt.Errorf("SEED_PASSWORD is not allowed when APP_ENV=production")
			}
			if pw == "" {
				if pw, err = auth.GeneratePassword(16); err != nil {
					return err
				}
			}
			hash, err := auth.HashPassword(pw)
			if err != nil {
				return err
			}
			if exists {
				if _, err := tx.Exec(ctx, `UPDATE users SET password_hash=$3, must_change_password=false, password_changed_at=now(),
					updated_at=now(), version=version+1 WHERE email=$1 OR id=$2`, a.Email, a.ID, hash); err != nil {
					return fmt.Errorf("user %s: %w", a.Email, err)
				}
			} else if _, err := tx.Exec(ctx, `INSERT INTO users (id, email, name, title, role, team_id, password_hash,
				must_change_password, password_changed_at, preferences, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,false,now(),$8::jsonb,'seed')`,
				a.ID, a.Email, a.Name, a.Title, a.Role, team, hash, prefs); err != nil {
				return fmt.Errorf("user %s: %w", a.Email, err)
			}
			if a.TeamID != "" {
				if _, err := tx.Exec(ctx, `UPDATE teams SET lead_name=$2 WHERE id=$1`, a.TeamID, a.Name); err != nil {
					return err
				}
			}
			creds = append(creds, Credential{Account: a, Password: pw})
		}
		if len(creds) > 0 {
			_, err := tx.Exec(ctx, `INSERT INTO audit_log (actor, action, entity, entity_id, data) VALUES ('seed','seed.users','user','',$1)`,
				map[string]any{"accounts": len(creds)})
			return err
		}
		return nil
	})
	return creds, err
}

// WriteCredentials writes (or appends) credentials to a 0600 file. The file
// must be gitignored; it is the only place seeded passwords exist.
func WriteCredentials(path string, creds []Credential, appendMode bool, now time.Time) error {
	if len(creds) == 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	if appendMode {
		flags = os.O_CREATE | os.O_WRONLY | os.O_APPEND
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_ = f.Chmod(0o600)
	var b strings.Builder
	fmt.Fprintf(&b, "# IT-Desk demo sign-in accounts — generated %s\n", now.Format(time.RFC3339))
	b.WriteString("# LOCAL DEV ONLY. Gitignored; do not commit or share. Re-seeding replaces these.\n")
	fmt.Fprintf(&b, "%-10s  %-28s  %-34s  %-10s  %s\n", "ROLE", "NAME", "EMAIL", "TEAM", "PASSWORD")
	for _, c := range creds {
		team := c.TeamID
		if team == "" {
			team = "(all)"
		}
		fmt.Fprintf(&b, "%-10s  %-28s  %-34s  %-10s  %s\n", c.Role, c.Name, c.Email, team, c.Password)
	}
	b.WriteString("\n")
	_, err = f.WriteString(b.String())
	return err
}
