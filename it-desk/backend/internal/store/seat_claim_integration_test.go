package store

import (
	"context"
	"sync"
	"testing"

	"itdesk/backend/internal/domain"
)

// A team lead may put a new person on a free seat with no zone: that one seat
// joins the lead's zone (published + draft), with audit and notifications.
func TestLeadClaimsUnzonedSeat(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	zoneOf := func(id string) string {
		var z *string
		if err := st.db.Pool.QueryRow(ctx, `SELECT team_id FROM floor_cells WHERE id = $1`, id).Scan(&z); err != nil {
			t.Fatal(err)
		}
		if z == nil {
			return ""
		}
		return *z
	}
	seat := "E-1"
	m, err := st.CreateMember(ctx, lead, domain.MemberInput{Name: "Claim Person", Designation: "Analyst", TeamID: "t1", SeatID: &seat})
	if err != nil || m.Seat == nil || *m.Seat != "E-1" {
		t.Fatalf("claim create: %v %+v", err, m)
	}
	if zoneOf("E-1") != "t1" || zoneOf("E-2") != "" {
		t.Fatalf("only E-1 should join t1: E-1=%q E-2=%q", zoneOf("E-1"), zoneOf("E-2"))
	}
	var draftTeam *string
	if err := st.db.Pool.QueryRow(ctx, `SELECT e->>'teamId' FROM floors, jsonb_array_elements(draft->'elements') e WHERE id = 'flr_t' AND e->>'id' = 'E-1'`).Scan(&draftTeam); err != nil || draftTeam == nil || *draftTeam != "t1" {
		t.Fatalf("draft not synced: %v %v", err, draftTeam)
	}
	var audits, notes int
	_ = st.db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action = 'seat.claimed'`).Scan(&audits)
	_ = st.db.Pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE title LIKE 'Seat E-1 claimed for %'`).Scan(&notes)
	if audits != 1 || notes < 2 {
		t.Fatalf("audit=%d notifications=%d", audits, notes)
	}
	// Leaving the seat keeps the zone.
	if _, err := st.AssignSeat(ctx, lead, m.ID, domain.SeatAssignInput{}); err != nil {
		t.Fatalf("unseat: %v", err)
	}
	if zoneOf("E-1") != "t1" {
		t.Fatal("zone should stay after the person leaves")
	}
	// Move seat to another unzoned seat also claims.
	e3 := "E-3"
	if _, err := st.AssignSeat(ctx, lead, m.ID, domain.SeatAssignInput{SeatID: &e3}); err != nil || zoneOf("E-3") != "t1" {
		t.Fatalf("move claim: %v zone=%q", err, zoneOf("E-3"))
	}
	// Still forbidden: another team's zone, an occupied seat, a non-seat.
	for name, c := range map[string]struct {
		seat, want string
	}{"other zone": {"B-1", "zone_scope"}, "occupied": {"E-3", "validation_failed"}, "door": {"door1", "validation_failed"}} {
		s := c.seat
		if _, err := st.CreateMember(ctx, lead, domain.MemberInput{Name: "No Way", Designation: "Analyst", TeamID: "t1", SeatID: &s}); code(err) != c.want {
			t.Errorf("%s: want %s, got %s", name, c.want, code(err))
		}
	}
	// Transfers don't claim.
	if zoneOf("E-8") != "" {
		t.Fatal("E-8 changed")
	}
}

// Two leads of different teams race for the same unzoned seat: one wins, the
// other gets 409 seat_taken (or the zone error if it read after the commit).
func TestClaimRace(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		seat := []string{"E-4", "E-5", "E-6", "E-7", "E-8"}[i]
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for j, a := range []Actor{lead, as(leadT2)} {
			team := []string{"t1", "t2"}[j]
			wg.Add(1)
			go func(j int, a Actor, team string) {
				defer wg.Done()
				s := seat
				_, errs[j] = st.CreateMember(ctx, a, domain.MemberInput{Name: "Race Person", Designation: "Analyst", TeamID: team, SeatID: &s})
			}(j, a, team)
		}
		wg.Wait()
		ok := 0
		for _, e := range errs {
			if e == nil {
				ok++
			} else if c := code(e); c != "seat_taken" && c != "zone_scope" {
				t.Errorf("%s loser: %v", seat, e)
			}
		}
		if ok != 1 {
			t.Fatalf("%s: want exactly one winner, got %d (%v)", seat, ok, errs)
		}
		var n int
		_ = st.db.Pool.QueryRow(ctx, `SELECT count(*) FROM members WHERE seat_id = $1 AND status = 'active'`, seat).Scan(&n)
		if n != 1 {
			t.Fatalf("%s holders: %d", seat, n)
		}
	}
}
