package store

import (
	"context"
	"testing"

	"itdesk/backend/internal/domain"
)

// A lead who has an account but no roster record can seat themselves, inside
// their own zone only; once rostered they move freely within it, and an admin
// can still change the seat to anywhere.
func TestLeadSeatsAndMovesSelf(t *testing.T) {
	st, lead := setup(t)
	admin := as(adminU)
	ctx := context.Background()
	seatOf := func(id string) string {
		m, err := st.Member(ctx, admin, id)
		if err != nil || m.Seat == nil {
			t.Fatalf("member %s: %v %+v", id, err, m)
		}
		return *m.Seat
	}

	ws, err := st.Workspace(ctx, lead, "")
	if err != nil || len(ws.UnrosteredLeads) != 1 || ws.UnrosteredLeads[0].ID != lead.User.ID {
		t.Fatalf("lead should see only themselves as unrostered: %+v %v", ws.UnrosteredLeads, err)
	}

	if _, err := st.AssignUnrosteredLeadSeat(ctx, lead, leadT2.ID, "C-1"); code(err) != "forbidden" {
		t.Fatalf("lead seated another lead: %s", code(err))
	}
	if _, err := st.AssignUnrosteredLeadSeat(ctx, lead, lead.User.ID, "B-1"); code(err) != "zone_scope" {
		t.Fatalf("lead took another team's zone: %s", code(err))
	}
	if _, err := st.AssignUnrosteredLeadSeat(ctx, lead, lead.User.ID, "A-1"); err == nil {
		t.Fatal("lead took an occupied seat")
	}
	self, err := st.AssignUnrosteredLeadSeat(ctx, lead, lead.User.ID, "C-1")
	if err != nil || self.Seat == nil || *self.Seat != "C-1" || !self.IsLead {
		t.Fatalf("lead self-seat: %v %+v", err, self)
	}
	if _, err := st.AssignUnrosteredLeadSeat(ctx, lead, lead.User.ID, "C-2"); code(err) != "lead_already_rostered" {
		t.Fatalf("second self-seat should point at the roster entry: %s", code(err))
	}
	if ws, err = st.Workspace(ctx, lead, ""); err != nil || len(ws.UnrosteredLeads) != 0 {
		t.Fatalf("seated lead still unrostered: %+v %v", ws.UnrosteredLeads, err)
	}

	// Move own seat: free seat in zone ok, taken / other zone refused.
	to := "C-2"
	if _, err := st.AssignSeat(ctx, lead, self.ID, domain.SeatAssignInput{SeatID: &to}); err != nil || seatOf(self.ID) != "C-2" {
		t.Fatalf("lead move own seat: %v", err)
	}
	taken := "A-1"
	if _, err := st.AssignSeat(ctx, lead, self.ID, domain.SeatAssignInput{SeatID: &taken}); err == nil {
		t.Fatal("lead moved onto a taken seat")
	}
	other := "B-1"
	if _, err := st.AssignSeat(ctx, lead, self.ID, domain.SeatAssignInput{SeatID: &other}); code(err) != "zone_scope" {
		t.Fatalf("lead moved outside their zone: %s", code(err))
	}

	// Admin can put the lead on any free seat.
	if _, err := st.AssignSeat(ctx, admin, self.ID, domain.SeatAssignInput{SeatID: &other}); err != nil || seatOf(self.ID) != "B-1" {
		t.Fatalf("admin change lead seat: %v", err)
	}
}
