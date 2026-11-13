package handlers

import (
	"encoding/json"
	"testing"
)

type chatMsg struct {
	ID         string  `json:"id"`
	Side       string  `json:"side"`
	SenderName string  `json:"senderName"`
	StaffID    *string `json:"staffId"`
	AuthorName string  `json:"authorName"`
	OnBehalf   bool    `json:"onBehalf"`
	Mine       bool    `json:"mine"`
	Body       string  `json:"body"`
}

type chatThread struct {
	Request      reqView  `json:"request"`
	Requests     []reqView `json:"requests"`
	Side         string   `json:"side"`
	CanPostAs    []string `json:"canPostAs"`
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

func TestRequestChatHTTP(t *testing.T) {
	ts, _ := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")

	items := []map[string]any{{"kind": "laptop", "quantity": 1}}
	mine := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "New joiner laptop", "staffId": "its_manish_yadav"}), 201, "lead request")
	other := decodeReq(t, admin.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "Payments laptop", "teamId": "t2"}), 201, "t2 request")

	// Another team's conversation is invisible to the lead.
	for _, r := range []resp{
		lead.do("GET", "/api/v1/it-requests/"+other.ID+"/messages", nil),
		lead.do("POST", "/api/v1/it-requests/"+other.ID+"/messages", map[string]any{"body": "hi"}),
		lead.do("POST", "/api/v1/it-requests/"+other.ID+"/messages/read", map[string]any{}),
	} {
		if r.Status != 404 {
			t.Errorf("lead on another team's chat: %d", r.Status)
		}
	}

	// Validation and side rules.
	if r := lead.do("POST", "/api/v1/it-requests/"+mine.ID+"/messages", map[string]any{"body": "   "}); r.Status != 422 || r.Error.Fields["body"] == "" {
		t.Errorf("blank message: %d %v", r.Status, r.Error.Fields)
	}
	if r := lead.do("POST", "/api/v1/it-requests/"+mine.ID+"/messages", map[string]any{"body": "x", "as": "it"}); r.Status != 403 {
		t.Errorf("lead as IT: %d", r.Status)
	}
	if r := admin.do("POST", "/api/v1/it-requests/"+mine.ID+"/messages", map[string]any{"body": "x", "as": "boss"}); r.Status != 422 {
		t.Errorf("unknown side: %d", r.Status)
	}

	// Lead → IT.
	r := lead.do("POST", "/api/v1/it-requests/"+mine.ID+"/messages", map[string]any{"body": "Hi Manish, any update?"})
	if r.Status != 201 {
		t.Fatalf("lead message: %d %v", r.Status, r.Error.Fields)
	}
	var m1 chatMsg
	_ = json.Unmarshal(r.Data, &m1)
	if m1.Side != "requester" || !m1.Mine || m1.SenderName != "Lead One" {
		t.Fatalf("lead message: %+v", m1)
	}
	if n, c := chatUnread(t, it); n != 1 || c != 1 {
		t.Errorf("IT unread = %d/%d, want 1/1", n, c)
	}

	// IT → lead, shown as Manish.
	r = it.do("POST", "/api/v1/it-requests/"+mine.ID+"/messages", map[string]any{"body": "Ready tomorrow at 10."})
	var m2 chatMsg
	_ = json.Unmarshal(r.Data, &m2)
	if r.Status != 201 || m2.Side != "it" || m2.SenderName != "Manish Kumar Yadav" || !m2.OnBehalf || m2.AuthorName != "Ivan Tech" {
		t.Fatalf("IT reply: %d %+v", r.Status, m2)
	}
	if n, _ := chatUnread(t, it); n != 0 {
		t.Errorf("IT unread after replying = %d", n)
	}
	if n, _ := chatUnread(t, lead); n != 1 {
		t.Errorf("lead unread = %d, want 1", n)
	}

	// Lead's list: only their team's request, with the reply as last message.
	r = lead.do("GET", "/api/v1/chats?status=active", nil)
	var list struct {
		Items  []chatThread `json:"items"`
		Unread int         `json:"unread"`
	}
	_ = json.Unmarshal(r.Data, &list)
	if r.Status != 200 || len(list.Items) != 1 || !hasReq(list.Items[0].Requests, mine.ID) || list.Items[0].Unread != 1 ||
		list.Items[0].LastMessage == nil || list.Items[0].LastMessage.ID != m2.ID || list.Unread != 1 ||
		list.Items[0].Side != "requester" || len(list.Items[0].CanPostAs) != 1 {
		t.Fatalf("lead chats: %d %+v", r.Status, list)
	}
	if r := lead.do("GET", "/api/v1/chats?status=nope", nil); r.Status != 422 {
		t.Errorf("bad filter: %d", r.Status)
	}

	// Polling and read state.
	r = lead.do("GET", "/api/v1/it-requests/"+mine.ID+"/messages?after="+m1.ID, nil)
	var page struct {
		Thread   chatThread `json:"thread"`
		Messages []chatMsg  `json:"messages"`
	}
	_ = json.Unmarshal(r.Data, &page)
	if r.Status != 200 || len(page.Messages) != 1 || page.Messages[0].ID != m2.ID || page.Thread.OtherReadAt == nil {
		t.Fatalf("poll: %d %+v", r.Status, page)
	}
	if r := lead.do("POST", "/api/v1/it-requests/"+mine.ID+"/messages/read", map[string]any{}); r.Status != 200 {
		t.Fatalf("read: %d", r.Status)
	}
	if n, _ := chatUnread(t, lead); n != 0 {
		t.Errorf("lead unread after read = %d", n)
	}

	// Admin sees both teams and may speak for either side.
	r = admin.do("GET", "/api/v1/chats", nil)
	_ = json.Unmarshal(r.Data, &list)
	if len(list.Items) != 2 || len(list.Items[0].CanPostAs) != 2 {
		t.Errorf("admin chats: %+v", list.Items)
	}
}

