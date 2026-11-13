package store

import (
	"context"
	"testing"
	"time"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/domain"
)

func TestRowLevelScoping(t *testing.T) {
	st, lead1 := setup(t)
	ctx := context.Background()
	lead2, admin, it := as(leadT2), as(adminU), as(itU)

	// A lead only sees their own team's people, whatever filter they send.
	ms, err := st.Members(ctx, lead1, MemberFilter{TeamID: "t2"})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range ms {
		if m.TeamID != "t1" {
			t.Fatalf("lead saw member of %s", m.TeamID)
		}
	}
	if _, err := st.Member(ctx, lead1, "m4"); code(err) != "not_found" {
		t.Errorf("lead read other team's member: %v", code(err))
	}
	for _, a := range []Actor{admin, it} {
		if all, _ := st.Members(ctx, a, MemberFilter{}); len(all) != 4 {
			t.Errorf("%s sees %d members, want 4", a.User.Role, len(all))
		}
	}

	// Lead one moves m1 internally; lead two must not see or undo it.
	res, err := st.CreateTransfer(ctx, lead1, domain.TransferInput{Mode: "internal", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m1", ToSeatID: "D-1"}}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Transfer.InitiatedByID != "lead_test" {
		t.Errorf("initiatedById = %q", res.Transfer.InitiatedByID)
	}
	if _, err := st.Transfer(ctx, lead2, res.Transfer.ID); code(err) != "not_found" {
		t.Errorf("lead2 read lead1's internal transfer: %v", code(err))
	}
	if _, err := st.CancelTransfer(ctx, lead2, res.Transfer.ID); code(err) != "not_found" {
		t.Errorf("lead2 undid lead1's transfer: %v", code(err))
	}
	if _, err := st.Transfer(ctx, it, res.Transfer.ID); err != nil {
		t.Errorf("IT can't read transfer: %v", err)
	}
	// Lead two cannot move lead one's people.
	if _, err := st.CreateTransfer(ctx, lead2, domain.TransferInput{Mode: "internal", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m2", ToSeatID: "D-2"}}}); err == nil {
		t.Error("lead2 moved a t1 member")
	}
	// Admin/IT have no team: they can't create transfers even if the route let them.
	if _, err := st.CreateTransfer(ctx, admin, domain.TransferInput{Mode: "internal", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m2", ToSeatID: "D-2"}}}); err == nil {
		t.Error("admin created a transfer")
	}

	// Workspaces are scoped too.
	ws, err := st.Workspace(ctx, lead2, "t1")
	if err != nil || ws.CurrentTeamID != "t2" {
		t.Fatalf("lead2 workspace pinned to own team: %v %q", err, ws.CurrentTeamID)
	}
	for _, m := range ws.Members {
		if m.TeamID != "t2" {
			t.Errorf("lead2 workspace leaks member %s", m.ID)
		}
	}
	if len(ws.Transfers) != 0 {
		t.Errorf("lead2 workspace leaks transfers: %d", len(ws.Transfers))
	}
	ws, err = st.Workspace(ctx, admin, "t2")
	if err != nil || ws.CurrentTeamID != "t2" || len(ws.Members) != 4 {
		t.Errorf("admin team switch: %v %q %d", err, ws.CurrentTeamID, len(ws.Members))
	}
	f, err := st.Floor(ctx, lead2, "flr_t")
	if err != nil {
		t.Fatal(err)
	}
	// Floors are visible to everyone; other teams' people show a name and team
	// but not their id or device count.
	for seat, o := range f.Occupants {
		if o.TeamID != "t2" && !o.IsLead && (o.Name == "" || o.MemberID != "" || o.Devices != 0 || o.Redacted) {
			t.Fatalf("lead2 sees the wrong detail for %s", seat)
		}
		if o.TeamID == "t2" && o.Name == "" {
			t.Fatalf("lead2 can't see their own person at %s", seat)
		}
	}
	if len(f.Occupants) != 4 {
		t.Errorf("occupants: %d", len(f.Occupants))
	}
}

func TestSessionsLockoutAndUsers(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	admin := as(adminU)
	now := time.Now()

	// Lockout: 5 free failures, then a 1 minute lock that doubles.
	var locked *time.Time
	for i := 0; i < 6; i++ {
		l, err := st.RecordLoginFailure(ctx, lead, "lead_test", now)
		if err != nil {
			t.Fatal(err)
		}
		if i < 4 && l != nil {
			t.Fatalf("locked after %d failures", i+1)
		}
		locked = l
	}
	if locked == nil || locked.Sub(now) != 2*time.Minute {
		t.Fatalf("expected 2m lock after 6 failures, got %v", locked)
	}

	// Sessions: valid, idle-expired, revoked by logout, revoked by disable.
	tok, hash, _ := auth.NewToken()
	_ = tok
	if err := st.CompleteLogin(ctx, lead, NewSession{TokenHash: hash, CSRFToken: "c", IP: "1", UserAgent: "ua",
		ExpiresAt: now.Add(time.Hour)}, "", ""); err != nil {
		t.Fatal(err)
	}
	acct, found, _ := st.AccountByEmail(ctx, "LEAD@example.com ")
	if !found || acct.FailedAttempts != 0 || acct.LockedUntil != nil {
		t.Errorf("login didn't reset lockout: %+v", acct)
	}
	p, err := st.SessionPrincipal(ctx, hash, time.Hour)
	if err != nil || p.User.ID != "lead_test" || p.User.TeamID != "t1" || p.CSRFToken != "c" {
		t.Fatalf("principal: %v %+v", err, p)
	}
	_, _ = st.db.Pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id=$1`, hash)
	if _, err := st.SessionPrincipal(ctx, hash, time.Hour); err != ErrNoSession {
		t.Errorf("idle session accepted: %v", err)
	}
	_, _ = st.db.Pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now(), expires_at = now() - interval '1 second' WHERE id=$1`, hash)
	if _, err := st.SessionPrincipal(ctx, hash, time.Hour); err != ErrNoSession {
		t.Errorf("expired session accepted: %v", err)
	}
	_, hash2, _ := auth.NewToken()
	_ = st.CompleteLogin(ctx, lead, NewSession{TokenHash: hash2, CSRFToken: "c", ExpiresAt: now.Add(time.Hour)}, "", "")
	if _, err := st.SetUserStatus(ctx, admin, "lead_test", false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SessionPrincipal(ctx, hash2, time.Hour); err != ErrNoSession {
		t.Errorf("disabled user's session still valid: %v", err)
	}
	if _, err := st.SetUserStatus(ctx, admin, "lead_test", true); err != nil {
		t.Fatal(err)
	}

	// User management guards.
	if _, err := st.SetUserStatus(ctx, admin, "usr_admin", false); code(err) != "self_action" {
		t.Errorf("admin disabled self: %v", code(err))
	}
	if err := st.DeleteUser(ctx, admin, "usr_admin"); code(err) != "self_action" {
		t.Errorf("admin deleted self: %v", code(err))
	}
	if _, err := st.db.Pool.Exec(ctx, `INSERT INTO teams (id, name, code, lead_name, location, sort_order) VALUES ('t3','Ops','OPS','','Floor 3',2)`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateUser(ctx, admin, domain.UserInput{Email: "second.lead@example.com", Name: "Second Lead", Role: "team_lead", TeamID: "t2"}, "h"); code(err) != "validation_failed" {
		t.Fatalf("second lead on t2: %s", code(err))
	}
	u, err := st.CreateUser(ctx, admin, domain.UserInput{Email: " New.Lead@Example.com", Name: "New Lead", Role: "team_lead", TeamID: "t3"}, "h")
	if err != nil || u.Email != "new.lead@example.com" || !u.MustChangePassword || u.TeamID != "t3" {
		t.Fatalf("create lead: %v %+v", err, u)
	}
	if _, err := st.CreateUser(ctx, admin, domain.UserInput{Email: "new.lead@example.com", Name: "Dup", Role: "it"}, "h"); code(err) != "validation_failed" {
		t.Errorf("duplicate email: %v", code(err))
	}
	if _, err := st.CreateUser(ctx, admin, domain.UserInput{Email: "x@example.com", Name: "No Team", Role: "team_lead"}, "h"); code(err) != "validation_failed" {
		t.Errorf("lead without team: %v", code(err))
	}
	itUser, err := st.CreateUser(ctx, admin, domain.UserInput{Email: "tech@example.com", Name: "Tech Two", Role: "it", TeamID: "t1"}, "h")
	if err != nil || itUser.TeamID != "" {
		t.Errorf("IT user should have no team: %v %+v", err, itUser)
	}
	// Promote the IT user to admin, then the original admin may be demoted only while another admin exists.
	v := itUser.Version
	if _, err := st.UpdateUser(ctx, admin, itUser.ID, domain.UserInput{Email: "tech@example.com", Name: "Tech Two", Role: "admin", ExpectedVersion: &v}); err != nil {
		t.Fatalf("promote: %v", err)
	}
	stale := 0
	if _, err := st.UpdateUser(ctx, admin, itUser.ID, domain.UserInput{Email: "tech@example.com", Name: "Tech", Role: "admin", ExpectedVersion: &stale}); code(err) != "stale_user" {
		t.Errorf("stale update: %v", code(err))
	}
	if err := st.DeleteUser(ctx, as(domain.User{ID: itUser.ID, Role: "admin", Name: "Tech Two"}), "usr_admin"); err != nil {
		t.Errorf("delete other admin while two exist: %v", err)
	}
	if _, err := st.SetUserStatus(ctx, admin, itUser.ID, false); code(err) != "last_admin" {
		t.Errorf("disabled the last admin: %v", code(err))
	}
	list, err := st.ListUsers(ctx)
	if err != nil || len(list) != 5 {
		t.Errorf("list users: %v %d", err, len(list))
	}
}
