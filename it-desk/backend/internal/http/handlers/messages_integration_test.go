package handlers

import (
	"encoding/json"
	"testing"
)

type chatMsg struct {
	ID          string `json:"id"`
	LeadID      string `json:"leadId"`
	StaffID     string `json:"staffId"`
	Side        string `json:"side"`
	SenderName  string `json:"senderName"`
	AuthorName  string `json:"authorName"`
	OnBehalf    bool   `json:"onBehalf"`
	Mine        bool   `json:"mine"`
	Body        string `json:"body"`
	Attachments []struct {
		URL string `json:"url"`
	} `json:"attachments"`
}

type chatThread struct {
	Lead struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"lead"`
	Staff struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"staff"`
	Side         string   `json:"side"`
	CanPost      bool     `json:"canPost"`
	MessageCount int      `json:"messageCount"`
	Unread       int      `json:"unread"`
	LastMessage  *chatMsg `json:"lastMessage"`
	OtherReadAt  *string  `json:"otherReadAt"`
}

func chatUnread(t *testing.T, c *client) (int, int) {
	t.Helper()
	r := c.do("GET", "/api/v1/chats/unread", nil)
	if r.Status != 200 {
		t.Fatalf("unread: %d", r.Status)
	}
	var u struct{ Unread, UnreadChats int }
	_ = json.Unmarshal(r.Data, &u)
	return u.Unread, u.UnreadChats
}

// 1x1 transparent PNG.
const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

func TestDirectChatHTTP(t *testing.T) {
	ts, _ := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	// Another lead of the same team: conversations are per lead, not per team.
	lead2 := newClient(t, ts).mustLogin("lead3@example.com")
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")
	conv := "/api/v1/chats/lead_test/its_manish_yadav"

	// The lead's list: every IT member, by name, no request attached.
	r := lead.do("GET", "/api/v1/chats", nil)
	var list struct {
		Items  []chatThread `json:"items"`
		Unread int          `json:"unread"`
	}
	_ = json.Unmarshal(r.Data, &list)
	if r.Status != 200 || len(list.Items) != 5 || list.Items[0].Staff.Name != "Manish Kumar Yadav" || !list.Items[0].CanPost || list.Items[0].Side != "lead" {
		t.Fatalf("lead chats: %d %+v", r.Status, list)
	}

	// Another lead's conversation is invisible.
	for _, r := range []resp{
		lead2.do("GET", conv+"/messages", nil),
		lead2.do("POST", conv+"/messages", map[string]any{"body": "hi"}),
		lead2.do("POST", conv+"/read", map[string]any{}),
	} {
		if r.Status != 404 {
			t.Errorf("another lead's conversation: %d", r.Status)
		}
	}
	if r := lead.do("POST", conv+"/messages", map[string]any{"body": "   "}); r.Status != 422 || r.Error.Fields["body"] == "" {
		t.Errorf("blank message: %d %v", r.Status, r.Error.Fields)
	}

	// Lead → Manish, with a screenshot.
	r = lead.do("POST", conv+"/messages", map[string]any{"body": "Hi Manish, quick question", "images": []map[string]any{{"name": "s.png", "data": tinyPNG}}})
	if r.Status != 201 {
		t.Fatalf("lead message: %d %v", r.Status, r.Error)
	}
	var m1 chatMsg
	_ = json.Unmarshal(r.Data, &m1)
	if m1.Side != "lead" || !m1.Mine || m1.SenderName != "Lead One" || len(m1.Attachments) != 1 {
		t.Fatalf("lead message: %+v", m1)
	}
	if f := lead.do("GET", m1.Attachments[0].URL, nil); f.Status != 200 {
		t.Errorf("attachment: %d", f.Status)
	}
	if f := lead2.do("GET", m1.Attachments[0].URL, nil); f.Status != 404 {
		t.Errorf("attachment for another lead: %d", f.Status)
	}
	if n, c := chatUnread(t, it); n != 1 || c != 1 {
		t.Errorf("IT unread = %d/%d, want 1/1", n, c)
	}

	// IT → lead in the same conversation, shown as Manish.
	r = it.do("POST", conv+"/messages", map[string]any{"body": "Go ahead."})
	var m2 chatMsg
	_ = json.Unmarshal(r.Data, &m2)
	if r.Status != 201 || m2.Side != "it" || m2.SenderName != "Manish Kumar Yadav" || !m2.OnBehalf || m2.AuthorName != "Ivan Tech" {
		t.Fatalf("IT reply: %d %+v", r.Status, m2)
	}
	if n, _ := chatUnread(t, lead); n != 1 {
		t.Errorf("lead unread = %d, want 1", n)
	}

	// Polling and read state.
	r = lead.do("GET", conv+"/messages?after="+m1.ID, nil)
	var page struct {
		Thread   chatThread `json:"thread"`
		Messages []chatMsg  `json:"messages"`
	}
	_ = json.Unmarshal(r.Data, &page)
	if r.Status != 200 || len(page.Messages) != 1 || page.Messages[0].ID != m2.ID || page.Thread.OtherReadAt == nil || page.Thread.Staff.Name != "Manish Kumar Yadav" {
		t.Fatalf("poll: %d %+v", r.Status, page)
	}
	if r := lead.do("POST", conv+"/read", map[string]any{}); r.Status != 200 {
		t.Fatalf("read: %d", r.Status)
	}
	if n, _ := chatUnread(t, lead); n != 0 {
		t.Errorf("lead unread after read = %d", n)
	}

	// Admins read but never write.
	r = admin.do("GET", "/api/v1/chats", nil)
	_ = json.Unmarshal(r.Data, &list)
	if len(list.Items) != 1 || list.Items[0].CanPost || list.Items[0].Lead.Name != "Lead One" {
		t.Fatalf("admin chats: %+v", list.Items)
	}
	if r := admin.do("POST", conv+"/messages", map[string]any{"body": "Stepping in"}); r.Status != 403 || r.Error.Code != "chat_view_only" {
		t.Errorf("admin post: %d %s, want 403 chat_view_only", r.Status, r.Error.Code)
	}
}

