package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"time"

	"itdesk/backend/internal/domain"
	mw "itdesk/backend/internal/http/middleware"
)

type captureWriter struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (c *captureWriter) WriteHeader(code int) {
	if c.status == 0 {
		c.status = code
	}
	c.ResponseWriter.WriteHeader(code)
}

func (c *captureWriter) Write(b []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	c.buf.Write(b)
	return c.ResponseWriter.Write(b)
}

// idempotent makes a mutation safe to retry: with an Idempotency-Key header
// the first response (<500) is stored and replayed for identical retries.
func (s *Server) idempotent(userID string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			next(w, r)
			return
		}
		if len(key) > 128 {
			fail(w, r, s.log, domain.BadRequest("Idempotency-Key is too long (max 128)."))
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			fail(w, r, s.log, domain.BadRequest("Could not read request body."))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		scope := r.Method + " " + r.URL.Path + " user=" + userID
		sum := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), body...))
		hash := hex.EncodeToString(sum[:])

		rec, started, err := s.store.IdemBegin(r.Context(), key, scope, hash)
		if err != nil {
			fail(w, r, s.log, err)
			return
		}
		if !started {
			switch {
			case rec.Hash != "" && rec.Hash != hash:
				fail(w, r, s.log, &domain.Error{Status: http.StatusUnprocessableEntity, Code: "idempotency_key_reused",
					Message: "This Idempotency-Key was already used for a different request."})
			case rec.Status == nil:
				mw.RetryAfter(w, 1)
				fail(w, r, s.log, domain.Conflict("request_in_progress", "The same request is still being processed."))
			default:
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("Idempotent-Replayed", "true")
				w.WriteHeader(*rec.Status)
				_, _ = w.Write(rec.Body)
			}
			return
		}

		cw := &captureWriter{ResponseWriter: w}
		completed := false
		defer func() {
			// Persist with a fresh context: the request may already be cancelled.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 3*time.Second)
			defer cancel()
			if completed && cw.status > 0 && cw.status < 500 {
				if err := s.store.IdemComplete(ctx, key, scope, cw.status, cw.buf.Bytes()); err != nil {
					s.log.Warn("idempotency store failed", "err", err)
				}
				return
			}
			if err := s.store.IdemAbort(ctx, key, scope); err != nil {
				s.log.Warn("idempotency abort failed", "err", err)
			}
		}()
		next(cw, r)
		completed = true
	}
}
