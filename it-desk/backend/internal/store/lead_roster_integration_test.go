package store

import (
	"context"
	"testing"

	"itdesk/backend/internal/domain"
)

// Lead accounts get a seatless roster record when created or re-enabled, so
// they can be edited and seated like any member (existing leads are
// backfilled by migration 0016).
func TestLeadAccountGetsRosterRecord(t *testing.T) {
	st, _ := setup(t)
	admin := as(adminU)
	ctx := context.Background()

	if _, err := st.SetUserStatus(ctx, admin, leadT2.ID, false); err != nil {
		t.Fatal(err)
	}
	u, err := st.CreateUser(ctx, admin, domain.UserInput{Email: "fresh.lead@example.com", Name: "Fresh Lead", Title: "Team Lead", Role: "team_lead", TeamID: "t2"}, "h")
	if err != nil {
		t.Fatal(err)
	}
	fresh := as(domain.User{ID: u.ID, Name: u.Name, Email: u.Email, Title: u.Title, Role: "team_lead", TeamID: "t2"})
	ws, err := st.Workspace(ctx, fresh, "")
	if err != nil || len(ws.UnrosteredLeads) != 0 {
		t.Fatalf("new lead should be on the roster: %+v %v", ws.UnrosteredLeads, err)
	}
	var self *domain.Member
	for i, m := range ws.Members {
		if m.Email == "fresh.lead@example.com" {
			self = &ws.Members[i]
		}
	}
	if self == nil || !self.IsLead || self.SeatID != nil || self.TeamID != "t2" {
		t.Fatalf("lead roster record: %+v", self)
	}

	// The lead edits their own record.
	in := domain.MemberInput{Name: "Fresh Lead", Email: self.Email, Designation: "Head of Payments", SubGroup: "Leads", TeamID: "t2"}
	if _, err := st.UpdateMember(ctx, fresh, self.ID, in); err != nil {
		t.Fatalf("lead edit own record: %v", err)
	}

	// Re-enabling a lead without a record creates one; no duplicates either way.
	if _, err := st.SetUserStatus(ctx, admin, u.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetUserStatus(ctx, admin, leadT2.ID, true); err != nil {
		t.Fatal(err)
	}
	ws, err = st.Workspace(ctx, as(leadT2), "")
	if err != nil || len(ws.UnrosteredLeads) != 0 {
		t.Fatalf("re-enabled lead should be on the roster: %+v %v", ws.UnrosteredLeads, err)
	}
	pool, err := st.pool()
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM members WHERE lower(email) = 'fresh.lead@example.com'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("fresh lead records: %d %v", n, err)
	}
}
