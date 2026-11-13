package handlers

// HTTP-level auth/RBAC tests against a real PostgreSQL (skipped without
// DATABASE_URL). Each test gets a throwaway schema.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/config"
	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/store"
)

const origin = "http://localhost:3000"

var passwords = map[string]string{
	"lead@example.com":  "Correct-Horse-Battery-1",
	"lead3@example.com": "Another-Lead-Secret-2",
	"admin@example.com": "Admin-Strong-Phrase-3",
	"it@example.com":    "Tech-Desk-Password-4",
}

func liveServer(t *testing.T) (*httptest.Server, *Server) {
	t.Helper()
	config.LoadDotenv()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DBSchema = fmt.Sprintf("itdesk_htest_%d_%d", os.Getpid(), time.Now().UnixNano()%1e6)
	cfg.DBMaxConns = 6
	cfg.AllowedOrigins = []string{origin}
	cfg.CookieSecure = false
	cfg.SessionTTL, cfg.SessionIdleTimeout = time.Hour, time.Hour
	cfg.UndoWindow = 10 * time.Minute
	cfg.FloorLayoutLocked = false
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	d, err := db.New(cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := d.Connect(ctx, 3); err != nil {
		t.Skipf("database unreachable: %v", err)
	}
	if err := db.Migrate(ctx, d.Pool, cfg.DBSchema, log); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = db.DropSchema(context.Background(), d.Pool, cfg.DBSchema)
		d.Close()
	})
	d.MarkReady()
	hash := func(email string) string {
		h, err := auth.HashPassword(passwords[email])
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO teams (id, name, code, lead_name, location, sort_order) VALUES
			('t1','Platform','PLT','Lead One','Floor 1',0), ('t2','Payments','PAY','Lead Two','Floor 2',1),
			('t3','Rapid Response','RR','','Floor 3',2)`); err != nil {
		t.Fatal(err)
	}
	seedTestFloor(t, ctx, d)
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO members (id, name, email, role, sub_group, team_id, seat_id, status, joined_at, hue) VALUES
			('m1','Ann Lee','ann@example.com','Eng','Core','t1','A-1','active','2024-01-01',10),
			('m2','Bo Chen','bo@example.com','Eng','Core','t1','A-2','active','2024-01-01',20),
			('m4','Di Eze','di@example.com','Eng','Core','t2','B-4','active','2024-01-01',40)`, nil},
		{`INSERT INTO users (id, email, name, title, role, team_id, password_hash, must_change_password) VALUES
			('lead_test','lead@example.com','Lead One','Lead','team_lead','t1',$1,false),
			('lead_three','lead3@example.com','Lead Three','Lead','team_lead','t1',$2,false),
			('usr_admin','admin@example.com','Ada Admin','Admin','admin',NULL,$3,false),
			('usr_it','it@example.com','Ivan Tech','IT','it',NULL,$4,false)`,
			[]any{hash("lead@example.com"), hash("lead3@example.com"), hash("admin@example.com"), hash("it@example.com")}},
	} {
		if _, err := d.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	srv := New(cfg, log, d, store.New(d, log, cfg.UndoWindow))
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, srv
}

type client struct {
	t    *testing.T
	base string
	http *http.Client
	csrf string
}

func newClient(t *testing.T, ts *httptest.Server) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: ts.URL, http: &http.Client{Jar: jar}}
}

type resp struct {
	Status int
	Header http.Header
	Data   json.RawMessage `json:"data"`
	Error  struct {
		Code    string            `json:"code"`
		Message string            `json:"message"`
		Fields  map[string]string `json:"fields"`
	} `json:"error"`
}

func (c *client) do(method, path string, body any) resp {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
		req.Header.Set("Origin", origin)
		if c.csrf != "" {
			req.Header.Set("X-CSRF-Token", c.csrf)
		}
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	var r resp
	_ = json.NewDecoder(res.Body).Decode(&r)
	r.Status, r.Header = res.StatusCode, res.Header
	return r
}

func (c *client) login(email, password string) resp {
	c.t.Helper()
	r := c.do("POST", "/api/v1/auth/login", map[string]string{"email": email, "password": password})
	if r.Status == 200 {
		var v struct {
			CSRFToken string `json:"csrfToken"`
		}
		_ = json.Unmarshal(r.Data, &v)
		c.csrf = v.CSRFToken
	}
	return r
}

