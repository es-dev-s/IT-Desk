package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"itdesk/backend/internal/auth"
)

type sseEvent struct {
	ID    string
	Event string
	Data  string
}

type sseStream struct {
	mu     sync.Mutex
	events []sseEvent
	cancel context.CancelFunc
	status int
	ctype  string
}

// openStream opens GET /events as c and collects events in the background.
func openStream(t *testing.T, c *client, lastID string) *sseStream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", c.base+EventsPath, nil)
	req.Header.Set("Accept", "text/event-stream")
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	res, err := c.http.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	s := &sseStream{cancel: cancel, status: res.StatusCode, ctype: res.Header.Get("Content-Type")}
	t.Cleanup(func() { cancel(); res.Body.Close() })
	go func() {
		sc := bufio.NewScanner(res.Body)
		var cur sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if cur.Event != "" || cur.Data != "" {
					s.mu.Lock()
					s.events = append(s.events, cur)
					s.mu.Unlock()
				}
				cur = sseEvent{}
			case strings.HasPrefix(line, "id: "):
				cur.ID = line[4:]
			case strings.HasPrefix(line, "event: "):
				cur.Event = line[7:]
			case strings.HasPrefix(line, "data: "):
				cur.Data = line[6:]
			}
		}
	}()
	return s
}

// waitFor returns the first event matching fn within d.
func (s *sseStream) waitFor(d time.Duration, fn func(sseEvent) bool) (sseEvent, bool) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		for _, e := range s.events {
			if fn(e) {
				s.mu.Unlock()
				return e, true
			}
		}
		s.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	return sseEvent{}, false
}

func (s *sseStream) all() []sseEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.events)
}

func kindIs(kind, ticket string) func(sseEvent) bool {
	return func(e sseEvent) bool {
		return e.Event == "notification" && strings.Contains(e.Data, `"kind":"`+kind+`"`) &&
			(ticket == "" || strings.Contains(e.Data, `"ticket":"`+ticket+`"`))
	}
}

