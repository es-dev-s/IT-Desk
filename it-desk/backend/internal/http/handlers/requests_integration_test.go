package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

type reqView struct {
	ID            string  `json:"id"`
	Ticket        string  `json:"ticket"`
	Type          string  `json:"type"`
	Category      *string `json:"category"`
	Title         string  `json:"title"`
	Device        string  `json:"device"`
	Status        string  `json:"status"`
	Priority      string  `json:"priority"`
	TeamID        *string `json:"teamId"`
	ForMemberName *string `json:"forMemberName"`
	AssigneeID    *string `json:"assigneeId"`
	AssigneeName  *string `json:"assigneeName"`
	StaffID       *string `json:"staffId"`
	StaffName     *string `json:"staffName"`
	StaffTitle    *string `json:"staffTitle"`
	Resolution    string  `json:"resolution"`
	CommentCount  int     `json:"commentCount"`
	ClosedAt      *string `json:"closedAt"`
	Version       int     `json:"version"`
	Items         []struct {
		Kind        string `json:"kind"`
		Quantity    int    `json:"quantity"`
		Description string `json:"description"`
	} `json:"items"`
	Events []struct {
		Kind string `json:"kind"`
		Body string `json:"body"`
	} `json:"events"`
}

type reqList struct {
	Items  []reqView `json:"items"`
	Total  int       `json:"total"`
	Counts struct {
		Open, InProgress, Resolved, Cancelled, Rejected, Total, Unassigned, ActiveIssues int
	} `json:"counts"`
}

func decodeReq(t *testing.T, r resp, want int, what string) reqView {
	t.Helper()
	if r.Status != want {
		t.Fatalf("%s: got %d %s %v, want %d", what, r.Status, r.Error.Code, r.Error.Fields, want)
	}
	var v reqView
	if err := json.Unmarshal(r.Data, &v); err != nil {
		t.Fatalf("%s: %v", what, err)
	}
	return v
}

func listReqs(t *testing.T, c *client, query string) reqList {
	t.Helper()
	r := c.do("GET", "/api/v1/it-requests"+query, nil)
	if r.Status != 200 {
		t.Fatalf("list %s: %d %s", query, r.Status, r.Error.Code)
	}
	var l reqList
	_ = json.Unmarshal(r.Data, &l)
	return l
}

func (c *client) doKey(method, path string, body any, key string) resp {
	c.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, c.base+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.Header.Set("Idempotency-Key", key)
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	var r resp
	_ = json.NewDecoder(res.Body).Decode(&r)
	r.Status, r.Header = res.StatusCode, res.Header
	return r
}

