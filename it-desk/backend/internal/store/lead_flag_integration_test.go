package store

import (
	"context"
	"testing"

	"itdesk/backend/internal/domain"
)

func TestWorkspaceIncludesUnrosteredLeadsForAdmin(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	if _, err := st.db.Pool.Exec(ctx, `UPDATE members SET email = CASE id
		WHEN 'm1' THEN upper($1::text) WHEN 'm2' THEN $2::text END
		WHERE id IN ('m1', 'm2')`, leadT1.Email, leadT2.Email); err != nil {
		t.Fatal(err)
	}

	ws, err := st.Workspace(ctx, as(adminU), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(ws.UnrosteredLeads) != 1 {
		t.Fatalf("expected only the lead without a member on their own team: %+v", ws.UnrosteredLeads)
	}
	got := ws.UnrosteredLeads[0]
	if got.ID != leadT2.ID || got.TeamID != leadT2.TeamID || got.Title != leadT2.Title {
		t.Errorf("incorrect lead account: %+v", got)
	}
	if len(ws.Members) != 4 {
		t.Errorf("expected four existing roster records, got %d", len(ws.Members))
	}
	member, err := st.Member(ctx, as(adminU), "m1")
	if err != nil || !member.IsLead || member.Seat == nil || *member.Seat != "A-1" {
		t.Errorf("matched lead should keep their seat and lead flag: %+v, %v", member, err)
	}

	for _, actor := range []Actor{lead, as(itU)} {
		ws, err := st.Workspace(ctx, actor, "")
		if err != nil || len(ws.UnrosteredLeads) != 0 {
			t.Errorf("%s workspace exposed account-only leads: %+v, %v", actor.User.Role, ws.UnrosteredLeads, err)
		}
	}
}

// Lead status is admin-only: a team lead can't create, promote, demote or
// transfer out a lead, and editing a lead keeps the flag when it's omitted.
func TestLeadFlagIsAdminOnly(t *testing.T) {
	st, lead := setup(t)
	admin := as(adminU)
	ctx := context.Background()
	yes, no := true, false

	// Create: lead + isLead=true -> 403; lead + false/omitted -> ok; admin + true -> ok.
	if _, err := st.CreateMember(ctx, lead, domain.MemberInput{Name: "Wannabe Lead", Designation: "Eng", TeamID: "t1", IsLead: &yes}); code(err) != "lead_admin_only" {
		t.Fatalf("lead created a lead: %s", code(err))
	}
	plain, err := st.CreateMember(ctx, lead, domain.MemberInput{Name: "Plain Person", Designation: "Eng", TeamID: "t1", IsLead: &no})
	if err != nil || plain.IsLead {
		t.Fatalf("lead create plain: %v %+v", err, plain)
	}
	if _, err := st.CreateMember(ctx, lead, domain.MemberInput{Name: "Omitted Flag", Designation: "Eng", TeamID: "t1"}); err != nil {
		t.Fatalf("lead create omitted flag: %v", err)
	}
	boss, err := st.CreateMember(ctx, admin, domain.MemberInput{Name: "Real Lead", Designation: "Lead", TeamID: "t1", IsLead: &yes})
	if err != nil || !boss.IsLead {
		t.Fatalf("admin create lead: %v %+v", err, boss)
	}

	// Update: lead promoting -> 403; lead demoting -> 403; lead editing a lead with
	// the flag omitted or echoed keeps it; admin can change it.
	if _, err := st.UpdateMember(ctx, lead, plain.ID, domain.MemberInput{Name: "Plain Person", Designation: "Eng", TeamID: "t1", IsLead: &yes}); code(err) != "lead_admin_only" {
		t.Fatalf("lead promoted: %s", code(err))
	}
	if _, err := st.UpdateMember(ctx, lead, boss.ID, domain.MemberInput{Name: "Real Lead", Designation: "Lead", TeamID: "t1", IsLead: &no}); code(err) != "lead_admin_only" {
		t.Fatalf("lead demoted: %s", code(err))
	}
	u, err := st.UpdateMember(ctx, lead, boss.ID, domain.MemberInput{Name: "Real Lead", Designation: "Team Lead", TeamID: "t1"})
	if err != nil || !u.IsLead || u.Role != "Team Lead" {
		t.Fatalf("lead edit (omitted) lost flag: %v %+v", err, u)
	}
	u, err = st.UpdateMember(ctx, lead, boss.ID, domain.MemberInput{Name: "Real Lead", Designation: "Team Lead", TeamID: "t1", IsLead: &yes})
	if err != nil || !u.IsLead {
		t.Fatalf("lead edit (echoed) failed: %v %+v", err, u)
	}
	if _, err := st.UpdateMember(ctx, admin, plain.ID, domain.MemberInput{Name: "Plain Person", Designation: "Eng", TeamID: "t1", IsLead: &yes}); code(err) != "validation_failed" {
		t.Fatalf("second lead allowed: %s", code(err))
	}
	if _, err := st.UpdateMember(ctx, admin, boss.ID, domain.MemberInput{Name: "Real Lead", Designation: "Lead", TeamID: "t1", IsLead: &no}); err != nil {
		t.Fatalf("admin demote: %v", err)
	}
	if p, err := st.UpdateMember(ctx, admin, plain.ID, domain.MemberInput{Name: "Plain Person", Designation: "Eng", TeamID: "t1", IsLead: &yes}); err != nil || !p.IsLead {
		t.Fatalf("admin promote after the seat is free: %v %+v", err, p)
	}

	// Transfer: a lead can't move a lead to another team (their flag would travel).
	tr := domain.TransferInput{Mode: "team", ToTeamID: "t2", EffectiveDate: today(), Assignments: []domain.Assignment{{MemberID: plain.ID, ToSeatID: "B-1"}}}
	if _, err := st.CreateTransfer(ctx, lead, tr); code(err) != "lead_admin_only" {
		t.Fatalf("lead transferred a lead out: %s", code(err))
	}
	// ...but can still move a plain teammate out.
	tr.Assignments = []domain.Assignment{{MemberID: "m3", ToSeatID: "B-1"}}
	if _, err := st.CreateTransfer(ctx, lead, tr); err != nil {
		t.Fatalf("lead transfer plain member: %v", err)
	}
}
