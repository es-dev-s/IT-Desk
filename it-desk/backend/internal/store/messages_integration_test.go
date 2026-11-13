package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"itdesk/backend/internal/domain"
)

func TestRequestChatScopingUnreadAndStaff(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	lead2, admin, it := as(leadT2), as(adminU), as(itU)
	clock := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	st.Now = func() time.Time { clock = clock.Add(time.Second); return clock }

	staff := "its_akash_adhikari"
	r1, err := st.CreateITRequest(ctx, lead, domain.ITRequestInput{Items: []domain.ITRequestItem{{Kind: "laptop", Quantity: 1}}, Notes: "New joiner laptop", Priority: "normal", StaffID: staff})
	if err != nil {
		t.Fatal(err)
	}
	r2, err := st.CreateITRequest(ctx, lead2, domain.ITRequestInput{Items: []domain.ITRequestItem{{Kind: "mouse", Quantity: 1}}, Notes: "Mouse is broken", Priority: "low"})
	if err != nil {
		t.Fatal(err)
	}

	// Team scoping: the other team's conversation does not exist for a lead.
	if _, err := st.PostChatMessage(ctx, lead, r2.ID, "hello", "", nil); !errors.Is(err, errRequestNotFound) {
		t.Fatalf("lead posting on another team's request: %v", err)
	}
	if _, err := st.ChatMessages(ctx, lead, r2.ID, ""); !errors.Is(err, errRequestNotFound) {
		t.Fatalf("lead reading another team's chat: %v", err)
	}
	if _, err := st.MarkChatRead(ctx, lead, r2.ID); !errors.Is(err, errRequestNotFound) {
		t.Fatalf("lead marking another team's chat: %v", err)
	}
	list, err := st.Chats(ctx, lead, ChatFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].Request.ID != r1.ID {
		t.Fatalf("lead chats: %+v", list.Items)
	}

	// Requester → IT.
	m1, err := st.PostChatMessage(ctx, lead, r1.ID, "  Hi Akash,\r\n\r\n\r\n\r\n\r\nwhen can we expect it?  ", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if m1.Side != "requester" || m1.SenderName != "Lead One" || !m1.Mine || m1.StaffID != nil || m1.Body != "Hi Akash,\n\n\nwhen can we expect it?" {
		t.Fatalf("requester message: %+v", m1)
	}
	if _, err := st.PostChatMessage(ctx, lead, r1.ID, "x", "it", nil); !errors.Is(err, errChatSide) {
		t.Fatalf("lead posting as IT: %v", err)
	}
	if _, err := st.PostChatMessage(ctx, it, r1.ID, "x", "requester", nil); !errors.Is(err, errChatSide) {
		t.Fatalf("IT posting as requester: %v", err)
	}
	for _, c := range []struct {
		who  Actor
		want int
	}{{it, 1}, {admin, 1}, {lead, 0}, {lead2, 0}} {
		u, err := st.ChatUnread(ctx, c.who)
		if err != nil || u.Unread != c.want {
			t.Errorf("%s unread = %+v %v, want %d", c.who.User.Email, u, err, c.want)
		}
	}

	// IT → requester, shown as the routed staff member, written by Ivan.
	m2, err := st.PostChatMessage(ctx, it, r1.ID, "Tomorrow morning.", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if m2.Side != "it" || m2.SenderName != "Akash Adhikari" || m2.StaffID == nil || *m2.StaffID != staff || !m2.OnBehalf || m2.AuthorName != "Ivan Tech" {
		t.Fatalf("IT message: %+v", m2)
	}
	if u, _ := st.ChatUnread(ctx, it); u.Unread != 0 {
		t.Errorf("replying marks IT's side read: %+v", u)
	}
	if u, _ := st.ChatUnread(ctx, lead); u.Unread != 1 || u.UnreadChats != 1 {
		t.Errorf("lead unread after reply: %+v", u)
	}
	th, err := st.ChatMessages(ctx, lead, r1.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(th.Messages) != 2 || th.Messages[0].ID != m1.ID || th.Thread.Unread != 1 || th.Thread.Side != "requester" || th.Thread.LastMessage == nil || th.Thread.LastMessage.ID != m2.ID {
		t.Fatalf("thread: %+v", th)
	}
	if th.Thread.OtherReadAt == nil {
		t.Errorf("IT read it when replying: otherReadAt should be set")
	}
	after, err := st.ChatMessages(ctx, lead, r1.ID, m1.ID)
	if err != nil || len(after.Messages) != 1 || after.Messages[0].ID != m2.ID {
		t.Fatalf("poll after m1: %+v %v", after.Messages, err)
	}
	if u, err := st.MarkChatRead(ctx, lead, r1.ID); err != nil || u.Unread != 0 {
		t.Fatalf("mark read: %+v %v", u, err)
	}

	// Admin: IT side by default on others' requests, may speak for the requester.
	m3, err := st.PostChatMessage(ctx, admin, r1.ID, "Adding the dock too.", "requester", nil)
	if err != nil || m3.Side != "requester" || m3.SenderName != "Ada Admin" {
		t.Fatalf("admin as requester: %+v %v", m3, err)
	}
	m4, err := st.PostChatMessage(ctx, admin, r1.ID, "Noted.", "", nil)
	if err != nil || m4.Side != "it" || m4.SenderName != "Akash Adhikari" {
		t.Fatalf("admin default side: %+v %v", m4, err)
	}

	// Unrouted request: IT replies as "IT team"; once Ivan's account is linked
	// to a directory entry, he speaks as himself.
	if _, err := st.PostChatMessage(ctx, it, r2.ID, "Which desk?", "", nil); err != nil {
		t.Fatal(err)
	}
	th2, _ := st.ChatMessages(ctx, lead2, r2.ID, "")
	if got := th2.Messages[0]; got.SenderName != "IT team" || got.StaffID != nil || got.OnBehalf {
		t.Fatalf("unrouted IT message: %+v", got)
	}
	if _, err := st.db.Pool.Exec(ctx, `UPDATE it_staff SET user_id = 'usr_it' WHERE id = 'its_abash_thapa'`); err != nil {
		t.Fatal(err)
	}
	m5, err := st.PostChatMessage(ctx, it, r1.ID, "On my way.", "", nil)
	if err != nil || m5.SenderName != "Abash Thapa" || m5.OnBehalf {
		t.Fatalf("linked staff message: %+v %v", m5, err)
	}

	// Filters and ordering.
	all, _ := st.Chats(ctx, admin, ChatFilter{})
	if len(all.Items) != 2 || all.Items[0].Request.ID != r1.ID {
		t.Fatalf("admin chats (latest activity first): %+v", all.Items)
	}
	if closed, _ := st.Chats(ctx, admin, ChatFilter{Status: "closed"}); len(closed.Items) != 0 {
		t.Errorf("closed filter: %d", len(closed.Items))
	}
	if found, _ := st.Chats(ctx, admin, ChatFilter{Query: "which desk"}); len(found.Items) != 1 || found.Items[0].Request.ID != r2.ID {
		t.Errorf("search by message body: %+v", found.Items)
	}
	if _, err := st.Chats(ctx, admin, ChatFilter{Status: "bogus"}); err == nil {
		t.Errorf("bad status filter accepted")
	}

	// Validation.
	for _, body := range []string{"", "   \n ", string(make([]rune, domain.MaxMessageBody+1))} {
		if _, err := st.PostChatMessage(ctx, lead, r1.ID, body, "", nil); err == nil {
			t.Errorf("accepted body of %d runes", len([]rune(body)))
		}
	}
	var audits int
	_ = st.db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action = 'it_request.message'`).Scan(&audits)
	if audits != 6 {
		t.Errorf("audited %d messages, want 6", audits)
	}
}

// One lead raising several requests has a single conversation holding all of
// them, each message tagged with its own REQ id; another lead stays separate.
func TestChatConsolidatesRequestsPerLead(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	lead2, admin := as(leadT2), as(adminU)
	clock := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	st.Now = func() time.Time { clock = clock.Add(time.Second); return clock }
	item := []domain.ITRequestItem{{Kind: "mouse", Quantity: 1}}
	var ids []string
	for i := 0; i < 3; i++ {
		r, err := st.CreateITRequest(ctx, lead, domain.ITRequestInput{Items: item, Notes: "Another mouse please", Priority: "normal"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, r.ID)
		if _, err := st.PostChatMessage(ctx, lead, r.ID, "about "+r.Ticket, "", nil); err != nil {
			t.Fatal(err)
		}
	}
	other, err := st.CreateITRequest(ctx, lead2, domain.ITRequestInput{Items: item, Notes: "Different team request", Priority: "normal"})
	if err != nil {
		t.Fatal(err)
	}

	list, err := st.Chats(ctx, admin, ChatFilter{})
	if err != nil || len(list.Items) != 2 || list.UnreadChats != 1 || list.Unread != 3 {
		t.Fatalf("admin list: %+v %v", list, err)
	}
	var conv *domain.ChatThread
	for i := range list.Items {
		if list.Items[i].Request.ID == other.ID && len(list.Items[i].Requests) != 1 {
			t.Fatalf("other lead merged: %+v", list.Items[i].Requests)
		}
		if len(list.Items[i].Requests) == 3 {
			conv = &list.Items[i]
		}
	}
	if conv == nil || conv.MessageCount != 3 || conv.Unread != 3 || conv.Request.ID != ids[2] {
		t.Fatalf("lead conversation: %+v", conv)
	}

	// Opening through any of the lead's requests shows the same conversation.
	for _, id := range ids {
		th, err := st.ChatMessages(ctx, lead, id, "")
		if err != nil || len(th.Messages) != 3 || len(th.Thread.Requests) != 3 {
			t.Fatalf("thread via %s: %+v %v", id, th, err)
		}
		for i, m := range th.Messages {
			if m.RequestID != ids[i] || m.Ticket == "" {
				t.Fatalf("message %d not tagged with its request: %+v", i, m)
			}
		}
	}
	// The other lead's request is not part of it, and polling spans requests.
	if th, _ := st.ChatMessages(ctx, admin, ids[0], ""); len(th.Messages) != 3 {
		t.Fatalf("admin view: %d", len(th.Messages))
	}
	if th, err := st.ChatMessages(ctx, admin, ids[0], ""); err == nil {
		first := th.Messages[0].ID
		if p, _ := st.ChatMessages(ctx, admin, ids[1], first); len(p.Messages) != 2 {
			t.Fatalf("poll after first: %d", len(p.Messages))
		}
	}

	// Reading the conversation clears every request in it.
	if u, err := st.MarkChatRead(ctx, admin, ids[1]); err != nil || u.Unread != 0 || u.UnreadChats != 0 {
		t.Fatalf("after read: %+v %v", u, err)
	}
}