func TestITRequestsLifecycle(t *testing.T) {
	ts, _ := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	peer := newClient(t, ts).mustLogin("lead3@example.com") // same team
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")

	body := map[string]any{
		"items": []map[string]any{{"kind": "laptop", "quantity": 1}, {"kind": "other", "quantity": 2, "description": "USB-C dock"}},
		"notes": "New joiner on Monday", "priority": "high", "forMemberId": "m1",
	}
	// Validation.
	bad := map[string]any{"items": []map[string]any{{"kind": "other", "quantity": 1}}, "notes": "hi"}
	if r := lead.do("POST", "/api/v1/it-requests", bad); r.Status != 422 || r.Error.Fields["items.0.description"] == "" || r.Error.Fields["notes"] == "" {
		t.Errorf("invalid create: %d %v", r.Status, r.Error.Fields)
	}
	other := map[string]any{"items": body["items"], "notes": "For someone else", "forMemberId": "m4"}
	if r := lead.do("POST", "/api/v1/it-requests", other); r.Status != 422 || r.Error.Fields["forMemberId"] == "" {
		t.Errorf("member from another team: %d %v", r.Status, r.Error.Fields)
	}
	if r := lead.do("POST", "/api/v1/it-requests", map[string]any{"items": body["items"], "notes": "x", "bogus": 1}); r.Status != 400 {
		t.Errorf("unknown field: %d", r.Status)
	}
	// IT cannot raise requests.
	if r := it.do("POST", "/api/v1/it-requests", body); r.Status != 403 {
		t.Errorf("IT create: %d", r.Status)
	}

	// Create (idempotent retry returns the same ticket).
	r1 := lead.doKey("POST", "/api/v1/it-requests", body, "req-create-1")
	created := decodeReq(t, r1, 201, "create")
	if created.Ticket != "REQ-1001" || created.Status != "open" || created.Priority != "high" || len(created.Items) != 2 ||
		created.TeamID == nil || *created.TeamID != "t1" || created.ForMemberName == nil || *created.ForMemberName != "Ann Lee" {
		t.Fatalf("created: %+v", created)
	}
	if again := decodeReq(t, lead.doKey("POST", "/api/v1/it-requests", body, "req-create-1"), 201, "replay"); again.ID != created.ID {
		t.Errorf("idempotent replay created %s", again.Ticket)
	}
	if l := listReqs(t, lead, ""); l.Total != 1 || l.Counts.Open != 1 {
		t.Errorf("lead list after create: %+v", l)
	}

	// Admin raises one for the other team, and an org-wide one.
	t2 := decodeReq(t, admin.do("POST", "/api/v1/it-requests", map[string]any{
		"items": []map[string]any{{"kind": "mouse", "quantity": 3}}, "notes": "Mice for Payments", "forMemberId": "m4"}), 201, "admin create t2")
	if t2.TeamID == nil || *t2.TeamID != "t2" || t2.Ticket != "REQ-1002" {
		t.Errorf("admin create t2: %+v", t2)
	}
	org := decodeReq(t, admin.do("POST", "/api/v1/it-requests", map[string]any{
		"items": []map[string]any{{"kind": "cpu", "quantity": 1}}, "notes": "Spare tower for the lab", "priority": "low"}), 201, "admin create org")
	if org.TeamID != nil {
		t.Errorf("org-wide request got team %v", *org.TeamID)
	}

	// Scoping: the lead never sees other teams' requests.
	for _, id := range []string{t2.ID, org.ID} {
		if r := lead.do("GET", "/api/v1/it-requests/"+id, nil); r.Status != 404 {
			t.Errorf("lead read foreign request: %d", r.Status)
		}
		if r := lead.do("POST", "/api/v1/it-requests/"+id+"/comments", map[string]string{"body": "hi"}); r.Status != 404 {
			t.Errorf("lead comment foreign request: %d", r.Status)
		}
		if r := lead.do("POST", "/api/v1/it-requests/"+id+"/cancel", map[string]any{}); r.Status != 404 {
			t.Errorf("lead cancel foreign request: %d", r.Status)
		}
	}
	if l := listReqs(t, lead, ""); l.Total != 1 || l.Counts.Total != 1 {
		t.Errorf("lead sees %d requests (counts %d)", l.Total, l.Counts.Total)
	}
	if l := listReqs(t, admin, ""); l.Total != 3 {
		t.Errorf("admin sees %d requests", l.Total)
	}
	if l := listReqs(t, it, "?status=active&sort=priority"); l.Total != 3 || l.Counts.Unassigned != 3 || l.Items[0].Priority != "high" {
		t.Errorf("IT queue: %+v", l)
	}
	if l := listReqs(t, admin, "?q=dock"); l.Total != 1 || l.Items[0].ID != created.ID {
		t.Errorf("search: %+v", l)
	}
	if r := it.do("GET", "/api/v1/it-requests?status=bogus", nil); r.Status != 422 {
		t.Errorf("bad filter: %d", r.Status)
	}

	// A peer lead in the same team can see and comment but not cancel.
	if r := peer.do("POST", "/api/v1/it-requests/"+created.ID+"/cancel", map[string]any{}); r.Status != 403 || r.Error.Code != "not_requester" {
		t.Errorf("peer cancel: %d %s", r.Status, r.Error.Code)
	}

	// IT workflow.
	var assignees []struct{ ID, Name string }
	if r := it.do("GET", "/api/v1/it-requests/assignees", nil); r.Status == 200 {
		_ = json.Unmarshal(r.Data, &assignees)
	}
	if len(assignees) != 1 || assignees[0].ID != "usr_it" {
		t.Errorf("assignees: %+v", assignees)
	}
	stale := created.Version + 5
	if r := it.do("POST", "/api/v1/it-requests/"+created.ID+"/assign", map[string]any{"assigneeId": "me", "expectedVersion": stale}); r.Status != 409 || r.Error.Code != "stale_request" {
		t.Errorf("stale claim: %d %s", r.Status, r.Error.Code)
	}
	if r := it.do("POST", "/api/v1/it-requests/"+created.ID+"/assign", map[string]any{"assigneeId": "lead_test"}); r.Status != 422 {
		t.Errorf("assign to non-IT: %d", r.Status)
	}
	claimed := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+created.ID+"/assign", map[string]any{"assigneeId": "me", "expectedVersion": created.Version}), 200, "claim")
	if claimed.AssigneeID == nil || *claimed.AssigneeID != "usr_it" || claimed.Version != created.Version+1 {
		t.Errorf("claim: %+v", claimed)
	}
	if r := it.do("POST", "/api/v1/it-requests/"+created.ID+"/status", map[string]any{"status": "resolved"}); r.Status != 409 || r.Error.Code != "invalid_transition" {
		t.Errorf("open→resolved: %d %s", r.Status, r.Error.Code)
	}
	started := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+created.ID+"/status", map[string]any{"status": "in_progress", "expectedVersion": claimed.Version}), 200, "start")
	if started.Status != "in_progress" {
		t.Errorf("start: %s", started.Status)
	}
	if r := lead.do("POST", "/api/v1/it-requests/"+created.ID+"/cancel", map[string]any{}); r.Status != 409 || r.Error.Code != "not_cancellable" {
		t.Errorf("cancel in progress: %d %s", r.Status, r.Error.Code)
	}
	commented := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+created.ID+"/comments", map[string]string{"body": "Imaging the laptop now"}), 201, "IT comment")
	decodeReq(t, lead.do("POST", "/api/v1/it-requests/"+created.ID+"/comments", map[string]string{"body": "Thanks!"}), 201, "lead comment")
	if commented.CommentCount != 1 || commented.Version != started.Version {
		t.Errorf("comment: count %d version %d", commented.CommentCount, commented.Version)
	}
	if r := it.do("POST", "/api/v1/it-requests/"+created.ID+"/comments", map[string]string{"body": "   "}); r.Status != 422 {
		t.Errorf("empty comment: %d", r.Status)
	}
	resolved := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+created.ID+"/status", map[string]any{"status": "resolved", "note": "Delivered to desk"}), 200, "resolve")
	if resolved.Status != "resolved" || resolved.ClosedAt == nil || resolved.Resolution != "Delivered to desk" {
		t.Errorf("resolve: %+v", resolved)
	}
	detail := decodeReq(t, lead.do("GET", "/api/v1/it-requests/"+created.ID, nil), 200, "lead detail")
	var kinds []string
	for _, e := range detail.Events {
		kinds = append(kinds, e.Kind)
	}
	want := []string{"created", "assigned", "status", "comment", "comment", "status"}
	if len(kinds) != len(want) {
		t.Fatalf("timeline: %v", kinds)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Errorf("timeline[%d] = %s, want %s (%v)", i, kinds[i], want[i], kinds)
		}
	}

	// Reject needs a reason.
	if r := it.do("POST", "/api/v1/it-requests/"+org.ID+"/reject", map[string]any{"reason": " "}); r.Status != 422 {
		t.Errorf("reject without reason: %d", r.Status)
	}
	rejected := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+org.ID+"/reject", map[string]any{"reason": "Lab hardware comes from the infra budget"}), 200, "reject")
	if rejected.Status != "rejected" || rejected.AssigneeName == nil {
		t.Errorf("reject: %+v", rejected)
	}
	if r := it.do("POST", "/api/v1/it-requests/"+org.ID+"/reject", map[string]any{"reason": "again"}); r.Status != 409 {
		t.Errorf("reject closed: %d", r.Status)
	}

	// Cancel flow: the requester withdraws while it is still open.
	mine := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{
		"items": []map[string]any{{"kind": "headphone", "quantity": 1}}, "notes": "Headset for the new hire"}), 201, "create 2")
	cancelled := decodeReq(t, lead.do("POST", "/api/v1/it-requests/"+mine.ID+"/cancel", map[string]any{"reason": "Found a spare", "expectedVersion": mine.Version}), 200, "cancel")
	if cancelled.Status != "cancelled" || cancelled.ClosedAt == nil {
		t.Errorf("cancel: %+v", cancelled)
	}
	if r := lead.do("POST", "/api/v1/it-requests/"+mine.ID+"/cancel", map[string]any{}); r.Status != 409 {
		t.Errorf("double cancel: %d", r.Status)
	}
	if l := listReqs(t, lead, "?mine=true"); l.Counts.Resolved != 1 || l.Counts.Cancelled != 1 || l.Total != 2 {
		t.Errorf("lead counts: %+v", l.Counts)
	}
}

