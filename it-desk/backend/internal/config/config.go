// Package config loads runtime settings from the environment (and an optional
// .env file). Secrets such as DATABASE_URL are never logged.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Env              string
	Addr             string
	DatabaseURL      string
	DBSchema         string
	DBMaxConns       int32
	DBMinConns       int32
	DBConnectRetries int // 0 = retry forever (API); the seed/migrate CLIs use a bounded number
	StatementTimeout time.Duration
	RequestTimeout   time.Duration
	ShutdownTimeout  time.Duration
	AllowedOrigins   []string
	// Auth
	SessionTTL         time.Duration  // absolute lifetime of a session
	SessionIdleTimeout time.Duration  // sign out after this long without activity
	CookieSecure       bool           // Secure cookie (+ __Host- prefix); on in production
	TrustProxy         bool           // honour X-Forwarded-For for client IPs (only behind a trusted proxy)
	TrustedProxies     []netip.Prefix // peers whose X-Forwarded-For is honoured (default: loopback, i.e. the web server)
	AdminEmail         string         // optional bootstrap admin (created once if missing)
	AdminPassword      string
	AdminName          string
	UndoWindow         time.Duration
	MigrateOnStart     bool
	LogLevel           slog.Level
	LogFormat          string
}

var schemaName = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

// LoadDotenv loads the first .env found in the working directory or its parents
// (so `go test ./...` inside a package still finds backend/.env). Real
// environment variables always win.
func LoadDotenv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	for i := 0; i < 4; i++ {
		p := filepath.Join(dir, ".env")
		if _, err := os.Stat(p); err == nil {
			_ = godotenv.Load(p)
			return
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return
		}
		dir = parent
	}
}

func Load() (Config, error) {
	LoadDotenv()
	c := Config{
		Env:              str("APP_ENV", "development"),
		Addr:             str("HTTP_ADDR", ":8080"),
		DatabaseURL:      strings.TrimSpace(os.Getenv("DATABASE_URL")),
		DBSchema:         str("DB_SCHEMA", "itdesk"),
		DBMaxConns:       int32(num("DB_MAX_CONNS", 10)),
		DBMinConns:       int32(num("DB_MIN_CONNS", 1)),
		DBConnectRetries: num("DB_CONNECT_RETRIES", 0),
		StatementTimeout: dur("DB_STATEMENT_TIMEOUT", 5*time.Second),
		RequestTimeout:   dur("HTTP_REQUEST_TIMEOUT", 10*time.Second),
		ShutdownTimeout:  dur("HTTP_SHUTDOWN_TIMEOUT", 15*time.Second),
		// Default local origins follow WEB_PORT, so running the web app on another port still works.
		AllowedOrigins:     list("ALLOWED_ORIGINS", str("CORS_ALLOWED_ORIGINS", "http://localhost:"+str("WEB_PORT", "3000")+",http://127.0.0.1:"+str("WEB_PORT", "3000"))),
		SessionTTL:         dur("SESSION_TTL", 7*24*time.Hour),
		SessionIdleTimeout: dur("SESSION_IDLE_TIMEOUT", 12*time.Hour),
		TrustProxy:         boolean("TRUST_PROXY", false),
		AdminEmail:         strings.TrimSpace(os.Getenv("ADMIN_EMAIL")),
		AdminPassword:      os.Getenv("ADMIN_PASSWORD"),
		AdminName:          str("ADMIN_NAME", "IT-Desk Admin"),
		UndoWindow:         dur("UNDO_WINDOW", 10*time.Minute),
		MigrateOnStart:     boolean("MIGRATE_ON_START", true),
		LogFormat:          str("LOG_FORMAT", "text"),
	}
	c.CookieSecure = boolean("COOKIE_SECURE", c.Production())
	// LAN_ORIGINS=auto (default outside production) also allows http://<this machine's LAN IP>:WEB_PORT,
	// so the app can be opened from another PC on the network.
	lanDefault := "auto"
	if c.Production() {
		lanDefault = "off"
	}
	if strings.EqualFold(str("LAN_ORIGINS", lanDefault), "auto") {
		for _, o := range LANOrigins(str("WEB_PORT", "3000")) {
			if !slices.Contains(c.AllowedOrigins, o) {
				c.AllowedOrigins = append(c.AllowedOrigins, o)
			}
		}
	}
	proxies, err := parsePrefixes(list("TRUSTED_PROXIES", "127.0.0.1/32,::1/128"))
	if err != nil {
		return c, err
	}
	c.TrustedProxies = proxies
	switch strings.ToLower(str("LOG_LEVEL", "info")) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "warn":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		c.LogLevel = slog.LevelInfo
	}

	var errs []error
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required (copy backend/.env.example to backend/.env)"))
	}
	if !schemaName.MatchString(c.DBSchema) {
		errs = append(errs, fmt.Errorf("DB_SCHEMA %q must be a lowercase identifier", c.DBSchema))
	}
	if c.DBMaxConns < 1 || c.DBMinConns < 0 || c.DBMinConns > c.DBMaxConns {
		errs = append(errs, errors.New("DB_MAX_CONNS/DB_MIN_CONNS are out of range"))
	}
	if (c.AdminEmail == "") != (c.AdminPassword == "") {
		errs = append(errs, errors.New("set both ADMIN_EMAIL and ADMIN_PASSWORD (or neither)"))
	}
	if c.Production() && !c.CookieSecure {
		errs = append(errs, errors.New("COOKIE_SECURE must be true in production"))
	}
	if c.Production() && slices.Contains(c.AllowedOrigins, "*") {
		errs = append(errs, errors.New("CORS_ALLOWED_ORIGINS cannot be * when cookies are used"))
	}
	return c, errors.Join(errs...)
}

func (c Config) Production() bool { return strings.EqualFold(c.Env, "production") }

func NewLogger(c Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: c.LogLevel}
	if c.LogFormat == "json" {
		return slog.New(slog.NewJSONHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, opts))
}

func str(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func num(key string, def int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key))); err == nil {
		return v
	}
	return def
}

func dur(key string, def time.Duration) time.Duration {
	if v, err := time.ParseDuration(strings.TrimSpace(os.Getenv(key))); err == nil && v > 0 {
		return v
	}
	return def
}

func boolean(key string, def bool) bool {
	if v, err := strconv.ParseBool(strings.TrimSpace(os.Getenv(key))); err == nil {
		return v
	}
	return def
}

func list(key, def string) []string {
	var out []string
	for _, p := range strings.Split(str(key, def), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
