package store

import (
	"context"
	"errors"
	"testing"

	"itdesk/backend/internal/domain"
)

// IT staff with their own login: an admin links a directory entry to an IT
// account; that person then sees what is routed to them, replies as
// themselves.
func TestITStaffLoginLinkAndAssignedChats(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	admin, it := as(adminU), as(itU)
	str := func(s string) *string { return &s }
	fieldErr := func(err error, f string) bool {
		var de *domain.Error
		return errors.As(err, &de) && de.Fields[f] != ""
	}
	mine, other := "its_abash_thapa", "its_akash_adhikari"

	// Linking is admin-only and must target an IT account.
	if _, err := st.UpdateITStaff(ctx, lead, mine, domain.ITStaffInput{UserID: str("usr_it")}); err == nil {
		t.Fatal("lead linked a login")
	}
	for _, uid := range []string{"usr_admin", "nope"} {
		if _, err := st.UpdateITStaff(ctx, admin, mine, domain.ITStaffInput{UserID: str(uid)}); !fieldErr(err, "userId") {
			t.Fatalf("link to %s: %v", uid, err)
		}
	}
	linked, err := st.UpdateITStaff(ctx, admin, mine, domain.ITStaffInput{UserID: str(" usr_it ")})
	if err != nil || !linked.HasLogin || linked.Login == nil || linked.Login.Email != "it@example.com" || linked.Login.Name != "Ivan Tech" {
		t.Fatalf("link: %+v %v", linked, err)
	}
	// One account, one person.
	if _, err := st.UpdateITStaff(ctx, admin, other, domain.ITStaffInput{UserID: str("usr_it")}); !fieldErr(err, "userId") {
		t.Fatalf("double link: %v", err)
	}
	// Leads see that someone has a login, not which account.
	dir, _ := st.ITStaffList(ctx, lead, false)
	for _, s := range dir {
		if s.Login != nil || s.HasLogin != (s.ID == mine) {
			t.Fatalf("lead directory entry: %+v", s)
		}
	}

	// Linked: they see their own conversations and reply as themselves.
	if _, err := st.PostChatMessage(ctx, lead, lead.User.ID, mine, "Hello", nil); err != nil {
		t.Fatal(err)
	}
	if l, _ := st.Chats(ctx, it, ChatFilter{}); len(l.Items) != 1 || l.MyStaffID == nil || *l.MyStaffID != mine {
		t.Fatalf("linked list: %+v", l)
	}
	if m, err := st.PostChatMessage(ctx, it, lead.User.ID, mine, "On it.", nil); err != nil || m.OnBehalf || m.SenderName != "Abash Thapa" {
		t.Fatalf("linked reply: %+v %v", m, err)
	}

	// Unlink.
	un, err := st.UpdateITStaff(ctx, admin, mine, domain.ITStaffInput{UserID: str("")})
	if err != nil || un.HasLogin || un.Login != nil {
		t.Fatalf("unlink: %+v %v", un, err)
	}
	if l, _ := st.Chats(ctx, it, ChatFilter{}); l.MyStaffID != nil {
		t.Fatalf("after unlink: %+v", l)
	}
	var n int
	_ = st.db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action IN ('it_staff.linked','it_staff.unlinked')`).Scan(&n)
	if n != 2 {
		t.Errorf("audited %d link changes, want 2", n)
	}
}