func (c *client) mustLogin(email string) *client {
	c.t.Helper()
	if r := c.login(email, passwords[email]); r.Status != 200 {
		c.t.Fatalf("login %s: %d %s", email, r.Status, r.Error.Code)
	}
	return c
}

func TestPolicyMatrixOverHTTP(t *testing.T) {
	ts, _ := liveServer(t)
	clients := map[string]*client{
		"admin":     newClient(t, ts).mustLogin("admin@example.com"),
		"team_lead": newClient(t, ts).mustLogin("lead@example.com"),
		"it":        newClient(t, ts).mustLogin("it@example.com"),
	}
	type call struct {
		method, path string
		body         any
		allowed      []string
	}
	all := []string{"admin", "team_lead", "it"}
	calls := []call{
		{"GET", "/api/v1/auth/me", nil, all},
		{"GET", "/api/v1/workspace", nil, all},
		{"GET", "/api/v1/members", nil, all},
		{"GET", "/api/v1/transfers", nil, all},
		{"GET", "/api/v1/teams", nil, all},
		{"GET", "/api/v1/floors", nil, all},
		{"GET", "/api/v1/floors/flr_t", nil, all},
		{"POST", "/api/v1/floors", map[string]string{}, []string{"admin"}},
		{"PATCH", "/api/v1/floors/flr_t", map[string]string{}, []string{"admin"}},
		{"GET", "/api/v1/floors/flr_t/draft", nil, []string{"admin"}},
		{"PATCH", "/api/v1/floors/flr_t/draft", map[string]any{}, []string{"admin"}},
		{"POST", "/api/v1/floors/flr_t/publish", map[string]any{"dryRun": true}, []string{"admin"}},
		{"POST", "/api/v1/floors/flr_t/zones", map[string]any{"dryRun": true}, []string{"admin"}},
		{"POST", "/api/v1/zones/move", map[string]any{"dryRun": true}, []string{"admin"}},
		{"POST", "/api/v1/zone-changes/nope/undo", nil, []string{"admin"}},
		{"PUT", "/api/v1/members/nope/seat", map[string]any{}, []string{"admin", "team_lead"}},
		{"GET", "/api/v1/exits", nil, []string{"admin", "team_lead"}},
		{"GET", "/api/v1/overview", nil, []string{"admin", "team_lead"}},
		{"GET", "/api/v1/activity", nil, []string{"admin"}},
		{"GET", "/api/v1/admin/users", nil, []string{"admin"}},
		{"POST", "/api/v1/admin/users", map[string]string{}, []string{"admin"}},
		{"POST", "/api/v1/transfers", map[string]string{}, []string{"team_lead"}},
		{"POST", "/api/v1/transfers/nope/advance", map[string]string{"from": "requested"}, []string{"it"}},
		{"DELETE", "/api/v1/transfers/nope", nil, []string{"team_lead"}},
		{"POST", "/api/v1/exits", map[string]string{}, []string{"team_lead"}},
		{"DELETE", "/api/v1/exits/batches/nope", nil, []string{"team_lead"}},
		{"GET", "/api/v1/it-requests", nil, all},
		{"GET", "/api/v1/it-requests/nope", nil, all},
		{"POST", "/api/v1/it-requests", map[string]string{}, []string{"admin", "team_lead"}},
		{"GET", "/api/v1/it-requests/assignees", nil, []string{"it"}},
		{"POST", "/api/v1/it-requests/nope/cancel", map[string]string{}, []string{"admin", "team_lead"}},
		{"POST", "/api/v1/it-requests/nope/assign", map[string]string{"assigneeId": "me"}, []string{"it"}},
		{"POST", "/api/v1/it-requests/nope/status", map[string]string{"status": "in_progress"}, []string{"it"}},
		{"POST", "/api/v1/it-requests/nope/reject", map[string]string{"reason": "nope"}, []string{"it"}},
		{"POST", "/api/v1/it-requests/nope/comments", map[string]string{"body": "hi"}, all},
	}
	for _, c := range calls {
		for role, cl := range clients {
			r := cl.do(c.method, c.path, c.body)
			want := false
			for _, a := range c.allowed {
				want = want || a == role
			}
			if want && (r.Status == 401 || r.Status == 403) {
				t.Errorf("%s %s as %s: got %d %s, want allowed", c.method, c.path, role, r.Status, r.Error.Code)
			}
			if !want && (r.Status != 403 || r.Error.Code != "forbidden") {
				t.Errorf("%s %s as %s: got %d %s, want 403 forbidden", c.method, c.path, role, r.Status, r.Error.Code)
			}
		}
	}
	// Scoping: a lead gets 404 (not 403) for another team's member.
	if r := clients["team_lead"].do("GET", "/api/v1/members/m4", nil); r.Status != 404 {
		t.Errorf("lead read other team member: %d", r.Status)
	}
	if r := clients["it"].do("GET", "/api/v1/members/m4", nil); r.Status != 200 {
		t.Errorf("IT read member: %d", r.Status)
	}
}

