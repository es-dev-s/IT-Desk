package store

import (
	"context"
	"errors"
	"testing"

	"itdesk/backend/internal/domain"
)

// IT staff with their own login: an admin links a directory entry to an IT
// account; that person then sees what is routed to them, replies as
// themselves, and their unread badge covers their own and unrouted chats.
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

	item := []domain.ITRequestItem{{Kind: "laptop", Quantity: 1}}
	rMine, _ := st.CreateITRequest(ctx, lead, domain.ITRequestInput{Items: item, Notes: "For Abash", Priority: "normal", StaffID: mine})
	rOther, _ := st.CreateITRequest(ctx, lead, domain.ITRequestInput{Items: item, Notes: "For Akash", Priority: "normal", StaffID: other})
	rNone, err := st.CreateITRequest(ctx, lead, domain.ITRequestInput{Items: item, Notes: "Anyone", Priority: "normal"})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{rMine.ID, rOther.ID, rNone.ID} {
		if _, err := st.PostChatMessage(ctx, lead, id, "Hello IT", "", nil); err != nil {
			t.Fatal(err)
		}
	}

	// "Assigned to me".
	list, err := st.Chats(ctx, it, ChatFilter{Assigned: "me"})
	if err != nil || len(list.Items) != 1 || list.Items[0].Request.ID != rMine.ID || list.MyStaffID == nil || *list.MyStaffID != mine {
		t.Fatalf("assigned to me: %+v %v", list, err)
	}
	if all, _ := st.Chats(ctx, it, ChatFilter{}); len(all.Items) != 3 {
		t.Fatalf("linked IT still sees every IT conversation: %d", len(all.Items))
	}
	if none, _ := st.Chats(ctx, it, ChatFilter{Assigned: "none"}); len(none.Items) != 1 || none.Items[0].Request.ID != rNone.ID {
		t.Fatalf("unassigned filter: %+v", none.Items)
	}
	if adm, _ := st.Chats(ctx, admin, ChatFilter{Assigned: "me"}); len(adm.Items) != 0 || adm.MyStaffID != nil {
		t.Fatalf("admin without a staff entry: %+v", adm)
	}
	if _, err := st.Chats(ctx, it, ChatFilter{Assigned: "bogus"}); err == nil {
		t.Fatal("bad assigned filter accepted")
	}

	// Unread: theirs + unrouted for the linked person; everything for admin.
	if u, _ := st.ChatUnread(ctx, it); u.UnreadChats != 2 || u.Unread != 2 {
		t.Fatalf("linked IT unread: %+v", u)
	}
	if u, _ := st.ChatUnread(ctx, admin); u.UnreadChats != 3 {
		t.Fatalf("admin unread: %+v", u)
	}

	// Replying as themselves, no "on behalf".
	m, err := st.PostChatMessage(ctx, it, rMine.ID, "On it.", "", nil)
	if err != nil || m.Side != "it" || m.SenderName != "Abash Thapa" || m.OnBehalf || !m.Mine || m.StaffID == nil || *m.StaffID != mine {
		t.Fatalf("linked reply: %+v %v", m, err)
	}
	th, _ := st.ChatMessages(ctx, lead, rMine.ID, "")
	if got := th.Messages[len(th.Messages)-1]; got.SenderName != "Abash Thapa" || got.OnBehalf || got.Mine {
		t.Fatalf("requester view: %+v", got)
	}
	// Admin replying on Abash's ticket is still "on behalf".
	if m, err := st.PostChatMessage(ctx, admin, rMine.ID, "Cc admin", "it", nil); err != nil || m.SenderName != "Abash Thapa" || !m.OnBehalf {
		t.Fatalf("admin on behalf: %+v %v", m, err)
	}

	// Unlink.
	un, err := st.UpdateITStaff(ctx, admin, mine, domain.ITStaffInput{UserID: str("")})
	if err != nil || un.HasLogin || un.Login != nil {
		t.Fatalf("unlink: %+v %v", un, err)
	}
	if l, _ := st.Chats(ctx, it, ChatFilter{Assigned: "me"}); len(l.Items) != 0 || l.MyStaffID != nil {
		t.Fatalf("after unlink: %+v", l)
	}
	var n int
	_ = st.db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action IN ('it_staff.linked','it_staff.unlinked')`).Scan(&n)
	if n != 2 {
		t.Errorf("audited %d link changes, want 2", n)
	}
}