// An admin links a directory entry to an IT account; that person then sees
// their own conversations and replies as themselves.
func TestStaffLoginLinkHTTP(t *testing.T) {
	ts, _ := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")

	if r := it.do("PATCH", "/api/v1/admin/it-staff/its_ujjal_dahal", map[string]any{"userId": "usr_it"}); r.Status != 403 {
		t.Fatalf("IT linking itself: %d", r.Status)
	}
	if r := admin.do("PATCH", "/api/v1/admin/it-staff/its_ujjal_dahal", map[string]any{"userId": "usr_admin"}); r.Status != 422 || r.Error.Fields["userId"] == "" {
		t.Fatalf("link a non-IT account: %d %v", r.Status, r.Error.Fields)
	}
	if r := admin.do("PATCH", "/api/v1/admin/it-staff/its_ujjal_dahal", map[string]any{"userId": "usr_it"}); r.Status != 200 {
		t.Fatalf("link: %d", r.Status)
	}

	for _, staff := range []string{"its_ujjal_dahal", "its_nabin_baraili"} {
		if r := lead.do("POST", "/api/v1/chats/lead_test/"+staff+"/messages", map[string]any{"body": "Hello"}); r.Status != 201 {
			t.Fatalf("lead → %s: %d", staff, r.Status)
		}
	}
	r := it.do("GET", "/api/v1/chats", nil)
	var list struct {
		Items     []chatThread `json:"items"`
		MyStaffID *string      `json:"myStaffId"`
	}
	_ = json.Unmarshal(r.Data, &list)
	if r.Status != 200 || len(list.Items) != 1 || list.Items[0].Staff.ID != "its_ujjal_dahal" || list.MyStaffID == nil {
		t.Fatalf("linked IT list: %d %+v", r.Status, list)
	}
	if r := it.do("GET", "/api/v1/chats/lead_test/its_nabin_baraili/messages", nil); r.Status != 404 {
		t.Errorf("someone else's conversation: %d", r.Status)
	}
	r = it.do("POST", "/api/v1/chats/lead_test/its_ujjal_dahal/messages", map[string]any{"body": "Bringing it over."})
	var m chatMsg
	_ = json.Unmarshal(r.Data, &m)
	if r.Status != 201 || m.SenderName != "Ujjal Dahal" || m.OnBehalf || !m.Mine {
		t.Fatalf("linked reply: %d %+v", r.Status, m)
	}
}
