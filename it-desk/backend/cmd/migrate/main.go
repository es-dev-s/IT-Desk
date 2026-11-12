// Command migrate applies pending schema migrations.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"itdesk/backend/internal/config"
	"itdesk/backend/internal/db"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		os.Exit(1)
	}
	log := config.NewLogger(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cfg.StatementTimeout = 30 * time.Second
	database, err := db.New(cfg, log)
	if err == nil {
		defer database.Close()
		if err = database.Connect(ctx, 6); err == nil {
			err = db.Migrate(ctx, database.Pool, cfg.DBSchema, log)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		os.Exit(1)
	}
	fmt.Println("Migrations up to date.")
}
