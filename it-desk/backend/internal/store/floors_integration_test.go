package store

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"itdesk/backend/internal/domain"
)

func ptr[T any](v T) *T { return &v }

// seatIDs maps code -> element id for a published floor.
func seatIDs(t *testing.T, st *Store, id string) map[string]string {
	t.Helper()
	f, err := st.Floor(context.Background(), as(adminU), id)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range f.Elements {
		if e.Kind == domain.KindSeat {
			out[e.Code] = e.ID
		}
	}
	return out
}

func seatOf(t *testing.T, st *Store, memberID string) string {
	t.Helper()
	m, err := st.Member(context.Background(), as(adminU), memberID)
	if err != nil {
		t.Fatal(err)
	}
	if m.Seat == nil {
		return ""
	}
	return *m.Seat
}

func TestFloorTemplateSeatsAndZoneMove(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	admin, it := as(adminU), as(itU)

	if _, err := st.CreateFloor(ctx, lead, domain.FloorInput{Name: ptr("Nope"), Template: "facing-rows", TemplateSeats: 4}); code(err) != "forbidden" {
		t.Fatalf("lead created a floor: %s", code(err))
	}
	sum, err := st.CreateFloor(ctx, admin, domain.FloorInput{Name: ptr("Level 2"), Level: ptr(2), SeatPrefix: ptr("L2-"),
		Template: "facing-rows", TemplateSeats: 4, Publish: true})
	if err != nil || sum.Status != "published" || sum.Stats.Seats != 8 {
		t.Fatalf("create+publish: %v %+v", err, sum)
	}
	ids := seatIDs(t, st, sum.ID)
	if ids["1"] == "" || ids["8"] == "" {
		t.Fatalf("auto-numbering: %v", ids)
	}
	for team, row := range map[string]int{"t1": 0, "t2": 4} {
		codes := []string{fmt.Sprint(row + 1), fmt.Sprint(row + 2), fmt.Sprint(row + 3), fmt.Sprint(row + 4)}
		if _, err := st.AssignZone(ctx, admin, sum.ID, domain.ZoneInput{TeamID: ptr(team), Codes: codes}); err != nil {
			t.Fatalf("zone %s: %v", team, err)
		}
	}
	if _, err := st.AssignZone(ctx, lead, sum.ID, domain.ZoneInput{TeamID: ptr("t1"), Codes: []string{"5"}}); code(err) != "forbidden" {
		t.Errorf("lead painted a zone: %s", code(err))
	}

	// Seating: the lead within their own zone only; IT never.
	if _, err := st.AssignSeat(ctx, lead, "m1", domain.SeatAssignInput{SeatID: ptr(ids["1"])}); err != nil {
		t.Fatalf("lead seat in zone: %v", err)
	}
	if _, err := st.AssignSeat(ctx, lead, "m2", domain.SeatAssignInput{SeatID: ptr(ids["5"])}); code(err) != "zone_scope" {
		t.Errorf("lead seat outside zone: %s", code(err))
	}
	if _, err := st.AssignSeat(ctx, it, "m2", domain.SeatAssignInput{SeatID: ptr(ids["3"])}); code(err) != "forbidden" {
		t.Errorf("IT seated someone: %s", code(err))
	}
	if _, err := st.AssignSeat(ctx, lead, "m4", domain.SeatAssignInput{SeatID: ptr(ids["3"])}); code(err) != "not_found" {
		t.Errorf("lead seated another team's person: %s", code(err))
	}
	// Two people, one seat, at the same time: exactly one wins.
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, m := range []string{"m2", "m3"} {
		wg.Add(1)
		go func(i int, m string) {
			defer wg.Done()
			_, errs[i] = st.AssignSeat(ctx, lead, m, domain.SeatAssignInput{SeatID: ptr(ids["2"])})
		}(i, m)
	}
	wg.Wait()
	if (errs[0] == nil) == (errs[1] == nil) {
		t.Fatalf("double booking: %v / %v", errs[0], errs[1])
	}
	// The admin seats a t2 person on t2's zone of the new floor.
	if _, err := st.AssignSeat(ctx, admin, "m4", domain.SeatAssignInput{SeatID: ptr(ids["6"])}); err != nil {
		t.Fatalf("admin seat: %v", err)
	}

	// Move t1's whole zone off the test floor onto row B of Level 2, where m4 sits.
	move := domain.ZoneMoveInput{TeamID: "t1", FromFloorID: "flr_t",
		ToSeatIDs: []string{ids["5"], ids["6"], ids["7"], ids["8"]}, Carry: ptr(true)}
	if _, err := st.MoveZone(ctx, lead, move); code(err) != "forbidden" {
		t.Errorf("lead moved a zone: %s", code(err))
	}
	_, err = st.MoveZone(ctx, admin, move)
	var de *domain.Error
	if code(err) != "zone_conflict" || !asErr(err, &de) || de.Fields["member.m4"] == "" {
		t.Fatalf("want zone_conflict naming m4, got %v", err)
	}
	move.DryRun, move.OnConflict = true, "relocate"
	dry, err := st.MoveZone(ctx, admin, move)
	if err != nil || !dry.DryRun || len(dry.Affected) < 2 {
		t.Fatalf("dry run: %v %+v", err, dry)
	}
	if seatOf(t, st, "m4") != "6" {
		t.Fatal("dry run changed data")
	}
	move.DryRun = false
	res, err := st.MoveZone(ctx, admin, move)
	if err != nil || res.ID == "" || res.UndoExpiresAt == nil {
		t.Fatalf("move: %v %+v", err, res)
	}
	actions := map[string]string{}
	for _, a := range res.Affected {
		actions[a.MemberID] = a.Action
	}
	if actions["m4"] != "relocate" {
		t.Errorf("m4 action: %+v", res.Affected)
	}
	if s := seatOf(t, st, "m4"); len(s) != 3 || s[0] != 'B' {
		t.Errorf("m4 not relocated into t2's zone: %q", s)
	}
	carried := 0
	for _, m := range []string{"m2", "m3"} {
		if s := seatOf(t, st, m); s >= "5" && s <= "8" && len(s) == 1 {
			carried++
		} else if s != "2" {
			t.Errorf("%s left at %q", m, s)
		}
	}
	if carried != 1 {
		t.Errorf("carried %d people, want 1", carried)
	}
	if f, _ := st.Floor(ctx, admin, "flr_t"); f.Stats.ByTeam["t1"] != 0 || f.Stats.ByTeam["t2"] != 8 {
		t.Errorf("old floor zones: %+v", f.Stats.ByTeam)
	}
	var n int
	_ = st.db.Pool.QueryRow(ctx, `SELECT count(DISTINCT recipient_id) FROM notifications WHERE kind = 'floor.seats' AND recipient_id IN ('lead_test','lead_two','usr_it')`).Scan(&n)
	if n != 3 {
		t.Errorf("floor.seats notified %d of lead_test, lead_two, usr_it", n)
	}

	// Undo restores zones and seats.
	if err := st.UndoZoneChange(ctx, admin, res.ID); err != nil {
		t.Fatalf("undo: %v", err)
	}
	if seatOf(t, st, "m4") != "6" {
		t.Errorf("m4 not restored: %q", seatOf(t, st, "m4"))
	}
	if f, _ := st.Floor(ctx, admin, "flr_t"); f.Stats.ByTeam["t1"] != 24 {
		t.Errorf("zones not restored: %+v", f.Stats.ByTeam)
	}
	if err := st.UndoZoneChange(ctx, admin, res.ID); code(err) != "already_undone" {
		t.Errorf("double undo: %s", code(err))
	}
}

