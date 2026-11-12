package realtime

import (
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"itdesk/backend/internal/db"
)

func newTestHub() *Hub {
	return New(&db.DB{Schema: "itdesk_test"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func recv(s *Subscriber) (Event, bool) {
	select {
	case ev := <-s.C:
		return ev, true
	case <-time.After(50 * time.Millisecond):
		return Event{}, false
	}
}

func TestRoutingAndTeamScope(t *testing.T) {
	h := newTestHub()
	it := h.Subscribe("u_it", "it", "")
	admin := h.Subscribe("u_admin", "admin", "")
	leadA := h.Subscribe("u_lead_a", "team_lead", "tA")
	leadB := h.Subscribe("u_lead_b", "team_lead", "tB")
	data := json.RawMessage(`{}`)

	// Entity events: org-wide roles always; leads only for their team.
	h.Deliver(Envelope{Type: TypeEntity, Teams: []string{"tA"}, Data: data})
	for name, s := range map[string]*Subscriber{"it": it, "admin": admin, "leadA": leadA} {
		if _, ok := recv(s); !ok {
			t.Errorf("%s missed a tA entity event", name)
		}
	}
	if _, ok := recv(leadB); ok {
		t.Error("lead of another team received a tA entity event")
	}
	// Org-wide entity (no teams) never reaches leads.
	h.Deliver(Envelope{Type: TypeEntity, Data: data})
	if _, ok := recv(leadA); ok {
		t.Error("lead received an org-wide entity event")
	}
	if _, ok := recv(it); !ok {
		t.Error("IT missed an org-wide entity event")
	}
	recv(admin)

	// Notifications go to the recipient only (every tab).
	tab2 := h.Subscribe("u_lead_a", "team_lead", "tA")
	h.Deliver(Envelope{Type: TypeNotification, Recipient: "u_lead_a", ID: 7, Data: data})
	for _, s := range []*Subscriber{leadA, tab2} {
		if ev, ok := recv(s); !ok || ev.ID != 7 {
			t.Errorf("recipient tab missed notification: %+v %v", ev, ok)
		}
	}
	for _, s := range []*Subscriber{it, admin, leadB} {
		if _, ok := recv(s); ok {
			t.Error("non-recipient received a notification")
		}
	}
}

func TestSlowConsumerIsDropped(t *testing.T) {
	h := newTestHub()
	h.buffer = 2
	s := h.Subscribe("u", "it", "")
	for i := 0; i < 3; i++ {
		h.Deliver(Envelope{Type: TypeNotification, Recipient: "u", ID: int64(i + 1), Data: json.RawMessage(`{}`)})
	}
	select {
	case <-s.Done():
	default:
		t.Fatal("slow subscriber was not dropped")
	}
	if s.Reason() != "slow_consumer" || h.Count() != 0 {
		t.Errorf("reason %q count %d", s.Reason(), h.Count())
	}
}

func TestPerUserLimitEvictsOldest(t *testing.T) {
	h := newTestHub()
	h.maxPerUser = 2
	a := h.Subscribe("u", "it", "")
	time.Sleep(time.Millisecond)
	h.Subscribe("u", "it", "")
	time.Sleep(time.Millisecond)
	h.Subscribe("u", "it", "")
	select {
	case <-a.Done():
	default:
		t.Fatal("oldest stream not evicted")
	}
	if h.Count() != 2 {
		t.Errorf("count %d", h.Count())
	}
	h.Close()
	if h.Count() != 0 {
		t.Errorf("after close %d", h.Count())
	}
	if s := h.Subscribe("u", "it", ""); s.Reason() != "shutdown" {
		t.Error("subscribe after close should be dropped")
	}
}

func TestRolesAndSessionCheck(t *testing.T) {
	h := newTestHub()
	it := h.Subscribe("u_it", "it", "")
	admin := h.Subscribe("u_admin", "admin", "")
	lead := h.Subscribe("u_lead", "team_lead", "tA")
	data := json.RawMessage(`{}`)

	// Role-limited entity events (account changes) reach admins only.
	h.Deliver(Envelope{Type: TypeEntity, Roles: []string{"admin"}, Teams: []string{"tA"}, Data: data})
	if _, ok := recv(admin); !ok {
		t.Error("admin missed an admin-only event")
	}
	for name, s := range map[string]*Subscriber{"it": it, "lead": lead} {
		if _, ok := recv(s); ok {
			t.Errorf("%s received an admin-only event", name)
		}
	}
	// Session checks go to the targeted user's streams only.
	h.Deliver(Envelope{Type: TypeSession, Recipient: "u_lead", Data: data})
	if ev, ok := recv(lead); !ok || ev.Type != TypeSession {
		t.Errorf("target missed session check: %+v %v", ev, ok)
	}
	for _, s := range []*Subscriber{it, admin} {
		if _, ok := recv(s); ok {
			t.Error("non-target received a session check")
		}
	}
}