func TestITIssuesLifecycle(t *testing.T) {
	ts, _ := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")

	// Validation: issues need a category and a title, and list no items.
	bad := map[string]any{"type": "issue", "items": []map[string]any{{"kind": "laptop", "quantity": 1}}, "notes": "hi", "category": "printer"}
	if r := lead.do("POST", "/api/v1/it-requests", bad); r.Status != 422 || r.Error.Fields["category"] == "" ||
		r.Error.Fields["title"] == "" || r.Error.Fields["items"] == "" || r.Error.Fields["notes"] == "" {
		t.Errorf("invalid issue: %d %v", r.Status, r.Error.Fields)
	}
	if r := lead.do("POST", "/api/v1/it-requests", map[string]any{"type": "incident", "notes": "Something odd"}); r.Status != 422 || r.Error.Fields["type"] == "" {
		t.Errorf("unknown type: %d %v", r.Status, r.Error.Fields)
	}
	if r := it.do("POST", "/api/v1/it-requests", map[string]any{"type": "issue", "category": "network", "title": "No network", "notes": "Floor 3 is down"}); r.Status != 403 {
		t.Errorf("IT report issue: %d", r.Status)
	}

	body := map[string]any{"type": "issue", "category": "hardware", "title": "Laptop won't boot", "device": "LT-0423",
		"notes": "Black screen after the update this morning.", "priority": "urgent", "forMemberId": "m1"}
	issue := decodeReq(t, lead.doKey("POST", "/api/v1/it-requests", body, "issue-create-1"), 201, "create issue")
	if issue.Type != "issue" || issue.Category == nil || *issue.Category != "hardware" || issue.Title != "Laptop won't boot" ||
		issue.Device != "LT-0423" || len(issue.Items) != 0 || issue.Status != "open" || issue.TeamID == nil || *issue.TeamID != "t1" {
		t.Fatalf("created issue: %+v", issue)
	}
	if again := decodeReq(t, lead.doKey("POST", "/api/v1/it-requests", body, "issue-create-1"), 201, "replay"); again.ID != issue.ID {
		t.Errorf("idempotent replay created %s", again.Ticket)
	}
	equip := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{
		"items": []map[string]any{{"kind": "mouse", "quantity": 1}}, "notes": "Spare mouse please"}), 201, "create equipment")
	if equip.Type != "equipment" || equip.Category != nil || equip.Title != "" {
		t.Errorf("equipment request: %+v", equip)
	}
	// Admin reports an issue for the other team: the lead never sees it.
	foreign := decodeReq(t, admin.do("POST", "/api/v1/it-requests", map[string]any{"type": "issue", "category": "network",
		"title": "VPN drops", "notes": "VPN disconnects every few minutes", "teamId": "t2"}), 201, "admin issue t2")
	if r := lead.do("GET", "/api/v1/it-requests/"+foreign.ID, nil); r.Status != 404 {
		t.Errorf("lead read foreign issue: %d", r.Status)
	}

	if l := listReqs(t, lead, ""); l.Total != 2 || l.Counts.ActiveIssues != 1 {
		t.Errorf("lead list: total %d issues %d", l.Total, l.Counts.ActiveIssues)
	}
	if l := listReqs(t, lead, "?type=issue"); l.Total != 1 || l.Items[0].ID != issue.ID {
		t.Errorf("lead issue filter: %+v", l)
	}
	if l := listReqs(t, it, "?type=issue&status=active&sort=priority"); l.Total != 2 || l.Counts.ActiveIssues != 2 || l.Items[0].ID != issue.ID {
		t.Errorf("IT issue queue: %+v", l)
	}
	if l := listReqs(t, admin, "?q=boot"); l.Total != 1 || l.Items[0].ID != issue.ID {
		t.Errorf("search by title: %+v", l)
	}
	if r := it.do("GET", "/api/v1/it-requests?type=bogus", nil); r.Status != 422 {
		t.Errorf("bad type filter: %d", r.Status)
	}

	// Same IT workflow as equipment requests.
	started := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+issue.ID+"/status", map[string]any{"status": "in_progress", "expectedVersion": issue.Version}), 200, "start")
	if started.Status != "in_progress" || started.AssigneeID == nil || *started.AssigneeID != "usr_it" {
		t.Errorf("start: %+v", started)
	}
	if r := lead.do("POST", "/api/v1/it-requests/"+issue.ID+"/status", map[string]any{"status": "resolved"}); r.Status != 403 {
		t.Errorf("lead resolve: %d", r.Status)
	}
	resolved := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+issue.ID+"/status", map[string]any{"status": "resolved", "note": "Reimaged the laptop"}), 200, "resolve")
	if resolved.Status != "resolved" || resolved.Resolution != "Reimaged the laptop" || resolved.Type != "issue" {
		t.Errorf("resolve: %+v", resolved)
	}
	if l := listReqs(t, lead, ""); l.Counts.ActiveIssues != 0 || l.Counts.Resolved != 1 {
		t.Errorf("lead counts after resolve: %+v", l.Counts)
	}
}