func TestPublishReconcilesAndFloorAdmin(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	admin := as(adminU)

	if _, err := st.Draft(ctx, lead, "flr_t"); code(err) != "forbidden" {
		t.Errorf("lead read a draft: %s", code(err))
	}
	d, err := st.SaveDraft(ctx, admin, "flr_t", domain.DraftInput{Delete: []string{"A-2"}}, true)
	if err != nil || !d.Dirty {
		t.Fatalf("patch draft: %v %+v", err, d)
	}
	// Leads still see the live floor until it is published.
	if f, _ := st.Floor(ctx, lead, "flr_t"); f.Stats.Seats != 40 {
		t.Errorf("draft leaked into the live floor: %d", f.Stats.Seats)
	}
	if _, err := st.PublishFloor(ctx, admin, "flr_t", domain.PublishInput{}); code(err) != "zone_conflict" {
		t.Fatalf("publish over an occupied seat: %v", err)
	}
	res, err := st.PublishFloor(ctx, admin, "flr_t", domain.PublishInput{OnConflict: "relocate"})
	if err != nil || res.Removed != 1 || len(res.Affected) != 1 || res.Affected[0].MemberID != "m2" {
		t.Fatalf("publish relocate: %v %+v", err, res)
	}
	if s := seatOf(t, st, "m2"); s == "" || s == "A-2" {
		t.Errorf("m2 not relocated: %q", s)
	}
	if f, _ := st.Floor(ctx, lead, "flr_t"); f.Status != "published" || f.Stats.Seats != 39 {
		t.Errorf("published floor: %s %d", f.Status, f.Stats.Seats)
	}
	if err := st.DeleteFloor(ctx, admin, "flr_t"); code(err) != "floor_occupied" {
		t.Errorf("delete occupied floor: %s", code(err))
	}
	dup, err := st.DuplicateFloor(ctx, admin, "flr_t", "Test Floor copy", false)
	if err != nil || dup.Status == "published" {
		t.Fatalf("duplicate: %v %+v", err, dup)
	}
	list, _ := st.Floors(ctx, lead)
	for _, f := range list {
		if f.ID == dup.ID {
			t.Error("lead sees an unpublished floor")
		}
	}
	if err := st.DeleteFloor(ctx, admin, dup.ID); err != nil {
		t.Errorf("delete empty draft floor: %v", err)
	}
}