// An admin links a directory entry to an IT account; that person then filters
// to their own conversations and replies as themselves.
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
	r := admin.do("PATCH", "/api/v1/admin/it-staff/its_ujjal_dahal", map[string]any{"userId": "usr_it"})
	var linked struct {
		HasLogin bool `json:"hasLogin"`
		Login    *struct {
			UserID string `json:"userId"`
			Email  string `json:"email"`
		} `json:"login"`
	}
	_ = json.Unmarshal(r.Data, &linked)
	if r.Status != 200 || !linked.HasLogin || linked.Login == nil || linked.Login.Email != "it@example.com" {
		t.Fatalf("link: %d %+v", r.Status, linked)
	}

	items := []map[string]any{{"kind": "mouse", "quantity": 1}}
	mine := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "Second screen", "staffId": "its_ujjal_dahal"}), 201, "routed request")
	decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "For Nabin", "staffId": "its_nabin_baraili"}), 201, "other request")

	r = it.do("GET", "/api/v1/chats?assigned=me", nil)
	var list struct {
		Items     []chatThread `json:"items"`
		MyStaffID *string      `json:"myStaffId"`
	}
	_ = json.Unmarshal(r.Data, &list)
	if r.Status != 200 || len(list.Items) != 1 || !hasReq(list.Items[0].Requests, mine.ID) || list.MyStaffID == nil || *list.MyStaffID != "its_ujjal_dahal" {
		t.Fatalf("assigned to me: %d %+v", r.Status, list)
	}

	r = it.do("POST", "/api/v1/it-requests/"+mine.ID+"/messages", map[string]any{"body": "Bringing it over."})
	var m chatMsg
	_ = json.Unmarshal(r.Data, &m)
	if r.Status != 201 || m.SenderName != "Ujjal Dahal" || m.OnBehalf || !m.Mine {
		t.Fatalf("linked reply: %d %+v", r.Status, m)
	}
	r = lead.do("GET", "/api/v1/it-requests/"+mine.ID+"/messages", nil)
	var th struct {
		Messages []chatMsg `json:"messages"`
	}
	_ = json.Unmarshal(r.Data, &th)
	if len(th.Messages) != 1 || th.Messages[0].SenderName != "Ujjal Dahal" || th.Messages[0].OnBehalf {
		t.Fatalf("requester sees: %+v", th.Messages)
	}
	if n, _ := chatUnread(t, lead); n != 1 {
		t.Errorf("lead unread = %d, want 1", n)
	}
}

func hasReq(rs []reqView, id string) bool {
	for _, r := range rs {
		if r.ID == id {
			return true
		}
	}
	return false
}
