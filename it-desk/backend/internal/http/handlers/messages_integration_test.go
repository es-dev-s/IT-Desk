package handlers

import (
	"encoding/json"
	"testing"

	"itdesk/backend/internal/domain"
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
	Request      reqView   `json:"request"`
	Requests     []reqView `json:"requests"`
	Side         string    `json:"side"`
	CanPostAs    []string  `json:"canPostAs"`
	MessageCount int       `json:"messageCount"`
	Unread       int       `json:"unread"`
	LastMessage  *chatMsg  `json:"lastMessage"`
	OtherReadAt  *string   `json:"otherReadAt"`
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
		Unread int          `json:"unread"`
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

	// Admin sees both teams, but can only write on the request they raised themselves.
	r = admin.do("GET", "/api/v1/chats", nil)
	_ = json.Unmarshal(r.Data, &list)
	if len(list.Items) != 2 {
		t.Fatalf("admin chats: %+v", list.Items)
	}
	for _, it := range list.Items {
		want := 0
		if hasReq(it.Requests, other.ID) {
			want = 1
		}
		if len(it.CanPostAs) != want || (want == 1 && it.CanPostAs[0] != "requester") || (want == 0 && it.Unread != 0) {
			t.Errorf("admin thread %s: canPostAs=%v unread=%d", it.Requests[0].ID, it.CanPostAs, it.Unread)
		}
	}
	for _, as := range []string{"", "it", "requester"} {
		body := map[string]any{"body": "Stepping in"}
		if as != "" {
			body["as"] = as
		}
		if r := admin.do("POST", "/api/v1/it-requests/"+mine.ID+"/messages", body); r.Status != 403 || r.Error.Code != "chat_view_only" {
			t.Errorf("admin post as %q on a lead's request: %d %s, want 403 chat_view_only", as, r.Status, r.Error.Code)
		}
	}
	if r := admin.do("POST", "/api/v1/it-requests/"+other.ID+"/messages", map[string]any{"body": "Any update?"}); r.Status != 201 {
		t.Errorf("admin post on own request: %d %s", r.Status, r.Error.Code)
	}
	if r := admin.do("POST", "/api/v1/it-requests/"+other.ID+"/messages", map[string]any{"body": "x", "as": "it"}); r.Status != 403 || r.Error.Code != "chat_side" {
		t.Errorf("admin as IT on own request: %d %s, want 403 chat_side", r.Status, r.Error.Code)
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

func TestDirectChatHTTP(t *testing.T) {
	ts, _ := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	otherLead := newClient(t, ts).mustLogin("lead3@example.com")
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")

	const (
		inbox     = "/api/v1/direct-chats"
		ujjal     = inbox + "/its_ujjal_dahal/messages"
		nabin     = inbox + "/its_nabin_baraili/messages"
		leadChat  = inbox + "/lead_test/messages"
		otherChat = inbox + "/lead_three/messages"
	)

	contacts := decodeChatResponse[domain.DirectChatList](t, lead.do("GET", inbox, nil), 200)
	byID := make(map[string]domain.DirectChatThread)
	for _, item := range contacts.Items {
		byID[item.Contact.ID] = item
	}
	n, u := byID["its_nabin_baraili"], byID["its_ujjal_dahal"]
	if len(byID) != 5 || n.Contact.Name != "Nabin Baraili" || u.Contact.Name != "Ujjal Dahal" ||
		n.Contact.Available || len(n.CanPostAs) != 1 || n.LastMessage != nil {
		t.Fatalf("expected all five directory entries before any requests or messages: %+v", contacts)
	}

	first := decodeChatResponse[domain.RequestMessage](t, lead.do("POST", ujjal, map[string]any{
		"body":   "Can you check the monitor?",
		"images": []map[string]string{{"name": "screen.png", "data": "iVBORw0KGgo="}},
	}), 201)
	decodeChatResponse[domain.RequestMessage](t, lead.do("POST", nabin, map[string]any{"body": "Can you check stock?"}), 201)
	if first.Ticket != "" || first.RequestID != "" || len(first.Attachments) != 1 || !first.Mine {
		t.Fatalf("direct message must be independent of requests: %+v", first)
	}
	file := first.Attachments[0].URL
	if r := it.do("GET", file, nil); r.Status != 404 {
		t.Fatalf("unlinked IT was able to access the attachment: %d", r.Status)
	}
	decodeChatResponse[domain.ITStaff](t, admin.do("PATCH", "/api/v1/admin/it-staff/its_ujjal_dahal", map[string]any{"userId": "usr_it"}), 200)
	if r := it.do("GET", file, nil); r.Status != 200 || r.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("linked IT cannot access the attachment: %d", r.Status)
	}
	if r := otherLead.do("GET", file, nil); r.Status != 404 {
		t.Fatalf("nonparticipant accessed the attachment: %d", r.Status)
	}
	if r := admin.do("GET", file, nil); r.Status != 200 {
		t.Fatalf("the super admin can read every direct chat's images: %d", r.Status)
	}
	if r := it.do("POST", otherChat, map[string]any{"body": "Wrong lead"}); r.Status != 404 {
		t.Fatalf("another lead's conversation should be inaccessible: %d", r.Status)
	}
	empty := decodeChatResponse[domain.DirectChatMessages](t, otherLead.do("GET", ujjal, nil), 200)
	if len(empty.Messages) != 0 {
		t.Fatalf("same-team lead can see the other lead's messages: %+v", empty.Messages)
	}

	incoming := decodeChatResponse[domain.DirectChatList](t, it.do("GET", inbox, nil), 200)
	if incoming.Unread != 1 || incoming.UnreadChats != 1 || len(incoming.Items) != 1 ||
		incoming.Items[0].Contact.Name != "Lead One" || incoming.Items[0].LastMessage == nil || incoming.Items[0].LastMessage.ID != first.ID {
		t.Fatalf("IT inbox includes only its own messages: %+v", incoming)
	}
	reply := decodeChatResponse[domain.RequestMessage](t, it.do("POST", leadChat, map[string]any{"body": "I’ll check it now."}), 201)
	if reply.SenderName != "Ujjal Dahal" || reply.OnBehalf || reply.Side != "it" {
		t.Fatalf("reply should be attributed to the linked IT member: %+v", reply)
	}
	page := decodeChatResponse[domain.DirectChatMessages](t, lead.do("GET", ujjal+"?after="+first.ID, nil), 200)
	if !page.Thread.Contact.Available || page.Thread.MessageCount != 2 || page.Thread.Unread != 1 ||
		len(page.Messages) != 1 || page.Messages[0].ID != reply.ID {
		t.Fatalf("reply should appear in the original thread: %+v", page)
	}
	otherPage := decodeChatResponse[domain.DirectChatMessages](t, lead.do("GET", nabin, nil), 200)
	if len(otherPage.Messages) != 1 || otherPage.Messages[0].Body != "Can you check stock?" {
		t.Fatalf("other IT member should have a separate thread: %+v", otherPage.Messages)
	}
	filtered := decodeChatResponse[domain.DirectChatList](t, lead.do("GET", inbox+"?q=monitor", nil), 200)
	if len(filtered.Items) != 1 || filtered.Items[0].Contact.ID != "its_ujjal_dahal" ||
		filtered.Items[0].LastMessage == nil || filtered.Items[0].LastMessage.ID != reply.ID {
		t.Fatalf("search should show the matching chat and its latest preview: %+v", filtered)
	}
	if u := decodeChatResponse[domain.ChatUnread](t, lead.do("POST", ujjal+"/read", map[string]any{}), 200); u.Unread != 0 {
		t.Fatalf("read should clear the lead's direct unread count: %+v", u)
	}
	if n, _ := chatUnread(t, lead); n != 0 {
		t.Fatalf("direct messages changed the request unread count: %d", n)
	}
}

// The admin sees every active team lead and IT staff entry before anyone has
// written, can start a chat with any of them, and nobody else can read it.
func TestAdminDirectChatHTTP(t *testing.T) {
	ts, _ := liveServer(t)
	admin := newClient(t, ts).mustLogin("admin@example.com")
	lead := newClient(t, ts).mustLogin("lead@example.com")
	otherLead := newClient(t, ts).mustLogin("lead3@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")

	const (
		inbox     = "/api/v1/direct-chats"
		toLead    = inbox + "/lead_test/messages"
		toUjjal   = inbox + "/its_ujjal_dahal/messages"
		fromAdmin = inbox + "/usr_admin/messages"
		fromLead  = inbox + "/lead_test/messages"
	)

	roles := func(l domain.DirectChatList) map[string]string {
		out := map[string]string{}
		for _, item := range l.Items {
			out[item.Contact.ID] = item.Contact.Role
		}
		return out
	}
	list := decodeChatResponse[domain.DirectChatList](t, admin.do("GET", inbox, nil), 200)
	got := roles(list)
	if len(got) != 7 || got["lead_test"] != "team_lead" || got["lead_three"] != "team_lead" || got["its_ujjal_dahal"] != "it" {
		t.Fatalf("admin should see all five IT entries and both leads by default: %v", got)
	}
	for _, item := range list.Items {
		if item.LastMessage != nil || item.Unread != 0 || len(item.CanPostAs) != 1 {
			t.Fatalf("a fresh directory entry is empty and writable: %+v", item)
		}
	}
	if len(decodeChatResponse[domain.DirectChatList](t, lead.do("GET", inbox, nil), 200).Items) != 5 {
		t.Fatal("a team lead must not see the admin until the admin writes to them")
	}

	first := decodeChatResponse[domain.RequestMessage](t, admin.do("POST", toLead, map[string]any{"body": "Hi, quick question."}), 201)
	if !first.Mine || first.Side != "it" || first.SenderName != "Ada Admin" || first.OnBehalf {
		t.Fatalf("admin message to a lead: %+v", first)
	}
	if r := admin.do("POST", toLead, map[string]any{"body": "Second"}); r.Status != 201 {
		t.Fatalf("second message reuses the chat: %d %s", r.Status, r.Error.Code)
	}

	inc := decodeChatResponse[domain.DirectChatList](t, lead.do("GET", inbox, nil), 200)
	var adminThread *domain.DirectChatThread
	for i := range inc.Items {
		if inc.Items[i].Contact.ID == "usr_admin" {
			adminThread = &inc.Items[i]
		}
	}
	if adminThread == nil || adminThread.Contact.Role != "admin" || adminThread.Unread != 2 || adminThread.Side != "requester" || inc.Unread != 2 {
		t.Fatalf("lead should see the admin's conversation as unread: %+v", inc)
	}
	reply := decodeChatResponse[domain.RequestMessage](t, lead.do("POST", fromAdmin, map[string]any{"body": "Sure, go ahead."}), 201)
	if reply.Side != "requester" || reply.SenderName != "Lead One" {
		t.Fatalf("lead reply: %+v", reply)
	}
	page := decodeChatResponse[domain.DirectChatMessages](t, admin.do("GET", toLead, nil), 200)
	if len(page.Messages) != 3 || page.Thread.Unread != 1 || page.Thread.MessageCount != 3 {
		t.Fatalf("admin should see both sides of the conversation: %+v", page)
	}
	if u := decodeChatResponse[domain.ChatUnread](t, admin.do("POST", toLead+"/read", map[string]any{}), 200); u.Unread != 0 {
		t.Fatalf("read should clear the admin's unread count: %+v", u)
	}

	// Nobody else is part of it.
	if r := otherLead.do("GET", fromAdmin, nil); r.Status != 404 {
		t.Fatalf("another lead opened the admin's chat: %d", r.Status)
	}
	if r := otherLead.do("GET", fromLead, nil); r.Status != 404 {
		t.Fatalf("another lead opened a lead's chat with someone else: %d", r.Status)
	}
	for _, c := range []*client{otherLead, it} {
		if got := decodeChatResponse[domain.DirectChatMessages](t, admin.do("GET", toLead, nil), 200); len(got.Messages) != 3 {
			t.Fatal("history changed")
		}
		if r := c.do("GET", toLead, nil); r.Status == 200 && len(decodeChatResponse[domain.DirectChatMessages](t, r, 200).Messages) != 0 {
			t.Fatalf("a nonparticipant read the admin/lead messages")
		}
	}
	if r := admin.do("POST", inbox+"/usr_admin/messages", map[string]any{"body": "me"}); r.Status != 404 {
		t.Fatalf("admin cannot message themselves: %d", r.Status)
	}

	// Admin to IT staff: unlinked entries can be written to, linked IT replies.
	sent := decodeChatResponse[domain.RequestMessage](t, admin.do("POST", toUjjal, map[string]any{"body": "Status of the audit?"}), 201)
	if sent.Side != "requester" || !sent.Mine {
		t.Fatalf("admin to IT: %+v", sent)
	}
	if got := decodeChatResponse[domain.DirectChatList](t, it.do("GET", inbox, nil), 200); len(got.Items) != 0 {
		t.Fatalf("unlinked IT should see nothing: %+v", got)
	}
	decodeChatResponse[domain.ITStaff](t, admin.do("PATCH", "/api/v1/admin/it-staff/its_ujjal_dahal", map[string]any{"userId": "usr_it"}), 200)
	itList := decodeChatResponse[domain.DirectChatList](t, it.do("GET", inbox, nil), 200)
	if len(itList.Items) != 1 || itList.Items[0].Contact.ID != "usr_admin" || itList.Items[0].Contact.Role != "admin" ||
		itList.Items[0].Contact.Title != "Super admin" || itList.Items[0].Unread != 1 {
		t.Fatalf("linked IT should see the admin's message: %+v", itList)
	}
	itReply := decodeChatResponse[domain.RequestMessage](t, it.do("POST", fromAdmin, map[string]any{"body": "Done yesterday."}), 201)
	if itReply.Side != "it" || itReply.SenderName != "Ujjal Dahal" {
		t.Fatalf("IT reply to the admin: %+v", itReply)
	}
	if got := decodeChatResponse[domain.DirectChatMessages](t, admin.do("GET", toUjjal, nil), 200); len(got.Messages) != 2 || got.Thread.Unread != 1 {
		t.Fatalf("admin should receive the IT reply: %+v", got)
	}

	// A lead added later shows up without any action from them.
	r := admin.do("POST", "/api/v1/admin/users", map[string]any{"email": "newlead@example.com", "name": "Nora Lead", "role": "team_lead", "teamId": "t2"})
	if r.Status != 201 {
		t.Fatalf("create lead: %d %s", r.Status, r.Error.Code)
	}
	if got := roles(decodeChatResponse[domain.DirectChatList](t, admin.do("GET", inbox, nil), 200)); len(got) != 8 {
		t.Fatalf("a new team lead should be listed straight away: %v", got)
	}
}

func decodeChatResponse[T any](t *testing.T, r resp, status int) T {
	t.Helper()
	if r.Status != status {
		t.Fatalf("chat status %d, want %d (%s: %s)", r.Status, status, r.Error.Code, r.Error.Message)
	}
	var v T
	if err := json.Unmarshal(r.Data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func hasReq(rs []reqView, id string) bool {
	for _, r := range rs {
		if r.ID == id {
			return true
		}
	}
	return false
}

// The super admin reads every direct chat between other people, read-only,
// without touching anyone's unread state. Nobody else can list them.
func TestAdminReadsAllDirectChatsHTTP(t *testing.T) {
	ts, _ := liveServer(t)
	admin := newClient(t, ts).mustLogin("admin@example.com")
	lead := newClient(t, ts).mustLogin("lead@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")
	const all = "/api/v1/direct-chats/all"

	if got := decodeChatResponse[domain.DirectChatList](t, admin.do("GET", all, nil), 200); len(got.Items) != 0 {
		t.Fatalf("chats with no messages are not listed: %+v", got)
	}
	decodeChatResponse[domain.ITStaff](t, admin.do("PATCH", "/api/v1/admin/it-staff/its_ujjal_dahal", map[string]any{"userId": "usr_it"}), 200)
	first := decodeChatResponse[domain.RequestMessage](t, lead.do("POST", "/api/v1/direct-chats/its_ujjal_dahal/messages", map[string]any{"body": "Printer jammed"}), 201)
	reply := decodeChatResponse[domain.RequestMessage](t, it.do("POST", "/api/v1/direct-chats/lead_test/messages", map[string]any{"body": "On my way"}), 201)
	// The admin's own chats stay in their own inbox, not here.
	decodeChatResponse[domain.RequestMessage](t, admin.do("POST", "/api/v1/direct-chats/lead_test/messages", map[string]any{"body": "Hello"}), 201)

	list := decodeChatResponse[domain.DirectChatList](t, admin.do("GET", all, nil), 200)
	if len(list.Items) != 1 || list.Unread != 0 {
		t.Fatalf("admin should see exactly the lead/IT chat: %+v", list)
	}
	th := list.Items[0]
	if th.Participants == nil || th.Participants.Requester.Name != "Lead One" || th.Participants.IT.Name != "Ujjal Dahal" ||
		len(th.CanPostAs) != 0 || th.Unread != 0 || th.MessageCount != 2 || th.LastMessage == nil || th.LastMessage.ID != reply.ID {
		t.Fatalf("observed thread: %+v", th)
	}
	if got := decodeChatResponse[domain.DirectChatList](t, admin.do("GET", all+"?q=jammed", nil), 200); len(got.Items) != 1 {
		t.Fatalf("search by message body: %+v", got)
	}
	if got := decodeChatResponse[domain.DirectChatList](t, admin.do("GET", all+"?q=nomatch", nil), 200); len(got.Items) != 0 {
		t.Fatalf("search should filter: %+v", got)
	}

	page := decodeChatResponse[domain.DirectChatMessages](t, admin.do("GET", all+"/"+th.Contact.ID+"/messages", nil), 200)
	if len(page.Messages) != 2 || page.Messages[0].ID != first.ID || page.Messages[1].ID != reply.ID || page.Messages[0].Mine {
		t.Fatalf("admin should read both sides: %+v", page)
	}
	after := decodeChatResponse[domain.DirectChatMessages](t, admin.do("GET", all+"/"+th.Contact.ID+"/messages?after="+first.ID, nil), 200)
	if len(after.Messages) != 1 || after.Messages[0].ID != reply.ID {
		t.Fatalf("cursor paging: %+v", after)
	}
	// Reading never marks it read for the lead.
	if u := decodeChatResponse[domain.ChatUnread](t, lead.do("GET", "/api/v1/direct-chats/unread", nil), 200); u.Unread != 2 {
		t.Fatalf("lead still has the IT reply and the admin's message unread: %+v", u)
	}

	for _, c := range []*client{lead, it} {
		if r := c.do("GET", all, nil); r.Status != 403 {
			t.Fatalf("only the admin lists every chat: %d", r.Status)
		}
		if r := c.do("GET", all+"/"+th.Contact.ID+"/messages", nil); r.Status != 404 {
			t.Fatalf("only the admin reads other people's chats: %d", r.Status)
		}
	}
	if r := admin.do("GET", all+"/dm_missing/messages", nil); r.Status != 404 {
		t.Fatalf("unknown chat: %d", r.Status)
	}
}