func TestAuthenticationFlows(t *testing.T) {
	ts, _ := liveServer(t)
	anon := newClient(t, ts)
	if r := anon.do("GET", "/api/v1/workspace", nil); r.Status != 401 || r.Error.Code != "unauthenticated" {
		t.Errorf("anonymous workspace: %d %s", r.Status, r.Error.Code)
	}
	for _, p := range []string{"/api/v1/auth/signup", "/api/v1/auth/register", "/api/v1/users"} {
		if r := anon.do("POST", p, map[string]string{}); r.Status != 404 {
			t.Errorf("%s exists: %d", p, r.Status)
		}
	}
	// Generic errors: unknown email and wrong password look the same.
	a, b := anon.login("ghost@example.com", "whatever-password"), anon.login("lead@example.com", "wrong-password-1")
	if a.Status != 401 || b.Status != 401 || a.Error.Message != b.Error.Message || a.Error.Code != "invalid_credentials" {
		t.Errorf("non-generic login errors: %+v / %+v", a.Error, b.Error)
	}

	// CSRF: a valid session without the token can't write; a foreign Origin is refused.
	lead := newClient(t, ts).mustLogin("lead@example.com")
	tok := lead.csrf
	lead.csrf = ""
	if r := lead.do("PUT", "/api/v1/settings", map[string]any{"notifications": map[string]bool{"digest": true}}); r.Status != 403 || r.Error.Code != "csrf_failed" {
		t.Errorf("missing csrf: %d %s", r.Status, r.Error.Code)
	}
	lead.csrf = tok
	req, _ := http.NewRequest("PUT", ts.URL+"/api/v1/settings", bytes.NewReader([]byte(`{"notifications":{}}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("X-CSRF-Token", tok)
	if res, _ := lead.http.Do(req); res.StatusCode != 403 {
		t.Errorf("foreign origin accepted: %d", res.StatusCode)
	}

	// Session rotation: logging in again invalidates the previous cookie.
	u, _ := http.NewRequest("GET", ts.URL, nil)
	before := lead.http.Jar.Cookies(u.URL)
	lead.mustLogin("lead@example.com")
	stale := newClient(t, ts)
	stale.http.Jar.SetCookies(u.URL, before)
	if r := stale.do("GET", "/api/v1/auth/me", nil); r.Status != 401 {
		t.Errorf("pre-rotation session still valid: %d", r.Status)
	}

	// Logout revokes the session server-side.
	if r := lead.do("POST", "/api/v1/auth/logout", nil); r.Status != 200 {
		t.Fatalf("logout: %d %s", r.Status, r.Error.Code)
	}
	if r := lead.do("GET", "/api/v1/auth/me", nil); r.Status != 401 {
		t.Errorf("after logout: %d", r.Status)
	}
}

func TestLockout(t *testing.T) {
	ts, _ := liveServer(t)
	c := newClient(t, ts)
	for i := 1; i <= 5; i++ {
		r := c.login("it@example.com", "not-the-password")
		want := 401
		if i == 5 {
			want = 429
		}
		if r.Status != want {
			t.Fatalf("attempt %d: %d %s", i, r.Status, r.Error.Code)
		}
		if i == 5 && (r.Error.Code != "too_many_attempts" || r.Header.Get("Retry-After") == "") {
			t.Errorf("lockout response: %s retry-after=%q", r.Error.Code, r.Header.Get("Retry-After"))
		}
	}
	if r := c.login("it@example.com", passwords["it@example.com"]); r.Status != 429 {
		t.Errorf("correct password during lockout: %d", r.Status)
	}
	// Per IP+email throttle also covers unknown emails.
	for i := 0; i < 10; i++ {
		c.login("nobody@example.com", "x")
	}
	if r := c.login("nobody@example.com", "x"); r.Status != 429 {
		t.Errorf("unknown email not throttled: %d", r.Status)
	}
}

func TestAdminProvisioningAndForcedPasswordChange(t *testing.T) {
	ts, _ := liveServer(t)
	admin := newClient(t, ts).mustLogin("admin@example.com")
	type created struct {
		User struct {
			ID      string `json:"id"`
			Version int    `json:"version"`
		} `json:"user"`
		TemporaryPassword string `json:"temporaryPassword"`
	}
	mk := func(body map[string]any) created {
		r := admin.do("POST", "/api/v1/admin/users", body)
		if r.Status != 201 {
			t.Fatalf("create %v: %d %s %v", body, r.Status, r.Error.Code, r.Error.Fields)
		}
		var c created
		_ = json.Unmarshal(r.Data, &c)
		if len(c.TemporaryPassword) < 12 {
			t.Fatalf("weak temp password")
		}
		return c
	}
	newLead := mk(map[string]any{"email": "newlead@example.com", "name": "Nora Lead", "role": "team_lead", "teamId": "t2"})
	newIT := mk(map[string]any{"email": "newit@example.com", "name": "Omar Tech", "role": "it"})
	if r := admin.do("POST", "/api/v1/admin/users", map[string]any{"email": "newit@example.com", "name": "Dup", "role": "it"}); r.Status != 422 || r.Error.Fields["email"] == "" {
		t.Errorf("duplicate email: %d %v", r.Status, r.Error.Fields)
	}
	if r := admin.do("POST", "/api/v1/admin/users", map[string]any{"email": "ghost@example.com", "name": "Ghost Lead", "role": "team_lead", "teamId": "no-such-team"}); r.Status != 422 || r.Error.Fields["teamId"] == "" {
		t.Errorf("unknown team on create: %d %v", r.Status, r.Error.Fields)
	}
	if r := admin.do("PATCH", "/api/v1/admin/users/"+newLead.User.ID, map[string]any{"email": "newlead@example.com", "name": "Nora Lead", "role": "team_lead", "teamId": "no-such-team", "expectedVersion": newLead.User.Version}); r.Status != 422 || r.Error.Fields["teamId"] == "" {
		t.Errorf("unknown team on update: %d %v", r.Status, r.Error.Fields)
	}
	checkTeamDirectory(t, admin)

	for email, c := range map[string]created{"newlead@example.com": newLead, "newit@example.com": newIT} {
		u := newClient(t, ts)
		r := u.login(email, c.TemporaryPassword)
		if r.Status != 200 {
			t.Fatalf("%s first login: %d", email, r.Status)
		}
		var me struct {
			MustChangePassword bool `json:"mustChangePassword"`
		}
		_ = json.Unmarshal(r.Data, &me)
		if !me.MustChangePassword {
			t.Errorf("%s: mustChangePassword false", email)
		}
		if r := u.do("GET", "/api/v1/workspace", nil); r.Status != 403 || r.Error.Code != "password_change_required" {
			t.Errorf("%s before change: %d %s", email, r.Status, r.Error.Code)
		}
		if r := u.do("POST", "/api/v1/auth/change-password", map[string]string{"currentPassword": c.TemporaryPassword, "newPassword": "short"}); r.Status != 422 {
			t.Errorf("weak new password accepted: %d", r.Status)
		}
		r = u.do("POST", "/api/v1/auth/change-password", map[string]string{"currentPassword": c.TemporaryPassword, "newPassword": "Fresh-Secure-Phrase-77"})
		if r.Status != 200 {
			t.Fatalf("%s change password: %d %s %v", email, r.Status, r.Error.Code, r.Error.Fields)
		}
		var v struct {
			CSRFToken string `json:"csrfToken"`
		}
		_ = json.Unmarshal(r.Data, &v)
		u.csrf = v.CSRFToken
		if r := u.do("GET", "/api/v1/workspace", nil); r.Status != 200 {
			t.Errorf("%s after change: %d %s", email, r.Status, r.Error.Code)
		}
		if r := u.do("GET", "/api/v1/admin/users", nil); r.Status != 403 {
			t.Errorf("%s reached admin users: %d", email, r.Status)
		}
	}

	// Reset password: old sessions die, the new temp password works.
	nl := newClient(t, ts)
	nl.mustLoginWith("newlead@example.com", "Fresh-Secure-Phrase-77")
	r := admin.do("POST", "/api/v1/admin/users/"+newLead.User.ID+"/reset-password", nil)
	if r.Status != 200 {
		t.Fatalf("reset: %d %s", r.Status, r.Error.Code)
	}
	if r := nl.do("GET", "/api/v1/auth/me", nil); r.Status != 401 {
		t.Errorf("session survived password reset: %d", r.Status)
	}
	// Disable: login refused with the generic error.
	if r := admin.do("POST", "/api/v1/admin/users/"+newIT.User.ID+"/disable", nil); r.Status != 200 {
		t.Fatalf("disable: %d", r.Status)
	}
	if r := newClient(t, ts).login("newit@example.com", "Fresh-Secure-Phrase-77"); r.Status != 401 || r.Error.Code != "invalid_credentials" {
		t.Errorf("disabled login: %d %s", r.Status, r.Error.Code)
	}
	// Admin can't disable themselves.
	if r := admin.do("POST", "/api/v1/admin/users/usr_admin/disable", nil); r.Status != 409 {
		t.Errorf("self-disable: %d %s", r.Status, r.Error.Code)
	}
}

func (c *client) mustLoginWith(email, pw string) {
	c.t.Helper()
	if r := c.login(email, pw); r.Status != 200 {
		c.t.Fatalf("login %s: %d %s", email, r.Status, r.Error.Code)
	}
}

func TestUndoIsOwnerOnly(t *testing.T) {
	ts, _ := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	peer := newClient(t, ts).mustLogin("lead3@example.com") // same team, different person
	r := lead.do("POST", "/api/v1/transfers", map[string]any{"mode": "internal", "effectiveDate": time.Now().UTC().Format("2006-01-02"),
		"assignments": []map[string]string{{"memberId": "m1", "toSeatId": "C-3"}}})
	if r.Status != 201 && r.Status != 200 {
		t.Fatalf("create transfer: %d %s %v", r.Status, r.Error.Code, r.Error.Fields)
	}
	var res struct {
		Transfer struct {
			ID string `json:"id"`
		} `json:"transfer"`
	}
	_ = json.Unmarshal(r.Data, &res)
	if r := peer.do("DELETE", "/api/v1/transfers/"+res.Transfer.ID, nil); r.Status != 403 || r.Error.Code != "not_owner" {
		t.Errorf("peer undo: %d %s", r.Status, r.Error.Code)
	}
	if r := lead.do("DELETE", "/api/v1/transfers/"+res.Transfer.ID, nil); r.Status != 200 {
		t.Errorf("owner undo: %d %s", r.Status, r.Error.Code)
	}
}

// checkTeamDirectory: GET /teams lists every team with its active leads and
// counts, including a team with no lead and no members.
func checkTeamDirectory(t *testing.T, c *client) {
	t.Helper()
	r := c.do("GET", "/api/v1/teams", nil)
	if r.Status != 200 {
		t.Fatalf("teams: %d", r.Status)
	}
	var teams []struct {
		ID, Slug, Code, LeadName string
		Leads                    []struct{ ID, Name string }
		MemberCount              int `json:"memberCount"`
		SeatsOccupied            int `json:"seatsOccupied"`
		SeatsTotal               int `json:"seatsTotal"`
	}
	if err := json.Unmarshal(r.Data, &teams); err != nil {
		t.Fatal(err)
	}
	byID := map[string]int{}
	for i, tm := range teams {
		byID[tm.ID] = i
	}
	if len(teams) != 3 {
		t.Fatalf("want 3 teams, got %d", len(teams))
	}
	t1, t2, t3 := teams[byID["t1"]], teams[byID["t2"]], teams[byID["t3"]]
	if len(t1.Leads) != 2 || t1.Leads[0].Name != "Lead One" || t1.Leads[1].Name != "Lead Three" || t1.LeadName != "Lead One, Lead Three" {
		t.Errorf("t1 leads: %+v %q", t1.Leads, t1.LeadName)
	}
	if t1.MemberCount != 2 || t1.SeatsOccupied != 2 || t1.SeatsTotal != 24 {
		t.Errorf("t1 counts: %+v", t1)
	}
	if len(t2.Leads) != 1 || t2.Leads[0].Name != "Nora Lead" {
		t.Errorf("t2 leads: %+v", t2.Leads)
	}
	if len(t3.Leads) != 0 || t3.LeadName != "" || t3.MemberCount != 0 || t3.SeatsOccupied != 0 || t3.Slug != "rapid-response" || t3.Code != "RR" {
		t.Errorf("empty team: %+v", t3)
	}
}

// seedTestFloor publishes "flr_t": 5 rows x 8 seats (ids = codes A-1 .. E-8);
// rows A, C, D are t1's zone, row B is t2's, row E has no team.
func seedTestFloor(t *testing.T, ctx context.Context, d *db.DB) {
	t.Helper()
	zones := map[rune]string{'A': "t1", 'B': "t2", 'C': "t1", 'D': "t1"}
	var els []domain.FloorElement
	for r, row := range "ABCDE" {
		for n := 1; n <= 8; n++ {
			id := fmt.Sprintf("%c-%d", row, n)
			e := domain.FloorElement{ID: id, Kind: domain.KindSeat, X: n, Y: r * 2, W: 1, H: 1, Code: id, CodeLocked: true}
			if z, ok := zones[row]; ok {
				e.TeamID = &z
			}
			els = append(els, e)
		}
	}
	raw, _ := json.Marshal(map[string]any{"cols": 10, "rows": 10, "elements": els})
	if _, err := d.Pool.Exec(ctx, `INSERT INTO floors (id, name, level, cols, rows, status, draft, published_at)
		VALUES ('flr_t','Test Floor',1,10,10,'published',$1,now())`, raw); err != nil {
		t.Fatal(err)
	}
	for _, e := range els {
		if _, err := d.Pool.Exec(ctx, `INSERT INTO floor_cells (id, floor_id, kind, x, y, w, h, code, team_id)
			VALUES ($1,'flr_t','seat',$2,$3,1,1,$4,$5)`, e.ID, e.X, e.Y, e.Code, e.TeamID); err != nil {
			t.Fatal(err)
		}
	}
}

// With FLOOR_LAYOUT_LOCKED on, an admin can read layouts and re-zone but not change them.
func TestFloorLayoutLocked(t *testing.T) {
	ts, srv := liveServer(t)
	srv.cfg.FloorLayoutLocked = true
	admin := newClient(t, ts).mustLogin("admin@example.com")
	lead := newClient(t, ts).mustLogin("lead@example.com")
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/v1/floors"},
		{"POST", "/api/v1/floors/flr_t/duplicate"},
		{"PUT", "/api/v1/floors/flr_t/draft"},
		{"PATCH", "/api/v1/floors/flr_t/draft"},
		{"DELETE", "/api/v1/floors/flr_t/draft"},
		{"POST", "/api/v1/floors/flr_t/publish"},
	} {
		if r := admin.do(c.method, c.path, map[string]any{}); r.Status != 403 || r.Error.Code != "layout_locked" {
			t.Errorf("%s %s as admin: got %d %s, want 403 layout_locked", c.method, c.path, r.Status, r.Error.Code)
		}
		if r := lead.do(c.method, c.path, map[string]any{}); r.Status != 403 || r.Error.Code != "forbidden" {
			t.Errorf("%s %s as lead: got %d %s, want 403 forbidden", c.method, c.path, r.Status, r.Error.Code)
		}
	}
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/v1/floors/flr_t", nil},
		{"GET", "/api/v1/floors/flr_t/draft", nil},
		{"POST", "/api/v1/floors/flr_t/zones", map[string]any{"dryRun": true}},
	} {
		if r := admin.do(c.method, c.path, c.body); r.Status == 403 {
			t.Errorf("%s %s as admin: got 403 %s, want allowed", c.method, c.path, r.Error.Code)
		}
	}
	r := admin.do("GET", "/api/v1/workspace", nil)
	var ws struct {
		FloorLayoutLocked bool `json:"floorLayoutLocked"`
	}
	if err := json.Unmarshal(r.Data, &ws); err != nil || !ws.FloorLayoutLocked {
		t.Errorf("workspace floorLayoutLocked = %v (err %v), want true", ws.FloorLayoutLocked, err)
	}
}
