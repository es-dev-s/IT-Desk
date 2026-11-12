// Package middleware holds the HTTP cross-cutting concerns: request IDs, panic
// recovery, structured access logs, CORS, body limits and request deadlines.
package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"time"
)

type ctxKey int

const requestIDKey ctxKey = 1

var validID = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)

func RequestIDFrom(ctx context.Context) string {
	v, _ := ctx.Value(requestIDKey).(string)
	return v
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// RequestID accepts a well-formed X-Request-Id from the client (so frontend
// and backend logs correlate) or mints one, and echoes it on the response.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !validID.MatchString(id) {
			id = newID()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

// StatusRecorder captures the status code and size for logging.
type StatusRecorder struct {
	http.ResponseWriter
	Status int
	Bytes  int
}

func (s *StatusRecorder) WriteHeader(code int) {
	if s.Status == 0 {
		s.Status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *StatusRecorder) Write(b []byte) (int, error) {
	if s.Status == 0 {
		s.Status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.Bytes += n
	return n, err
}

func (s *StatusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// WriteError writes the standard JSON error envelope.
func WriteError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
		"code": code, "message": message, "requestId": RequestIDFrom(r.Context()),
	}})
}

// Recover turns a panic into a 500 with the request ID instead of a dropped
// connection, and logs the stack.
func Recover(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rec := &StatusRecorder{ResponseWriter: w}
			defer func() {
				if v := recover(); v != nil {
					if v == http.ErrAbortHandler {
						panic(v)
					}
					log.Error("panic", "request_id", RequestIDFrom(r.Context()), "panic", v, "stack", string(debug.Stack()))
					if rec.Status == 0 {
						WriteError(w, r, http.StatusInternalServerError, "internal", "Something went wrong on our side.")
					}
				}
			}()
			next.ServeHTTP(rec, r)
		})
	}
}

func Logger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &StatusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			if rec.Status == 0 {
				rec.Status = http.StatusOK
			}
			level := slog.LevelInfo
			switch {
			case rec.Status >= 500:
				level = slog.LevelError
			case rec.Status >= 400:
				level = slog.LevelWarn
			case r.URL.Path == "/healthz" || r.URL.Path == "/readyz" || r.Method == http.MethodOptions:
				level = slog.LevelDebug
			}
			log.Log(r.Context(), level, "http",
				"method", r.Method, "path", r.URL.Path, "status", rec.Status, "bytes", rec.Bytes,
				"duration_ms", time.Since(start).Milliseconds(), "request_id", RequestIDFrom(r.Context()))
		})
	}
}

// CORS allows the configured browser origins (the Next.js dev server).
func CORS(origins []string) func(http.Handler) http.Handler {
	allowHeaders := "Content-Type, Idempotency-Key, X-Request-Id, X-CSRF-Token, If-Match"
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			h := w.Header()
			h.Add("Vary", "Origin")
			if origin != "" && (slices.Contains(origins, origin) || slices.Contains(origins, "*")) {
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Credentials", "true")
				h.Set("Access-Control-Expose-Headers", "X-Request-Id, Idempotent-Replayed, Retry-After")
				if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
					h.Add("Vary", "Access-Control-Request-Method")
					h.Add("Vary", "Access-Control-Request-Headers")
					h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
					h.Set("Access-Control-Allow-Headers", allowHeaders)
					h.Set("Access-Control-Max-Age", "600")
					w.WriteHeader(http.StatusNoContent)
					return
				}
			} else if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// OriginGuard is the first CSRF layer: a state-changing request that carries
// an Origin (every modern browser sends one on cross-origin and on non-GET
// requests) must come from an allowed origin, and requests the browser marks
// as cross-site are refused. Non-browser clients (no Origin) pass through to
// the per-session CSRF token check.
func OriginGuard(origins []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet, http.MethodHead, http.MethodOptions:
				next.ServeHTTP(w, r)
				return
			}
			origin := r.Header.Get("Origin")
			allowed := origin != "" && (slices.Contains(origins, origin) || slices.Contains(origins, "*"))
			if (origin != "" && !allowed) || (origin == "" && r.Header.Get("Sec-Fetch-Site") == "cross-site") {
				WriteError(w, r, http.StatusForbidden, "origin_rejected", "This request came from a site that isn't allowed.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// SecureHeaders sets conservative response headers for a JSON API.
func SecureHeaders(hsts bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
			h.Set("Cross-Origin-Resource-Policy", "same-site")
			if hsts {
				h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// BodyLimit caps request bodies so a bad client can't exhaust memory.
func BodyLimit(n int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > n {
				WriteError(w, r, http.StatusRequestEntityTooLarge, "body_too_large", "Request body is too large.")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, n)
			next.ServeHTTP(w, r)
		})
	}
}

// Timeout puts a deadline on the request context; DB calls inherit it.
// Exempt paths (long-lived streams) manage their own deadlines.
func Timeout(d time.Duration, exempt ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if slices.Contains(exempt, r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// Chain applies middleware so the first listed runs outermost.
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

func RetryAfter(w http.ResponseWriter, seconds int) {
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
}

func IsJSON(r *http.Request) bool {
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	return ct == "" || strings.HasPrefix(ct, "application/json")
}
