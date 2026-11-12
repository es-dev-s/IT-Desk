// Command api serves the IT-Desk HTTP API.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/config"
	"itdesk/backend/internal/db"
	"itdesk/backend/internal/http/handlers"
	"itdesk/backend/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "itdesk-api:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := config.NewLogger(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	database, err := db.New(cfg, log)
	if err != nil {
		return err
	}
	defer database.Close()
	// Connect in the background: the server answers /healthz immediately and
	// returns 503 + Retry-After for API calls until the database is ready.
	go database.Start(ctx, cfg.MigrateOnStart)

	st := store.New(database, log, cfg.UndoWindow)
	go purgeIdempotencyKeys(ctx, st, log)
	if cfg.AdminEmail != "" {
		go bootstrapAdmin(ctx, cfg, database, st, log)
	}

	api := handlers.New(cfg, log, database, st)
	// Real-time: LISTEN for committed events and fan them out to SSE streams.
	go api.Hub().Run(ctx)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      cfg.RequestTimeout + 10*time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	srv.RegisterOnShutdown(api.Hub().Close) // end open event streams so Shutdown can finish
	errCh := make(chan error, 1)
	go func() {
		log.Info("api listening", "addr", cfg.Addr, "env", cfg.Env, "schema", cfg.DBSchema, "origins", cfg.AllowedOrigins)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down", "grace", cfg.ShutdownTimeout)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "err", err)
		return err
	}
	log.Info("stopped cleanly")
	return nil
}

func purgeIdempotencyKeys(ctx context.Context, st *store.Store, log interface{ Info(string, ...any) }) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c, cancel := context.WithTimeout(ctx, 10*time.Second)
			if n, err := st.PurgeIdempotency(c, 24*time.Hour); err == nil && n > 0 {
				log.Info("purged idempotency keys", "count", n)
			}
			if n, err := st.PurgeNotifications(c, 90*24*time.Hour); err == nil && n > 0 {
				log.Info("purged read notifications", "count", n)
			}
			cancel()
		}
	}
}

// bootstrapAdmin creates the ADMIN_EMAIL account once the database is up, if
// it does not exist yet. It never overwrites an existing account or password,
// and the password must be changed at first sign-in.
func bootstrapAdmin(ctx context.Context, cfg config.Config, database *db.DB, st *store.Store, log *slog.Logger) {
	if msg := auth.ValidateNewPassword(cfg.AdminPassword, cfg.AdminEmail, cfg.AdminName); msg != "" {
		log.Error("ADMIN_PASSWORD rejected by password policy; bootstrap admin not created", "reason", msg)
		return
	}
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for !database.Ready() {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
	hash, err := auth.HashPassword(cfg.AdminPassword)
	if err != nil {
		log.Error("bootstrap admin: hash failed", "err", err)
		return
	}
	c, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	created, err := st.EnsureAdmin(c, cfg.AdminEmail, cfg.AdminName, hash, true)
	switch {
	case err != nil:
		log.Error("bootstrap admin failed", "err", err)
	case created:
		log.Info("bootstrap admin created", "email", cfg.AdminEmail)
	}
}
