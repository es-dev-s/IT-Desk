package handlers

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
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
	unassigned := decodeReq(t, lead.do("POST", "/api/v1/it-requests", map[string]any{"items": items, "notes": "Nobody took this"}), 201, "unassigned request")

	tasks := func(t *testing.T, c *client, query string) taskReport {
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
	all := tasks(t, admin, "")
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
	if got := tasks(t, admin, "?itMember=Manish+Kumar+Yadav"); len(got.Rows) != 1 || got.Rows[0].Ticket != other.Ticket {
		t.Errorf("admin by IT member: %+v", got)
	}
	if got := tasks(t, admin, "?status=completed&teamId=t1"); len(got.Rows) != 1 || got.Rows[0].Ticket != mine.Ticket {
		t.Errorf("admin completed in t1: %+v", got)
	}
	if got := tasks(t, admin, "?q=it-lp-0044"); len(got.Rows) != 1 || got.Rows[0].Ticket != mine.Ticket {
		t.Errorf("admin search by device number: %+v", got)
	}
	// An IT account sees only its own tasks, and can't widen that with a filter.
	for _, q := range []string{"", "?itMember=Manish+Kumar+Yadav", "?itMember=all"} {
		if got := tasks(t, it, q); len(got.Rows) != 1 || got.Rows[0].Ticket != mine.Ticket || len(got.Staff) != 0 {
			t.Errorf("IT tasks %q: %+v", q, got)
		}
	}
	// A lead sees only their team's tasks.
	for _, q := range []string{"", "?teamId=t2"} {
		if got := tasks(t, lead, q); len(got.Rows) != 1 || got.Rows[0].Ticket != mine.Ticket {
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

	// Nepal Time midnight on Nov 17 is Nov 16 at 18:15 UTC. Only the
	// completion of mine and the assignment of other fall on that day.
	for _, update := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE it_request_events SET at = '2026-11-16 18:14:59+00' WHERE request_id = $1 AND kind = 'assigned'`, []any{mine.ID}},
		{`UPDATE it_requests SET closed_at = '2026-11-17 18:14:59+00' WHERE id = $1`, []any{mine.ID}},
		{`UPDATE it_request_events SET at = '2026-11-16 18:15:00+00' WHERE request_id = $1 AND kind = 'assigned'`, []any{other.ID}},
		{`UPDATE it_requests SET assignee_id = 'usr_it', assignee_name = 'Ivan Tech', status = 'resolved',
			created_at = '2026-11-15 17:00:00+00', closed_at = '2026-11-17 18:15:00+00' WHERE id = $1`, []any{unassigned.ID}},
	} {
		if _, err := srv.db.Pool.Exec(context.Background(), update.sql, update.args...); err != nil {
			t.Fatal(err)
		}
	}
	const dates = "?startDate=2026-11-17&endDate=2026-11-17"
	for _, tc := range []struct {
		name    string
		client  *client
		query   string
		tickets []string
	}{
		{"admin entire workspace", admin, dates, []string{other.Ticket, mine.Ticket}},
		{"admin by team and status", admin, dates + "&teamId=t2&status=open", []string{other.Ticket}},
		{"lead own team", lead, dates + "&teamId=t2", []string{mine.Ticket}},
		{"IT own tasks", it, dates + "&itMember=Manish+Kumar+Yadav", []string{mine.Ticket}},
		{"day before", admin, "?startDate=2026-11-16&endDate=2026-11-16", []string{mine.Ticket}},
		{"day after", admin, "?startDate=2026-11-18&endDate=2026-11-18", []string{unassigned.Ticket}},
		{"custom range", admin, "?startDate=2026-11-16&endDate=2026-11-17", []string{other.Ticket, mine.Ticket}},
		{"empty range", admin, "?startDate=2026-11-19&endDate=2026-11-20", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := tasks(t, tc.client, tc.query)
			if len(got.Rows) != len(tc.tickets) {
				t.Fatalf("rows: %+v", got.Rows)
			}
			for i, ticket := range tc.tickets {
				if got.Rows[i].Ticket != ticket {
					t.Errorf("row %d: got %q, want %q", i, got.Rows[i].Ticket, ticket)
				}
			}

			sheet := taskReportSheet(t, tc.client, tc.query+"&format=xlsx")
			if strings.Count(sheet, "<row ") != len(tc.tickets)+1 {
				t.Errorf("workbook has the wrong row count: %s", sheet)
			}
			for _, ticket := range tc.tickets {
				if !strings.Contains(sheet, ticket) {
					t.Errorf("workbook missing %q", ticket)
				}
			}
		})
	}

	sheet := taskReportSheet(t, admin, dates+"&teamId=t2&format=xlsx&utcOffset=0")
	if !strings.Contains(sheet, ">2026-11-17</t>") {
		t.Error("workbook assignment date should match the date shown in Nepal Time")
	}

	for _, query := range []string{
		"?startDate=2026-11-17", "?endDate=2026-11-17",
		"?startDate=2026-02-30&endDate=2026-03-01",
		"?startDate=2026-11-18&endDate=2026-11-17",
	} {
		if r := admin.do("GET", "/api/v1/reports/it-tasks"+query, nil); r.Status != 422 {
			t.Errorf("invalid date range %q: got status %d", query, r.Status)
		}
	}
}

func taskReportSheet(t *testing.T, c *client, query string) string {
	t.Helper()
	r, err := c.http.Get(c.base + "/api/v1/reports/it-tasks" + query)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("workbook response: %d", r.StatusCode)
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	book, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	sheet, err := book.Open("xl/worksheets/sheet1.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer sheet.Close()
	xml, err := io.ReadAll(sheet)
	if err != nil {
		t.Fatal(err)
	}
	return string(xml)
}
