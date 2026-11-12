package middleware

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestRequestID(t *testing.T) {
	h := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, RequestIDFrom(r.Context()))
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Request-Id", "client-abc-123")
	h.ServeHTTP(rec, req)
	if rec.Body.String() != "client-abc-123" || rec.Header().Get("X-Request-Id") != "client-abc-123" {
		t.Errorf("client id not propagated: %q", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Request-Id", "bad id with spaces\n")
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); len(got) != 24 {
		t.Errorf("expected generated id, got %q", got)
	}
}

func TestRecover(t *testing.T) {
	h := Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }), RequestID, Recover(quiet))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 500 || !strings.Contains(rec.Body.String(), `"code":"internal"`) || !strings.Contains(rec.Body.String(), "requestId") {
		t.Errorf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestCORS(t *testing.T) {
	h := CORS([]string{"http://localhost:3000"})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	pre := httptest.NewRequest("OPTIONS", "/api/v1/transfers", nil)
	pre.Header.Set("Origin", "http://localhost:3000")
	pre.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, pre)
	if rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" ||
		!strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Idempotency-Key") {
		t.Errorf("preflight failed: %d %v", rec.Code, rec.Header())
	}
	evil := httptest.NewRequest("OPTIONS", "/", nil)
	evil.Header.Set("Origin", "http://evil.test")
	evil.Header.Set("Access-Control-Request-Method", "POST")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, evil)
	if rec.Code != 403 || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("foreign origin allowed: %d", rec.Code)
	}
}

func TestBodyLimitAndTimeout(t *testing.T) {
	h := BodyLimit(10)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			w.WriteHeader(413)
		}
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/", strings.NewReader(strings.Repeat("x", 100))))
	if rec.Code != 413 {
		t.Errorf("body limit not enforced: %d", rec.Code)
	}
	var deadline time.Time
	Timeout(time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadline, _ = r.Context().Deadline()
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	if time.Until(deadline) <= 0 || time.Until(deadline) > time.Second {
		t.Errorf("deadline not set: %v", deadline)
	}
}