func asErr(err error, de **domain.Error) bool {
	e, ok := err.(*domain.Error)
	if ok {
		*de = e
	}
	return ok
}

func TestSeatCodesRenumberLive(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	admin := as(adminU)
	sum, err := st.CreateFloor(ctx, admin, domain.FloorInput{Name: ptr("Level 7"), Level: ptr(7), SeatPrefix: ptr("L7-"),
		Template: "facing-rows", TemplateSeats: 3, Publish: true})
	if err != nil {
		t.Fatal(err)
	}
	ids := seatIDs(t, st, sum.ID)
	if _, err := st.AssignSeat(ctx, admin, "m1", domain.SeatAssignInput{SeatID: ptr(ids["1"])}); err != nil {
		t.Fatal(err)
	}
	set := func(a Actor, ch ...domain.SeatCodeChange) (domain.SeatCodesResult, error) {
		return st.SetSeatCodes(ctx, a, sum.ID, domain.SeatCodesInput{Changes: ch})
	}
	if _, err := set(lead, domain.SeatCodeChange{SeatID: ids["1"], Code: "X1"}); code(err) != "forbidden" {
		t.Errorf("lead renumbered: %s", code(err))
	}
	// Swap A01 <-> A02 in one call, and give A03 its physical number.
	res, err := set(admin, domain.SeatCodeChange{SeatID: ids["1"], Code: "2"},
		domain.SeatCodeChange{SeatID: ids["2"], Code: "1"}, domain.SeatCodeChange{SeatID: ids["3"], Code: "desk-117"})
	if err != nil || len(res.Changed) != 3 {
		t.Fatalf("swap: %v %+v", err, res)
	}
	now := seatIDs(t, st, sum.ID)
	if now["2"] != ids["1"] || now["DESK-117"] != ids["3"] {
		t.Fatalf("codes after swap: %v", now)
	}
	if got := seatOf(t, st, "m1"); got != "2" {
		t.Errorf("member shows %q, want the new number L7-A02 (same seat id)", got)
	}
	// Taken by a seat that is not being changed → 409 with a friendly message.
	_, err = set(admin, domain.SeatCodeChange{SeatID: ids["4"], Code: "5"})
	var de *domain.Error
	if code(err) != "seat_code_taken" || !asErr(err, &de) || de.Status != 409 {
		t.Fatalf("want 409 seat_code_taken, got %v", err)
	}
	if _, err := set(admin, domain.SeatCodeChange{SeatID: ids["4"], Code: "bad code"}); code(err) != "validation_failed" {
		t.Errorf("bad code: %s", code(err))
	}
	// The draft mirrors the numbers, so a later publish keeps them.
	d, err := st.Draft(ctx, admin, sum.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range d.Elements {
		if e.ID == ids["3"] && (e.Code != "DESK-117" || !e.CodeLocked) {
			t.Errorf("draft not synced: %+v", e)
		}
	}
}

// Big grids (up to 200x200) and resizing a live floor without losing elements.
func TestBigGridResizeKeepsElements(t *testing.T) {
	st, _ := setup(t)
	ctx := context.Background()
	admin := as(adminU)
	sum, err := st.CreateFloor(ctx, admin, domain.FloorInput{Name: ptr("Hall"), Level: ptr(9), SeatPrefix: ptr("H-"), Cols: ptr(180), Rows: ptr(150)})
	if err != nil {
		t.Fatalf("create 180x150: %v", err)
	}
	if _, err := st.CreateFloor(ctx, admin, domain.FloorInput{Name: ptr("Too big"), Cols: ptr(201), Rows: ptr(10)}); code(err) != "validation_failed" {
		t.Errorf("201 cols: %s", code(err))
	}
	els := []domain.FloorElement{
		{ID: "s1", Kind: domain.KindSeat, X: 0, Y: 0, W: 1, H: 1, Code: "H-A01"},
		{ID: "s2", Kind: domain.KindSeat, X: 179, Y: 149, W: 1, H: 1, Code: "H-Z99"},
		{ID: "b1", Kind: domain.KindBlock, X: 2, Y: 2, W: 170, H: 3},
	}
	if _, err := st.SaveDraft(ctx, admin, sum.ID, domain.DraftInput{Elements: els}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PublishFloor(ctx, admin, sum.ID, domain.PublishInput{}); err != nil {
		t.Fatalf("publish 180x150: %v", err)
	}
	// Grow the live floor to the maximum, then shrink below the far seat.
	if _, err := st.SaveDraft(ctx, admin, sum.ID, domain.DraftInput{Cols: ptr(200), Rows: ptr(200)}, true); err != nil {
		t.Fatalf("grow to 200x200: %v", err)
	}
	d, err := st.SaveDraft(ctx, admin, sum.ID, domain.DraftInput{Cols: ptr(100), Rows: ptr(100)}, true)
	if err != nil {
		t.Fatalf("shrink draft: %v", err)
	}
	if len(d.Elements) != 3 {
		t.Fatalf("shrinking dropped elements: %d left", len(d.Elements))
	}
	if _, err := st.PublishFloor(ctx, admin, sum.ID, domain.PublishInput{}); code(err) != "validation_failed" {
		t.Fatalf("publishing with a seat off the grid: %s", code(err))
	}
	if _, err := st.SaveDraft(ctx, admin, sum.ID, domain.DraftInput{Cols: ptr(200), Rows: ptr(200)}, true); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PublishFloor(ctx, admin, sum.ID, domain.PublishInput{}); err != nil {
		t.Fatalf("publish 200x200: %v", err)
	}
	f, err := st.Floor(ctx, admin, sum.ID)
	if err != nil {
		t.Fatal(err)
	}
	if f.Cols != 200 || f.Rows != 200 || len(seatIDs(t, st, sum.ID)) != 2 {
		t.Errorf("published %dx%d with %d seats", f.Cols, f.Rows, len(seatIDs(t, st, sum.ID)))
	}
}

func TestDiscardDraft(t *testing.T) {
	st, _ := setup(t)
	ctx := context.Background()
	admin := as(adminU)
	sum, err := st.CreateFloor(ctx, admin, domain.FloorInput{Name: ptr("Annex"), Level: ptr(8), SeatPrefix: ptr("X-"), Cols: ptr(6), Rows: ptr(4)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.DiscardDraft(ctx, admin, sum.ID); code(err) != "bad_request" {
		t.Errorf("discard before first publish: %s", code(err))
	}
	els := []domain.FloorElement{
		{ID: "s1", Kind: domain.KindSeat, X: 0, Y: 0, W: 1, H: 1, Code: "X-1"},
		{ID: "s2", Kind: domain.KindSeat, X: 1, Y: 0, W: 1, H: 1, Code: "X-2"},
	}
	if _, err := st.SaveDraft(ctx, admin, sum.ID, domain.DraftInput{Elements: els}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PublishFloor(ctx, admin, sum.ID, domain.PublishInput{}); err != nil {
		t.Fatal(err)
	}
	d, err := st.SaveDraft(ctx, admin, sum.ID, domain.DraftInput{Cols: ptr(9), Delete: []string{"s2"},
		Upsert: []domain.FloorElement{{ID: "s1", Kind: domain.KindSeat, X: 4, Y: 3, W: 1, H: 1, Code: "99", CodeLocked: true}}}, true)
	if err != nil || !d.Dirty {
		t.Fatalf("edit draft: dirty=%v err=%v", d.Dirty, err)
	}
	d, err = st.DiscardDraft(ctx, admin, sum.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Dirty || d.Cols != 6 || len(d.Elements) != 2 {
		t.Fatalf("after discard: dirty=%v cols=%d elements=%d", d.Dirty, d.Cols, len(d.Elements))
	}
	for _, e := range d.Elements {
		if e.ID == "s1" && (e.Code != "X-1" || e.X != 0 || !e.CodeLocked) {
			t.Errorf("s1 not restored: %+v", e)
		}
	}
	if _, err := st.DiscardDraft(ctx, as(itU), sum.ID); err == nil {
		t.Error("IT could discard a draft")
	}
}
