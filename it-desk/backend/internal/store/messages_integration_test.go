package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"itdesk/backend/internal/domain"
)

// A lead sees every IT member as a conversation, writes to any of them
// directly (no request needed) and each pair keeps one continuous thread.
func TestDirectChatLeadToAnyITMember(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	lead2, admin, it := as(leadT2), as(adminU), as(itU)
	clock := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	st.Now = func() time.Time { clock = clock.Add(time.Second); return clock }
	akash, manish := "its_akash_adhikari", "its_manish_yadav"

	// Every active IT member is listed for a lead, before anyone has written.
	list, err := st.Chats(ctx, lead, ChatFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 5 || list.Items[0].Staff.ID != manish || list.Items[0].LastMessage != nil || list.Items[0].LastActivityAt != nil ||
		!list.Items[0].CanPost || list.Items[0].Side != domain.ChatSideLead || list.Items[0].Lead.ID != lead.User.ID {
		t.Fatalf("lead list: %+v", list.Items)
	}
	// IT and admins only list conversations that have started.
	if l, _ := st.Chats(ctx, it, ChatFilter{}); len(l.Items) != 0 {
		t.Fatalf("IT list before any message: %+v", l.Items)
	}

	// Lead → Akash, with no request involved.
	m1, err := st.PostChatMessage(ctx, lead, lead.User.ID, akash, "  Hi Akash,\r\n\r\n\r\n\r\n\r\nquick question  ", nil)
	if err != nil {
		t.Fatal(err)
	}
	if m1.Side != "lead" || m1.SenderName != "Lead One" || !m1.Mine || m1.StaffID != akash || m1.Body != "Hi Akash,\n\n\nquick question" {
		t.Fatalf("lead message: %+v", m1)
	}

	// A lead can't open or write in another lead's conversation.
	if _, err := st.PostChatMessage(ctx, lead2, lead.User.ID, akash, "hi", nil); !errors.Is(err, errChatNotFound) {
		t.Fatalf("other lead posting: %v", err)
	}
	if _, err := st.ChatMessages(ctx, lead2, lead.User.ID, akash, ""); !errors.Is(err, errChatNotFound) {
		t.Fatalf("other lead reading: %v", err)
	}
	if _, err := st.ChatMessages(ctx, lead, lead.User.ID, "its_nobody", ""); !errors.Is(err, errChatNotFound) {
		t.Fatalf("unknown staff: %v", err)
	}
	// Only team leads have direct conversations with IT.
	if _, err := st.ChatMessages(ctx, it, admin.User.ID, akash, ""); !errors.Is(err, errChatNotFound) {
		t.Fatalf("admin as the lead side: %v", err)
	}

	// Unread for IT; nothing for the lead who wrote it.
	if u, _ := st.ChatUnread(ctx, it); u.Unread != 1 || u.UnreadChats != 1 {
		t.Fatalf("IT unread: %+v", u)
	}
	if u, _ := st.ChatUnread(ctx, lead); u.Unread != 0 {
		t.Fatalf("lead unread: %+v", u)
	}

	// IT replies in the same conversation, shown as Akash (written on his behalf).
	m2, err := st.PostChatMessage(ctx, it, lead.User.ID, akash, "Sure, what is it?", nil)
	if err != nil || m2.Side != "it" || m2.SenderName != "Akash Adhikari" || !m2.OnBehalf || m2.AuthorName != "Ivan Tech" {
		t.Fatalf("IT reply: %+v %v", m2, err)
	}
	// A message to Manish is a separate thread.
	if _, err := st.PostChatMessage(ctx, lead, lead.User.ID, manish, "Hello Manish", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PostChatMessage(ctx, lead, lead.User.ID, akash, "My monitor flickers.", nil); err != nil {
		t.Fatal(err)
	}

	th, err := st.ChatMessages(ctx, lead, lead.User.ID, akash, "")
	if err != nil || len(th.Messages) != 3 || th.Thread.Staff.Name != "Akash Adhikari" || th.Thread.MessageCount != 3 {
		t.Fatalf("akash thread: %+v %v", th, err)
	}
	if th.Thread.OtherReadAt == nil {
		t.Fatalf("IT replied, so it has read the conversation: %+v", th.Thread)
	}
	after, err := st.ChatMessages(ctx, lead, lead.User.ID, akash, m1.ID)
	if err != nil || len(after.Messages) != 2 || after.Messages[0].ID != m2.ID {
		t.Fatalf("poll after: %+v %v", after.Messages, err)
	}

	// Latest activity first in the lead's list; preview from the latest message.
	list, _ = st.Chats(ctx, lead, ChatFilter{})
	if len(list.Items) != 5 || list.Items[0].Staff.ID != akash || list.Items[0].LastMessage == nil ||
		list.Items[0].LastMessage.Body != "My monitor flickers." || list.Items[1].Staff.ID != manish {
		t.Fatalf("lead list order: %+v", list.Items[:2])
	}
	if u, _ := st.ChatUnread(ctx, lead); u.Unread != 0 {
		t.Fatalf("lead wrote after the reply, so nothing unread: %+v", u)
	}
	if u, _ := st.MarkChatRead(ctx, it, lead.User.ID, akash); u.Unread != 1 || u.UnreadChats != 1 {
		t.Fatalf("IT after reading Akash's thread: %+v", u)
	}

	// Admin: reads everything, writes nothing, reading doesn't count.
	for _, staff := range []string{akash, manish} {
		if _, err := st.PostChatMessage(ctx, admin, lead.User.ID, staff, "Noted.", nil); !errors.Is(err, errChatViewOnly) {
			t.Fatalf("admin post: %v, want view only", err)
		}
	}
	adm, err := st.Chats(ctx, admin, ChatFilter{})
	if err != nil || len(adm.Items) != 2 || adm.Items[0].CanPost || adm.Items[0].Unread != 0 || adm.Unread != 0 {
		t.Fatalf("admin list: %+v %v", adm, err)
	}
	if _, err := st.MarkChatRead(ctx, admin, lead.User.ID, manish); err != nil {
		t.Fatal(err)
	}
	if u, _ := st.ChatUnread(ctx, it); u.Unread != 1 {
		t.Fatalf("IT unread after an admin looked: %+v", u)
	}

	// Search by name and by message text.
	if f, _ := st.Chats(ctx, lead, ChatFilter{Query: "manish"}); len(f.Items) != 1 || f.Items[0].Staff.ID != manish {
		t.Errorf("search by name: %+v", f.Items)
	}
	if f, _ := st.Chats(ctx, lead, ChatFilter{Query: "flickers"}); len(f.Items) != 1 || f.Items[0].Staff.ID != akash {
		t.Errorf("search by message: %+v", f.Items)
	}

	// Someone who left IT: the conversation stays readable, new messages are
	// refused, and they drop out of other leads' lists.
	if _, err := st.db.Pool.Exec(ctx, `UPDATE it_staff SET active = false WHERE id = $1`, akash); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PostChatMessage(ctx, lead, lead.User.ID, akash, "Still there?", nil); !errors.Is(err, errChatClosed) {
		t.Fatalf("post to former staff: %v", err)
	}
	if l, _ := st.Chats(ctx, lead, ChatFilter{}); len(l.Items) != 5 || l.Items[0].Staff.ID != akash || l.Items[0].CanPost {
		t.Fatalf("lead keeps the old thread: %+v", l.Items[0])
	}
	if l, _ := st.Chats(ctx, lead2, ChatFilter{}); len(l.Items) != 4 {
		t.Fatalf("other lead's list: %d", len(l.Items))
	}

	// Validation.
	for _, body := range []string{"", "   \n ", string(make([]rune, domain.MaxMessageBody+1))} {
		if _, err := st.PostChatMessage(ctx, lead, lead.User.ID, manish, body, nil); err == nil {
			t.Errorf("accepted body of %d runes", len([]rune(body)))
		}
	}
	var audits int
	_ = st.db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action = 'chat.message'`).Scan(&audits)
	if audits != 4 {
		t.Errorf("audited %d messages, want 4", audits)
	}
}

// IT staff with their own login see only their own conversations and write
// as themselves; they can't open someone else's.
func TestDirectChatLinkedITMember(t *testing.T) {
	st, lead := setup(t)
	ctx := context.Background()
	it := as(itU)
	mine, other := "its_abash_thapa", "its_akash_adhikari"
	if _, err := st.db.Pool.Exec(ctx, `UPDATE it_staff SET user_id = 'usr_it' WHERE id = $1`, mine); err != nil {
		t.Fatal(err)
	}
	for _, staff := range []string{mine, other} {
		if _, err := st.PostChatMessage(ctx, lead, lead.User.ID, staff, "Hello", nil); err != nil {
			t.Fatal(err)
		}
	}
	l, err := st.Chats(ctx, it, ChatFilter{})
	if err != nil || len(l.Items) != 1 || l.Items[0].Staff.ID != mine || l.MyStaffID == nil || *l.MyStaffID != mine ||
		l.Items[0].Lead.Name != "Lead One" || l.Items[0].Lead.TeamName == nil || *l.Items[0].Lead.TeamName != "Platform" {
		t.Fatalf("linked IT list: %+v %v", l, err)
	}
	if u, _ := st.ChatUnread(ctx, it); u.Unread != 1 || u.UnreadChats != 1 {
		t.Fatalf("linked IT unread: %+v", u)
	}
	if _, err := st.ChatMessages(ctx, it, lead.User.ID, other, ""); !errors.Is(err, errChatNotFound) {
		t.Fatalf("someone else's conversation: %v", err)
	}
	m, err := st.PostChatMessage(ctx, it, lead.User.ID, mine, "On it.", nil)
	if err != nil || m.SenderName != "Abash Thapa" || m.OnBehalf || !m.Mine {
		t.Fatalf("linked reply: %+v %v", m, err)
	}
	th, _ := st.ChatMessages(ctx, lead, lead.User.ID, mine, "")
	if got := th.Messages[len(th.Messages)-1]; got.SenderName != "Abash Thapa" || got.OnBehalf || got.Mine {
		t.Fatalf("lead's view: %+v", got)
	}
	// IT can start a conversation with a lead who hasn't written yet.
	if _, err := st.PostChatMessage(ctx, it, leadT2.ID, mine, "Your laptop is ready.", nil); err != nil {
		t.Fatalf("IT starting a conversation: %v", err)
	}
	if l, _ := st.Chats(ctx, as(leadT2), ChatFilter{}); l.Items[0].Staff.ID != mine || l.Items[0].Unread != 1 {
		t.Fatalf("lead two sees it first: %+v", l.Items[0])
	}
}
