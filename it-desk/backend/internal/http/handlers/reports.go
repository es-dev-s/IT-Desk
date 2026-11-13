package handlers

// Reports. Scoping is in the store: leads get their own team, IT accounts get
// the member report workspace-wide but only their own IT tasks.
//
//	GET /api/v1/reports/members   ?teamId=&q=&format=xlsx              reports.view
//	GET /api/v1/reports/it-tasks  ?teamId=&itMember=&status=&q=&format=xlsx  reports.view
//
// format=xlsx downloads the same rows as an Excel workbook; utcOffset (minutes
// east of UTC) sets the day its dates are written in.

import (
	"net/http"
	"strconv"
	"time"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/store"
	"itdesk/backend/internal/xlsx"
)

func (s *Server) reportRoutes(read route) {
	read("GET /api/v1/reports/members", auth.PermViewReports, s.getMemberDeviceReport)
	read("GET /api/v1/reports/it-tasks", auth.PermViewReports, s.getITTaskReport)
}

func reportFilter(r *http.Request) store.ReportFilter {
	q := r.URL.Query()
	return store.ReportFilter{TeamID: q.Get("teamId"), Query: q.Get("q"), ITMember: q.Get("itMember"), Status: q.Get("status")}
}

// wantsXLSX reports whether the caller asked for the Excel download; any other format is an error.
func wantsXLSX(r *http.Request) (bool, error) {
	switch r.URL.Query().Get("format") {
	case "", "json":
		return false, nil
	case "xlsx":
		return true, nil
	}
	return false, domain.Invalid("Unknown format.", map[string]string{"format": "Use xlsx"})
}

// exportZone is the reader's timezone for dates in a download (UTC if absent or absurd).
func exportZone(r *http.Request) *time.Location {
	m, err := strconv.Atoi(r.URL.Query().Get("utcOffset"))
	if err != nil || m < -14*60 || m > 14*60 {
		return time.UTC
	}
	return time.FixedZone("", m*60)
}

func (s *Server) sendXLSX(w http.ResponseWriter, r *http.Request, name string, sheet xlsx.Sheet) {
	data, err := xlsx.Bytes(sheet)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+"-"+s.store.Now().In(exportZone(r)).Format("2006-01-02")+`.xlsx"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) getMemberDeviceReport(w http.ResponseWriter, r *http.Request, a store.Actor) {
	asXLSX, err := wantsXLSX(r)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	rep, err := s.store.MemberDeviceReport(r.Context(), a, reportFilter(r))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	if !asXLSX {
		ok(w, http.StatusOK, rep)
		return
	}
	sheet := xlsx.Sheet{Name: "Members & devices", Headers: []string{"Member Name (ID)", "Team", "Seat Number", "Device Name", "Device Number"},
		Widths: []float64{34, 24, 26, 34, 18}}
	for _, row := range rep.Rows {
		device := row
		device.AssetTag = "" // the number has its own column
		sheet.Rows = append(sheet.Rows, []string{row.MemberLabel(), row.TeamName, row.SeatLabel(), device.DeviceLabel(), row.AssetTag})
	}
	s.sendXLSX(w, r, "member-device-report", sheet)
}

func (s *Server) getITTaskReport(w http.ResponseWriter, r *http.Request, a store.Actor) {
	asXLSX, err := wantsXLSX(r)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	rep, err := s.store.ITTaskReport(r.Context(), a, reportFilter(r))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	if !asXLSX {
		ok(w, http.StatusOK, rep)
		return
	}
	zone := exportZone(r)
	day := func(t time.Time) string { return t.In(zone).Format("2006-01-02") }
	sheet := xlsx.Sheet{Name: "IT tasks", Headers: []string{"Assigned Date", "Completed Date", "Team Member Name", "Team", "IT Member", "Request", "Status", "Task Description"},
		Widths: []float64{14, 15, 26, 22, 24, 12, 13, 70}}
	status := map[string]string{"open": "Assigned", "in_progress": "In progress", "resolved": "Completed"}
	for _, row := range rep.Rows {
		done := ""
		if row.CompletedAt != nil {
			done = day(row.CompletedAt.Time)
		}
		sheet.Rows = append(sheet.Rows, []string{day(row.AssignedAt.Time), done, row.MemberName, row.TeamName, row.ITMember, row.Ticket, status[row.Status], row.Description})
	}
	s.sendXLSX(w, r, "it-task-report", sheet)
}