func TestRealtimeNotificationsAndAcknowledge(t *testing.T) {
	ts, srv := liveServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go srv.Hub().Run(ctx)
	for i := 0; i < 100 && !srv.Hub().Listening(); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if !srv.Hub().Listening() {
		t.Fatal("hub did not start listening")
	}
	// A lead of another team, who must never hear about team t1.
	passwords["lead2rt@example.com"] = "Other-Team-Lead-Pass-5"
	h, _ := auth.HashPassword(passwords["lead2rt@example.com"])
	if _, err := srv.db.Pool.Exec(ctx, `INSERT INTO users (id, email, name, title, role, team_id, password_hash, must_change_password)
		VALUES ('lead_two','lead2rt@example.com','Nora Two','Lead','team_lead','t2',$1,false)`, h); err != nil {
		t.Fatal(err)
	}

	lead := newClient(t, ts).mustLogin("lead@example.com")
	peer := newClient(t, ts).mustLogin("lead3@example.com")
	other := newClient(t, ts).mustLogin("lead2rt@example.com")
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")

	// Unauthenticated streams are refused.
	if r := newClient(t, ts).do("GET", EventsPath, nil); r.Status != 401 {
		t.Errorf("anonymous stream: %d", r.Status)
	}
	itS := openStream(t, it, "")
	if itS.status != 200 || !strings.HasPrefix(itS.ctype, "text/event-stream") {
		t.Fatalf("stream: %d %q", itS.status, itS.ctype)
	}
	leadS, otherS, adminS := openStream(t, lead, ""), openStream(t, other, ""), openStream(t, admin, "")
	for name, s := range map[string]*sseStream{"it": itS, "lead": leadS, "other": otherS, "admin": adminS} {
		if _, ok := s.waitFor(3*time.Second, func(e sseEvent) bool { return e.Event == "ready" }); !ok {
			t.Fatalf("%s: no ready event", name)
		}
	}

	// 1. A lead creates a transfer: IT is notified live.
	r := lead.do("POST", "/api/v1/transfers", map[string]any{"mode": "internal", "effectiveDate": time.Now().UTC().Format("2006-01-02"),
		"assignments": []map[string]string{{"memberId": "m1", "toSeatId": "C-3"}}})
	if r.Status != 201 && r.Status != 200 {
		t.Fatalf("create transfer: %d %s %v", r.Status, r.Error.Code, r.Error.Fields)
	}
	var tr struct {
		Transfer struct {
			ID, Ticket      string
			Version         int
			Acknowledgement *struct{ ByID, ByName, At string }
		} `json:"transfer"`
	}
	_ = json.Unmarshal(r.Data, &tr)
	if tr.Transfer.Acknowledgement != nil {
		t.Errorf("new transfer already acknowledged")
	}
	ev, ok := itS.waitFor(3*time.Second, kindIs("transfer.created", tr.Transfer.Ticket))
	if !ok || ev.ID == "" || !strings.Contains(ev.Data, "New transfer "+tr.Transfer.Ticket+" from Platform") {
		t.Fatalf("IT did not get transfer.created live: %+v", itS.all())
	}
	if _, ok := adminS.waitFor(2*time.Second, func(e sseEvent) bool { return e.Event == "entity" && strings.Contains(e.Data, tr.Transfer.ID) }); !ok {
		t.Error("admin did not get the entity change")
	}

	// 4. Lead of another team hears nothing; the creating lead gets no
	// notification of their own action.
	time.Sleep(300 * time.Millisecond)
	floorEvent := false
	for _, e := range otherS.all() {
		if e.Event == "entity" && strings.Contains(e.Data, `"entity":"floor"`) {
			// Floor plans are shared: everyone hears "floor X changed", never who.
			floorEvent = true
			if strings.Contains(e.Data, "Ann") || strings.Contains(e.Data, "m1") {
				t.Errorf("floor event leaks a person: %s", e.Data)
			}
			continue
		}
		if e.Event == "notification" || e.Event == "entity" {
			t.Errorf("other-team lead received %s: %s", e.Event, e.Data)
		}
	}
	if !floorEvent {
		t.Error("other-team lead did not hear the floor occupancy change")
	}
	if _, ok := leadS.waitFor(200*time.Millisecond, kindIs("transfer.created", "")); ok {
		t.Error("creator was notified of their own transfer")
	}

	// 5. Only IT may acknowledge.
	path := "/api/v1/transfers/" + tr.Transfer.ID + "/acknowledge"
	for name, c := range map[string]*client{"lead": lead, "admin": admin} {
		if r := c.do("POST", path, nil); r.Status != 403 {
			t.Errorf("%s acknowledge: %d", name, r.Status)
		}
	}
	if r := it.do("POST", path, map[string]any{"expectedVersion": tr.Transfer.Version + 5}); r.Status != 409 || r.Error.Code != "stale_transfer" {
		t.Errorf("stale acknowledge: %d %s", r.Status, r.Error.Code)
	}
	// 2. IT acknowledges; the lead (and their same-team peer) see it live.
	r = it.do("POST", path, map[string]any{"expectedVersion": tr.Transfer.Version})
	var acked struct {
		Version, ItStatus any
		ItStatusS         string `json:"itStatus"`
		Acknowledgement   *struct{ ByID, ByName, At string }
	}
	_ = json.Unmarshal(r.Data, &acked)
	if r.Status != 200 || acked.Acknowledgement == nil || acked.Acknowledgement.ByName != "Ivan Tech" || acked.ItStatusS != "requested" {
		t.Fatalf("acknowledge: %d %s %+v", r.Status, r.Error.Code, acked)
	}
	first := acked.Acknowledgement.At
	if r := it.do("POST", path, nil); r.Status != 200 { // idempotent
		t.Errorf("repeat acknowledge: %d", r.Status)
	} else {
		_ = json.Unmarshal(r.Data, &acked)
		if acked.Acknowledgement.At != first {
			t.Error("repeat acknowledge changed the record")
		}
	}
	if ev, ok := leadS.waitFor(3*time.Second, kindIs("transfer.acknowledged", tr.Transfer.Ticket)); !ok ||
		!strings.Contains(ev.Data, "Seen by Ivan Tech") {
		t.Errorf("lead did not see the acknowledgement live: %+v", leadS.all())
	}
	var count int
	_ = srv.db.Pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE kind = 'transfer.acknowledged'`).Scan(&count)
	if count != 2 { // lead + same-team peer, once (repeat was a no-op)
		t.Errorf("acknowledged notifications: %d, want 2", count)
	}

	// Fan-out targets, straight from the log.
	recipients := func(kind string) []string {
		rows, _ := srv.db.Pool.Query(ctx, `SELECT recipient_id FROM notifications WHERE kind = $1 ORDER BY recipient_id`, kind)
		defer rows.Close()
		var out []string
		for rows.Next() {
			var id string
			_ = rows.Scan(&id)
			out = append(out, id)
		}
		return out
	}
	if got := recipients("transfer.created"); !slices.Equal(got, []string{"usr_it"}) {
		t.Errorf("transfer.created → %v", got)
	}
	if got := recipients("transfer.acknowledged"); !slices.Equal(got, []string{"lead_test", "lead_three"}) {
		t.Errorf("transfer.acknowledged → %v", got)
	}

	// IT request: created → IT; acknowledge claims it and starts it.
	req := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{
		"items": []map[string]any{{"kind": "laptop", "quantity": 2}}, "notes": "Two laptops for new joiners"}), 201, "create request")
	if ev, ok := itS.waitFor(3*time.Second, kindIs("request.created", req.Ticket)); !ok ||
		!strings.Contains(ev.Data, "New request "+req.Ticket+" · Laptop ×2") {
		t.Fatalf("IT did not get request.created: %+v", itS.all())
	}
	rpath := "/api/v1/it-requests/" + req.ID + "/acknowledge"
	if r := lead.do("POST", rpath, nil); r.Status != 403 {
		t.Errorf("lead acknowledge request: %d", r.Status)
	}
	got := decodeReq(t, it.do("POST", rpath, map[string]any{"expectedVersion": req.Version}), 200, "ack request")
	if got.Status != "in_progress" || got.AssigneeID == nil || *got.AssigneeID != "usr_it" ||
		got.Events[len(got.Events)-1].Kind != "acknowledged" || !strings.Contains(got.Events[len(got.Events)-1].Body, "Seen by Ivan Tech") {
		t.Errorf("acknowledged request: %+v", got)
	}
	again := decodeReq(t, it.do("POST", rpath, map[string]any{"expectedVersion": req.Version}), 200, "repeat ack request")
	if again.Version != got.Version || len(again.Events) != len(got.Events) {
		t.Errorf("repeat request acknowledge was not a no-op")
	}
	if _, ok := leadS.waitFor(3*time.Second, kindIs("request.acknowledged", req.Ticket)); !ok {
		t.Errorf("lead did not get request.acknowledged")
	}
	if _, ok := otherS.waitFor(300*time.Millisecond, func(e sseEvent) bool {
		return e.Event == "notification" || (e.Event == "entity" && strings.Contains(e.Data, req.ID))
	}); ok {
		t.Errorf("other-team lead received request events: %+v", otherS.all())
	}
	if r := peer.do("GET", "/api/v1/notifications", nil); r.Status != 200 {
		t.Errorf("peer notifications: %d", r.Status)
	}

	// Bell: list, mark one read, mark all read.
	var page struct {
		Items []struct {
			ID     int64
			Kind   string
			ReadAt *string `json:"readAt"`
		}
		Unread int
	}
	r = lead.do("GET", "/api/v1/notifications", nil)
	_ = json.Unmarshal(r.Data, &page)
	if r.Status != 200 || page.Unread != 2 || len(page.Items) != 2 {
		t.Fatalf("lead notifications: %d %+v", r.Status, page)
	}
	if r := lead.do("POST", "/api/v1/notifications/"+itoa(page.Items[0].ID)+"/read", nil); r.Status != 200 {
		t.Errorf("mark read: %d", r.Status)
	}
	if r := other.do("POST", "/api/v1/notifications/"+itoa(page.Items[1].ID)+"/read", nil); r.Status != 404 {
		t.Errorf("reading someone else's notification: %d", r.Status)
	}
	if _, ok := leadS.waitFor(2*time.Second, func(e sseEvent) bool { return e.Event == "read" }); !ok {
		t.Error("read sync event not delivered")
	}
	r = lead.do("POST", "/api/v1/notifications/read-all", nil)
	var rr struct{ Updated, Unread int }
	_ = json.Unmarshal(r.Data, &rr)
	if r.Status != 200 || rr.Updated != 1 || rr.Unread != 0 {
		t.Errorf("read-all: %d %+v", r.Status, rr)
	}

	// 3. Resume: a reconnect with Last-Event-ID replays what was missed.
	r = it.do("GET", "/api/v1/notifications", nil)
	_ = json.Unmarshal(r.Data, &page)
	if len(page.Items) < 2 {
		t.Fatalf("IT notifications: %+v", page)
	}
	oldest := page.Items[len(page.Items)-1].ID
	resumed := openStream(t, it, itoa(oldest))
	if _, ok := resumed.waitFor(3*time.Second, func(e sseEvent) bool { return e.Event == "notification" && e.ID == itoa(page.Items[0].ID) }); !ok {
		t.Errorf("resume did not replay: %+v", resumed.all())
	}
	if ev, ok := resumed.waitFor(time.Second, func(e sseEvent) bool { return e.Event == "ready" }); !ok || !strings.Contains(ev.Data, `"resync":true`) {
		t.Errorf("resumed ready: %+v", ev)
	}
	for _, e := range resumed.all() {
		if e.ID == itoa(oldest) {
			t.Error("replayed the Last-Event-ID itself")
		}
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
