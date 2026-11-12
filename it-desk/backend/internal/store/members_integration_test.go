package store

import (
	"context"
	"testing"

	"itdesk/backend/internal/domain"
)

func TestCreateAndUpdateMember(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	seat := "C-1"
	in := domain.MemberInput{Name: "Nina Gurung", EmployeeID: "EMP-77", Designation: "QA Engineer", TeamID: "t1", SeatID: &seat,
		Devices: []domain.DeviceInput{{Kind: "laptop", Model: "ThinkPad", AssetTag: "IT-LP-0500"}, {Kind: "monitor", Model: "Dell 27", AssetTag: "IT-MN-0501"}}}
	m, err := st.CreateMember(ctx, lead, in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if m.Email != "" || m.EmployeeID != "EMP-77" || m.Seat == nil || *m.Seat != "C-1" || len(m.Devices) != 2 || m.Status != "active" {
		t.Fatalf("created member: %+v", m)
	}

	// A lead can't add to another team.
	other := in
	other.TeamID, other.SeatID, other.EmployeeID, other.Devices = "t2", nil, "", nil
	if _, err := st.CreateMember(ctx, lead, other); code(err) != "forbidden" && code(err) != "team_scope" {
		t.Fatalf("cross-team create: %s", code(err))
	}
	// Taken seat, reserved seat, someone else's asset tag, duplicate employee ID.
	for name, mod := range map[string]func(*domain.MemberInput){
		"seat taken":   func(x *domain.MemberInput) { s := "A-1"; x.SeatID = &s },
		"unknown seat": func(x *domain.MemberInput) { s := "Z-99"; x.SeatID = &s },
		"asset tag": func(x *domain.MemberInput) {
			x.Devices = []domain.DeviceInput{{Kind: "laptop", Model: "MBP", AssetTag: "IT-LP-0001"}}
		},
		"employee id": func(x *domain.MemberInput) { x.EmployeeID = "emp-77" },
	} {
		x := domain.MemberInput{Name: "Dup Person", Designation: "Analyst", TeamID: "t1"}
		mod(&x)
		if _, err := st.CreateMember(ctx, lead, x); code(err) != "validation_failed" {
			t.Errorf("%s: want validation_failed, got %s", name, code(err))
		}
	}

	// Seats outside the lead's own zone are refused with 403 zone_scope.
	for _, s := range []string{"B-1"} {
		x := domain.MemberInput{Name: "Zone Person", Designation: "Analyst", TeamID: "t1", SeatID: &s}
		if _, err := st.CreateMember(ctx, lead, x); code(err) != "zone_scope" {
			t.Errorf("seat %s: want zone_scope, got %s", s, code(err))
		}
	}

	// Edit: keep the laptop (same id, new model), drop the monitor, add a dock, move desk.
	seat2 := "C-2"
	v := m.Version
	upd := domain.MemberInput{Name: "Nina Gurung", EmployeeID: "EMP-77", Email: "nina@example.com", Designation: "Senior QA", TeamID: "t1", SeatID: &seat2, ExpectedVersion: &v,
		Devices: []domain.DeviceInput{{ID: m.Devices[0].ID, Kind: "laptop", Model: "ThinkPad X1", AssetTag: "IT-LP-0500"}, {Kind: "dock", Model: "TB4", AssetTag: "IT-DK-0502"}}}
	u, err := st.UpdateMember(ctx, lead, m.ID, upd)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if u.Role != "Senior QA" || *u.Seat != "C-2" || len(u.Devices) != 2 || u.Devices[0].ID != m.Devices[0].ID || u.Devices[0].Model != "ThinkPad X1" || u.Version != v+1 {
		t.Fatalf("updated member: %+v", u)
	}
	// Stale version is refused.
	if _, err := st.UpdateMember(ctx, lead, m.ID, upd); code(err) != "stale_member" {
		t.Fatalf("stale update: %s", code(err))
	}
	// Another team's lead can't see / edit it; admin can move it across teams.
	if _, err := st.UpdateMember(ctx, as(leadT2), m.ID, domain.MemberInput{Name: "X Y", Designation: "Analyst", TeamID: "t2"}); code(err) != "not_found" {
		t.Fatalf("other lead edit: %s", code(err))
	}
	upd.ExpectedVersion, upd.TeamID, upd.SeatID = nil, "t2", nil
	a, err := st.UpdateMember(ctx, as(adminU), m.ID, upd)
	if err != nil || a.TeamID != "t2" || a.Seat != nil {
		t.Fatalf("admin move: %v %+v", err, a)
	}
	// The admin may seat anyone anywhere (even outside their team's zone).
	e8 := "E-8"
	if a, err = st.AssignSeat(ctx, as(adminU), m.ID, domain.SeatAssignInput{SeatID: &e8}); err != nil || a.Seat == nil || *a.Seat != "E-8" {
		t.Fatalf("admin seat: %v %+v", err, a)
	}
}