type staffView struct {
	ID, Name, Title string
	Active          bool
	SortOrder, Open int
	Version         int
}

func listStaff(t *testing.T, c *client, query string) []staffView {
	t.Helper()
	r := c.do("GET", "/api/v1/it-staff"+query, nil)
	if r.Status != 200 {
		t.Fatalf("staff list %s: %d %s", query, r.Status, r.Error.Code)
	}
	var out []staffView
	_ = json.Unmarshal(r.Data, &out)
	return out
}

func TestITStaffDirectoryAndRouting(t *testing.T) {
	ts, _ := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")

	// Seeded by migration 0011, in roster order, readable by every role.
	want := []string{"Manish Kumar Yadav", "Akash Adhikari", "Abash Thapa", "Ujjal Dahal", "Nabin Baraili"}
	for _, c := range []*client{lead, admin, it} {
		got := listStaff(t, c, "")
		if len(got) != len(want) {
			t.Fatalf("staff list: %+v", got)
		}
		for i := range want {
			if got[i].Name != want[i] || !got[i].Active {
				t.Errorf("staff[%d] = %+v, want %s", i, got[i], want[i])
			}
		}
	}
	if got := listStaff(t, admin, "")[0]; got.ID != "its_manish_yadav" || got.Title != "IT Cell Lead" {
		t.Errorf("lead of IT: %+v", got)
	}

	// Admin-only management.
	for _, c := range []*client{lead, it} {
		if r := c.do("POST", "/api/v1/admin/it-staff", map[string]any{"name": "Someone Else"}); r.Status != 403 {
			t.Errorf("non-admin create staff: %d", r.Status)
		}
	}
	if r := admin.do("POST", "/api/v1/admin/it-staff", map[string]any{"name": " "}); r.Status != 422 || r.Error.Fields["name"] == "" {
		t.Errorf("blank name: %d %v", r.Status, r.Error.Fields)
	}
	if r := admin.do("POST", "/api/v1/admin/it-staff", map[string]any{"name": "abash  thapa"}); r.Status != 422 || r.Error.Fields["name"] == "" {
		t.Errorf("duplicate name: %d %v", r.Status, r.Error.Fields)
	}
	var temp staffView
	if r := admin.do("POST", "/api/v1/admin/it-staff", map[string]any{"name": "  Rita   Shrestha ", "title": "Network Engineer"}); r.Status != 201 {
		t.Fatalf("create staff: %d %v", r.Status, r.Error.Fields)
	} else {
		_ = json.Unmarshal(r.Data, &temp)
	}
	if temp.Name != "Rita Shrestha" || temp.SortOrder != 5 || !temp.Active {
		t.Errorf("created staff: %+v", temp)
	}
	if r := admin.do("PATCH", "/api/v1/admin/it-staff/"+temp.ID, map[string]any{"active": false, "expectedVersion": temp.Version + 3}); r.Status != 409 {
		t.Errorf("stale staff patch: %d", r.Status)
	}
	if r := admin.do("PATCH", "/api/v1/admin/it-staff/"+temp.ID, map[string]any{"active": false, "expectedVersion": temp.Version}); r.Status != 200 {
		t.Fatalf("deactivate: %d %v", r.Status, r.Error.Fields)
	}
	if r := admin.do("PATCH", "/api/v1/admin/it-staff/nope", map[string]any{"title": "x"}); r.Status != 404 {
		t.Errorf("patch unknown: %d", r.Status)
	}
	if n := len(listStaff(t, lead, "?all=true")); n != 5 {
		t.Errorf("lead sees %d staff (inactive must stay hidden)", n)
	}
	if n := len(listStaff(t, admin, "?all=true")); n != 6 {
		t.Errorf("admin ?all=true sees %d staff", n)
	}

	// Create with an assignee (both types); inactive / unknown ids are rejected.
	items := []map[string]any{{"kind": "laptop", "quantity": 1}}
	for _, bad := range []string{temp.ID, "its_nobody"} {
		if r := lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "Needs a laptop", "staffId": bad}); r.Status != 422 || r.Error.Fields["staffId"] == "" {
			t.Errorf("create with staff %s: %d %v", bad, r.Status, r.Error.Fields)
		}
	}
	eq := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "Needs a laptop", "staffId": "its_nabin_baraili"}), 201, "create routed")
	if eq.StaffID == nil || *eq.StaffID != "its_nabin_baraili" || eq.StaffName == nil || *eq.StaffName != "Nabin Baraili" ||
		eq.StaffTitle == nil || *eq.StaffTitle != "Inventory and Purchase Officer" || eq.AssigneeID != nil {
		t.Fatalf("routed request: %+v", eq)
	}
	if len(eq.Events) != 2 || eq.Events[1].Kind != "assigned" || eq.Events[1].Body != "Routed to Nabin Baraili (IT staff)" {
		t.Errorf("routed timeline: %+v", eq.Events)
	}
	issue := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"type": "issue", "category": "network", "title": "No Wi-Fi",
		"notes": "Floor 3 has no Wi-Fi", "staffId": "its_akash_adhikari"}), 201, "issue routed")
	if issue.StaffName == nil || *issue.StaffName != "Akash Adhikari" {
		t.Errorf("routed issue: %+v", issue)
	}
	plain := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "No preference"}), 201, "unrouted")
	if plain.StaffID != nil {
		t.Errorf("unrouted got staff %v", *plain.StaffID)
	}
	if l := listReqs(t, it, "?q=Nabin"); l.Total != 1 || l.Items[0].ID != eq.ID {
		t.Errorf("search by staff: %+v", l)
	}
	if st := listStaff(t, it, ""); st[4].Open != 1 || st[1].Open != 1 || st[0].Open != 0 {
		t.Errorf("staff open counts: %+v", st)
	}

	// Re-routing: IT and admin yes, the lead no; account assignment still works alongside.
	if r := lead.do("POST", "/api/v1/it-requests/"+eq.ID+"/staff", map[string]any{"staffId": "its_abash_thapa"}); r.Status != 403 {
		t.Errorf("lead re-route: %d", r.Status)
	}
	if r := it.do("POST", "/api/v1/it-requests/"+eq.ID+"/staff", map[string]any{"staffId": temp.ID}); r.Status != 422 {
		t.Errorf("route to inactive: %d", r.Status)
	}
	if r := it.do("POST", "/api/v1/it-requests/"+eq.ID+"/staff", map[string]any{"staffId": "its_abash_thapa", "expectedVersion": eq.Version + 9}); r.Status != 409 {
		t.Errorf("stale route: %d", r.Status)
	}
	routed := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+eq.ID+"/staff", map[string]any{"staffId": "its_abash_thapa", "expectedVersion": eq.Version}), 200, "IT route")
	if routed.StaffName == nil || *routed.StaffName != "Abash Thapa" || routed.Version != eq.Version+1 {
		t.Errorf("IT route: %+v", routed)
	}
	claimed := decodeReq(t, it.do("POST", "/api/v1/it-requests/"+eq.ID+"/assign", map[string]any{"assigneeId": "me"}), 200, "claim")
	if claimed.AssigneeID == nil || claimed.StaffName == nil || *claimed.StaffName != "Abash Thapa" {
		t.Errorf("claim keeps staff: %+v", claimed)
	}
	cleared := decodeReq(t, admin.do("POST", "/api/v1/it-requests/"+eq.ID+"/staff", map[string]any{"staffId": ""}), 200, "admin clear")
	if cleared.StaffID != nil || cleared.StaffName != nil {
		t.Errorf("clear: %+v", cleared)
	}
	if again := decodeReq(t, admin.do("POST", "/api/v1/it-requests/"+eq.ID+"/staff", map[string]any{"staffId": ""}), 200, "no-op"); again.Version != cleared.Version {
		t.Errorf("no-op route bumped version")
	}
	decodeReq(t, it.do("POST", "/api/v1/it-requests/"+eq.ID+"/status", map[string]any{"status": "in_progress"}), 200, "start")
	decodeReq(t, it.do("POST", "/api/v1/it-requests/"+eq.ID+"/status", map[string]any{"status": "resolved"}), 200, "resolve")
	if r := it.do("POST", "/api/v1/it-requests/"+eq.ID+"/staff", map[string]any{"staffId": "its_abash_thapa"}); r.Status != 409 {
		t.Errorf("route closed request: %d", r.Status)
	}
}
