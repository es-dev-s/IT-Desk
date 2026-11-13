package handlers

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type memberReport struct {
	Rows []struct {
		MemberID   string  `json:"memberId"`
		MemberName string  `json:"memberName"`
		TeamID     string  `json:"teamId"`
		SeatCode   *string `json:"seatCode"`
		AssetTag   string  `json:"assetTag"`
	} `json:"rows"`
	Members int `json:"members"`
	Devices int `json:"devices"`
}

type taskReport struct {
	Rows []struct {
		Ticket      string  `json:"ticket"`
		Status      string  `json:"status"`
		CompletedAt *string `json:"completedAt"`
		ITMember    string  `json:"itMember"`
		TeamID      *string `json:"teamId"`
		MemberName  string  `json:"memberName"`
		Description string  `json:"description"`
	} `json:"rows"`
	Staff []struct {
		ID string `json:"id"`
	} `json:"staff"`
	Completed int `json:"completed"`
}

// Reports follow the caller's role: a lead only ever gets their own team, an
// IT account gets every member but only its own tasks, an admin gets it all.
func TestReportsScopingAndExport(t *testing.T) {
	ts, srv := liveServer(t)
	lead := newClient(t, ts).mustLogin("lead@example.com")
	admin := newClient(t, ts).mustLogin("admin@example.com")
	it := newClient(t, ts).mustLogin("it@example.com")
	if _, err := srv.db.Pool.Exec(context.Background(), `INSERT INTO devices (id, member_id, kind, model, asset_tag, position) VALUES
		('d1','m1','laptop','ThinkPad T14','IT-LP-0001',0), ('d2','m1','monitor','Dell U2422','IT-MN-0002',1), ('d3','m4','laptop','MacBook Air','IT-LP-0003',0)`); err != nil {
		t.Fatal(err)
	}
	members := func(c *client, query string) memberReport {
		t.Helper()
		r := c.do("GET", "/api/v1/reports/members"+query, nil)
		if r.Status != 200 {
			t.Fatalf("member report %s: %d %s", query, r.Status, r.Error.Code)
		}
		var out memberReport
		if err := json.Unmarshal(r.Data, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	// Admin and IT: the whole workspace (m1 has two devices, m2 none, m4 one), or one team.
	for name, c := range map[string]*client{"admin": admin, "it": it} {
		if all := members(c, ""); all.Members != 3 || all.Devices != 3 || len(all.Rows) != 4 {
			t.Errorf("%s all teams: %+v", name, all)
		}
		if t2 := members(c, "?teamId=t2"); t2.Members != 1 || len(t2.Rows) != 1 || t2.Rows[0].MemberID != "m4" || t2.Rows[0].AssetTag != "IT-LP-0003" {
			t.Errorf("%s team t2: %+v", name, t2)
		}
	}
	// A lead is pinned to their own team whatever they ask for.
	for _, q := range []string{"", "?teamId=t2", "?teamId=all"} {
		got := members(lead, q)
		if got.Members != 2 || len(got.Rows) != 3 {
			t.Errorf("lead %q: %+v", q, got)
		}
		for _, row := range got.Rows {
			if row.TeamID != "t1" {
				t.Errorf("lead %q saw another team's member: %+v", q, row)
			}
		}
	}
	// Search matches a person or a device.
	if got := members(admin, "?q=it-mn-0002"); len(got.Rows) != 1 || got.Rows[0].MemberID != "m1" || got.Devices != 1 {
		t.Errorf("search by device number: %+v", got)
	}
	if got := members(admin, "?q=bo+chen"); len(got.Rows) != 1 || got.Rows[0].MemberID != "m2" || got.Rows[0].AssetTag != "" {
		t.Errorf("search by name: %+v", got)
	}
	if got := members(lead, "?q=macbook"); len(got.Rows) != 0 {
		t.Errorf("lead found another team's device: %+v", got)
	}

	// Tasks: one for t1 done by Ivan's account, one for t2 routed to someone else, one nobody has taken.
	items := []map[string]any{{"kind": "laptop", "quantity": 1}}
	mine := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "New joiner laptop", "forMemberId": "m1"}), 201, "t1 request")
	decodeReq(t, it.do("POST", "/api/v1/it-requests/"+mine.ID+"/assign", map[string]any{"assigneeId": "me"}), 200, "claim")
	decodeReq(t, it.do("POST", "/api/v1/it-requests/"+mine.ID+"/status", map[string]any{"status": "in_progress"}), 200, "start")
	decodeReq(t, it.do("POST", "/api/v1/it-requests/"+mine.ID+"/status", map[string]any{"status": "resolved", "note": "Gave IT-LP-0044"}), 200, "resolve")
	other := decodeReq(t, admin.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "Payments laptop", "teamId": "t2", "staffId": "its_manish_yadav"}), 201, "t2 request")
	decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "Nobody took this"}), 201, "unassigned request")

	tasks := func(c *client, query string) taskReport {
		t.Helper()
		r := c.do("GET", "/api/v1/reports/it-tasks"+query, nil)
		if r.Status != 200 {
			t.Fatalf("task report %s: %d %s", query, r.Status, r.Error.Code)
		}
		var out taskReport
		if err := json.Unmarshal(r.Data, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	all := tasks(admin, "")
	if len(all.Rows) != 2 || all.Completed != 1 || len(all.Staff) != 2 || all.Staff[0].ID != "Ivan Tech" || all.Staff[1].ID != "Manish Kumar Yadav" {
		t.Fatalf("admin tasks: %+v", all)
	}
	for _, row := range all.Rows {
		if row.Ticket == mine.Ticket && (row.Status != "resolved" || row.CompletedAt == nil || row.MemberName != "Ann Lee" || row.ITMember != "Ivan Tech" ||
			row.Description != "New device given: Laptop · Resolution: Gave IT-LP-0044") {
			t.Errorf("completed task row: %+v", row)
		}
		if row.Ticket == other.Ticket && (row.CompletedAt != nil || !strings.HasPrefix(row.Description, "New device requested: Laptop")) {
			t.Errorf("open task row: %+v", row)
		}
	}
	if got := tasks(admin, "?itMember=Manish+Kumar+Yadav"); len(got.Rows) != 1 || got.Rows[0].Ticket != other.Ticket {
		t.Errorf("admin by IT member: %+v", got)
	}
	if got := tasks(admin, "?status=completed&teamId=t1"); len(got.Rows) != 1 || got.Rows[0].Ticket != mine.Ticket {
		t.Errorf("admin completed in t1: %+v", got)
	}
	if got := tasks(admin, "?q=it-lp-0044"); len(got.Rows) != 1 || got.Rows[0].Ticket != mine.Ticket {
		t.Errorf("admin search by device number: %+v", got)
	}
	// An IT account sees only its own tasks, and can't widen that with a filter.
	for _, q := range []string{"", "?itMember=Manish+Kumar+Yadav", "?itMember=all"} {
		if got := tasks(it, q); len(got.Rows) != 1 || got.Rows[0].Ticket != mine.Ticket || len(got.Staff) != 0 {
			t.Errorf("IT tasks %q: %+v", q, got)
		}
	}
	// A lead sees only their team's tasks.
	for _, q := range []string{"", "?teamId=t2"} {
		if got := tasks(lead, q); len(got.Rows) != 1 || got.Rows[0].Ticket != mine.Ticket {
			t.Errorf("lead tasks %q: %+v", q, got)
		}
	}
	if r := admin.do("GET", "/api/v1/reports/it-tasks?status=bogus", nil); r.Status != 422 {
		t.Errorf("bad status: %d", r.Status)
	}

	// Excel downloads.
	for _, path := range []string{"/api/v1/reports/members?format=xlsx", "/api/v1/reports/it-tasks?format=xlsx&utcOffset=345"} {
		r := lead.do("GET", path, nil)
		if r.Status != 200 || !strings.Contains(r.Header.Get("Content-Type"), "spreadsheetml") ||
			!strings.Contains(r.Header.Get("Content-Disposition"), ".xlsx") {
			t.Errorf("%s: %d %v", path, r.Status, r.Header)
		}
	}
	if r := lead.do("GET", "/api/v1/reports/members?format=pdf", nil); r.Status != 422 {
		t.Errorf("bad format: %d", r.Status)
	}
}
