package handlers

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"itdesk/backend/internal/config"
	"itdesk/backend/internal/db"
	"itdesk/backend/internal/store"
)

// A server whose database never becomes ready: everything except /healthz
// must degrade to a clean 503 with Retry-After.
func notReadyServer(t *testing.T) *Server {
	t.Helper()
	cfg := config.Config{DatabaseURL: "postgres://u:p@127.0.0.1:1/x", DBSchema: "itdesk", DBMaxConns: 1,
		AllowedOrigins: []string{"http://localhost:3000"}, RequestTimeout: 1e9}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	d, err := db.New(cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	return New(cfg, log, d, store.New(d, log, 0))
}

func TestHealthAndReadinessWithoutDB(t *testing.T) {
	h := notReadyServer(t).Handler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != 200 {
		t.Errorf("healthz: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != 503 || rec.Header().Get("Retry-After") == "" {
		t.Errorf("readyz: %d %v", rec.Code, rec.Header())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/workspace", nil))
	var body struct {
		Error struct{ Code, RequestID string }
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 503 || body.Error.Code != "database_unavailable" || body.Error.RequestID == "" {
		t.Errorf("workspace: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/nope", nil))
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "route_not_found") {
		t.Errorf("unknown route: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PATCH", "/api/v1/workspace", nil))
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "route_not_found") {
		t.Errorf("wrong method should get the JSON 404 envelope: %d", rec.Code)
	}
}

func TestDecode(t *testing.T) {
	var v struct {
		A int `json:"a"`
	}
	for body, wantErr := range map[string]bool{`{"a":1}`: false, `{"a":1,"b":2}`: true, `{"a":`: true, ``: true, `{"a":1}{"a":2}`: true} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if err := decode(r, &v); (err != nil) != wantErr {
			t.Errorf("%q: err=%v", body, err)
		}
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "text/plain")
	if err := decode(r, &v); err == nil {
		t.Error("non-JSON content type accepted")
	}
}
