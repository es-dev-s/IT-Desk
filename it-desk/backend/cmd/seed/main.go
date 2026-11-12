// Command seed loads demo data and sign-in accounts into PostgreSQL.
//
//	go run ./cmd/seed                 # migrate + seed if empty; give password-less demo accounts a password
//	go run ./cmd/seed --reset         # drop the itdesk schema, re-migrate, re-seed (new passwords)
//	go run ./cmd/seed --clean --yes   # empty the workspace, keep teams + admin accounts
//	go run ./cmd/seed --create-admin --email you@company.com --name "Your Name"
//
// Generated passwords are written ONLY to .seed-credentials.txt (0600,
// gitignored) — never printed.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/config"
	"itdesk/backend/internal/db"
	"itdesk/backend/internal/seed"
	"itdesk/backend/internal/store"
)

type options struct {
	reset, createAdmin bool
	clean, yes         bool
	email, name, creds string
}

func main() {
	var o options
	flag.BoolVar(&o.reset, "reset", false, "drop and recreate the app schema before seeding (only ever touches DB_SCHEMA)")
	flag.BoolVar(&o.createAdmin, "create-admin", false, "create an admin account (password from ADMIN_PASSWORD, else generated)")
	flag.BoolVar(&o.clean, "clean", false, "delete all workspace data and non-admin accounts; keep teams and admins (needs --yes)")
	flag.BoolVar(&o.yes, "yes", false, "confirm a destructive --clean")
	flag.StringVar(&o.email, "email", "", "admin email for --create-admin (default ADMIN_EMAIL)")
	flag.StringVar(&o.name, "name", "", "admin name for --create-admin (default ADMIN_NAME)")
	flag.StringVar(&o.creds, "credentials-file", ".seed-credentials.txt", "where generated passwords are written (keep it gitignored)")
	flag.Parse()
	if err := run(o); err != nil {
		fmt.Fprintln(os.Stderr, "seed:", err)
		os.Exit(1)
	}
}

func run(o options) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := config.NewLogger(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	cfg.StatementTimeout = 30 * time.Second
	database, err := db.New(cfg, log)
	if err != nil {
		return err
	}
	defer database.Close()
	if err := database.Connect(ctx, 6); err != nil {
		return err
	}
	if o.clean {
		if !o.yes {
			return fmt.Errorf("--clean deletes every member, transfer, request and non-admin account; re-run with --clean --yes")
		}
		if err := db.Migrate(ctx, database.Pool, cfg.DBSchema, log); err != nil {
			return err
		}
		sum, err := seed.Clean(ctx, database.Pool)
		if err != nil {
			return err
		}
		removed, err := seed.PruneCredentials(o.creds, time.Now())
		if err != nil {
			return fmt.Errorf("prune credentials file: %w", err)
		}
		fmt.Printf("Cleaned: %d members, %d devices, %d transfers, %d exits, %d IT requests, %d notifications, %d sessions, %d audit entries, %d non-admin accounts.\n",
			sum.Deleted["members"], sum.Deleted["devices"], sum.Deleted["transfers"], sum.Deleted["exits"], sum.Deleted["it_requests"],
			sum.Deleted["notifications"], sum.Deleted["sessions"], sum.Deleted["audit_log"], sum.UsersPurged)
		fmt.Printf("Kept %d teams and %d admin account(s). Ticket and request numbers restart at 1001. Credentials file: %d non-admin lines removed.\n",
			sum.TeamsKept, sum.AdminsKept, removed)
		return nil
	}
	if o.createAdmin {
		if err := db.Migrate(ctx, database.Pool, cfg.DBSchema, log); err != nil {
			return err
		}
		database.MarkReady()
		return createAdmin(ctx, cfg, database, o)
	}
	if o.reset {
		log.Warn("resetting schema", "schema", cfg.DBSchema)
		if err := db.DropSchema(ctx, database.Pool, cfg.DBSchema); err != nil {
			return err
		}
	}
	if err := db.Migrate(ctx, database.Pool, cfg.DBSchema, log); err != nil {
		return err
	}
	sum, err := seed.Run(ctx, database.Pool, log, time.Now().UTC())
	if err != nil {
		return err
	}
	if sum.Skipped {
		fmt.Printf("Team catalogue up to date (%d teams). Workspace data already seeded (use --reset to start over).\n", sum.Teams)
		if sum.LegacyTeams > 0 {
			fmt.Printf("%d older demo teams are still in the database; --reset replaces them with the catalogue.\n", sum.LegacyTeams)
		}
	} else {
		fmt.Printf("Seeded %d teams, %d members, %d devices, %d transfers, %d exits. Next ticket %s.\n",
			sum.Teams, sum.Members, sum.Devices, sum.Transfers, sum.Exits, sum.NextTicket)
	}
	creds, err := seed.SeedUsers(ctx, database.Pool)
	if err != nil {
		return err
	}
	if n, err := seed.SeedRequests(ctx, database.Pool, time.Now().UTC()); err != nil {
		return fmt.Errorf("seed IT requests: %w", err)
	} else if n > 0 {
		fmt.Printf("Seeded %d IT requests.\n", n)
	}
	if len(creds) == 0 {
		fmt.Println("Sign-in accounts already have passwords — nothing changed.")
		return nil
	}
	// A reset invalidates every old password, so start the file over.
	if err := seed.WriteCredentials(o.creds, creds, !o.reset && sum.Skipped, time.Now()); err != nil {
		return fmt.Errorf("write credentials file: %w", err)
	}
	roles := map[string]int{}
	for _, c := range creds {
		roles[c.Role]++
	}
	fmt.Printf("Created/updated %d sign-in accounts (admin %d, team leads %d, IT %d). Passwords written to %s (0600, gitignored).\n",
		len(creds), roles["admin"], roles["team_lead"], roles["it"], o.creds)
	return nil
}

func createAdmin(ctx context.Context, cfg config.Config, database *db.DB, o options) error {
	email := strings.TrimSpace(o.email)
	if email == "" {
		email = cfg.AdminEmail
	}
	name := strings.TrimSpace(o.name)
	if name == "" {
		name = cfg.AdminName
	}
	if email == "" || !strings.Contains(email, "@") {
		return fmt.Errorf("--create-admin needs --email (or ADMIN_EMAIL)")
	}
	pw, generated := cfg.AdminPassword, false
	if pw == "" {
		var err error
		if pw, err = auth.GeneratePassword(16); err != nil {
			return err
		}
		generated = true
	} else if msg := auth.ValidateNewPassword(pw, email, name); msg != "" {
		return fmt.Errorf("ADMIN_PASSWORD rejected: %s", msg)
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	st := store.New(database, config.NewLogger(cfg), cfg.UndoWindow)
	created, err := st.EnsureAdmin(ctx, email, name, hash, true)
	if err != nil {
		return err
	}
	if !created {
		fmt.Println("An account with that email already exists — nothing changed.")
		return nil
	}
	if generated {
		cred := seed.Credential{Account: seed.Account{Email: strings.ToLower(email), Name: name, Role: "admin"}, Password: pw}
		if err := seed.WriteCredentials(o.creds, []seed.Credential{cred}, true, time.Now()); err != nil {
			return fmt.Errorf("write credentials file: %w", err)
		}
		fmt.Printf("Admin created. One-time password appended to %s; it must be changed at first sign-in.\n", o.creds)
	} else {
		fmt.Println("Admin created with ADMIN_PASSWORD; it must be changed at first sign-in.")
	}
	return nil
}
