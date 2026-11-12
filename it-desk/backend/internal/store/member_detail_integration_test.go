package store

import (
	"context"
	"testing"

	"itdesk/backend/internal/domain"
)

// Member detail: team-scoped like Member, with desk moves and transfers on the timeline.
func TestMemberDetailScopeAndHistory(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	seat := func(s string) *string { return &s }

	p, err := st.CreateMember(ctx, lead, domain.MemberInput{Name: "Desk Mover", Designation: "Eng", TeamID: "t1", SeatID: seat("A-5")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := st.UpdateMember(ctx, lead, p.ID, domain.MemberInput{Name: "Desk Mover", Designation: "Eng", TeamID: "t1", SeatID: seat("A-6"), ExpectedVersion: &p.Version}); err != nil {
		t.Fatalf("update seat: %v", err)
	}
	tr := domain.TransferInput{Mode: "internal", ToTeamID: "t1", EffectiveDate: today(), Assignments: []domain.Assignment{{MemberID: "m3", ToSeatID: "A-7"}}}
	res, err := st.CreateTransfer(ctx, lead, tr)
	if err != nil {
		t.Fatalf("transfer: %v", err)
	}

	d, err := st.MemberDetail(ctx, lead, p.ID)
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if d.CreatedAt.IsZero() || len(d.History) < 2 || d.History[0].Kind != "desk" || d.History[0].Detail != "Seat A-5 → Seat A-6" || d.History[len(d.History)-1].Kind != "created" {
		t.Fatalf("history: %+v", d.History)
	}
	m3, err := st.MemberDetail(ctx, as(adminU), "m3")
	if err != nil || len(m3.History) == 0 || m3.History[0].Kind != "transfer" || m3.History[0].Ticket == "" || m3.History[0].Detail != "Seat A-3 → Seat A-7" {
		t.Fatalf("m3 history: %v %+v (transfer %+v)", err, m3.History, res)
	}
	// Outside the lead's team: not found (existence isn't leaked).
	if _, err := st.MemberDetail(ctx, lead, "m4"); code(err) != "not_found" {
		t.Fatalf("lead read other team: %s", code(err))
	}
	if _, err := st.MemberDetail(ctx, lead, "nope"); code(err) != "not_found" {
		t.Fatalf("missing: %s", code(err))
	}
}
