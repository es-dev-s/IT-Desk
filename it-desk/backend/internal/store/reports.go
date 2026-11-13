package store

// Reports: read-only, spreadsheet-shaped views. Scoping is enforced here, not
// in the UI: a team lead is pinned to their own team whatever team they ask
// for, and an IT account only ever gets the tasks assigned to it.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
)

// ReportFilter narrows a report. TeamID "" = every team the caller may see.
type ReportFilter struct {
	TeamID string
	Query  string
	// IT task report only.
	ITMember string // the IT member's name; ignored for IT accounts
	Status   string // "", "completed" or "open"
}

// reportTeam is the team a report is limited to: the lead's own, else the one asked for.
func reportTeam(actor Actor, f ReportFilter) string {
	if scope := actor.TeamScope(); scope != "" {
		return scope
	}
	if f.TeamID == "all" {
		return ""
	}
	return strings.TrimSpace(f.TeamID)
}

// matches reports whether every word of q appears in one of the fields.
func matches(q string, fields ...string) bool {
	hay := strings.ToLower(strings.Join(fields, "\n"))
	for _, word := range strings.Fields(strings.ToLower(q)) {
		if !strings.Contains(hay, word) {
			return false
		}
	}
	return true
}

// MemberDeviceReport lists active people with their seat and each device they hold.
func (s *Store) MemberDeviceReport(ctx context.Context, actor Actor, f ReportFilter) (domain.MemberDeviceReport, error) {
	out := domain.MemberDeviceReport{Rows: []domain.MemberDeviceRow{}, GeneratedAt: domain.NewTime(s.Now())}
	pool, err := s.pool()
	if err != nil {
		return out, err
	}
	rows, err := pool.Query(ctx, `SELECT m.id, m.name, COALESCE(m.employee_id, ''), t.id, t.name, c.code, fl.name,
			d.id, COALESCE(d.kind, ''), COALESCE(d.model, ''), COALESCE(d.asset_tag, '')
		FROM members m
		JOIN teams t ON t.id = m.team_id
		LEFT JOIN floor_cells c ON c.id = m.seat_id
		LEFT JOIN floors fl ON fl.id = c.floor_id
		LEFT JOIN devices d ON d.member_id = m.id
		WHERE m.status = 'active' AND ($1 = '' OR m.team_id = $1)
		ORDER BY t.name, lower(m.name), m.id, d.position, d.id`, reportTeam(actor, f))
	if err != nil {
		return out, err
	}
	defer rows.Close()
	members := map[string]bool{}
	for rows.Next() {
		var r domain.MemberDeviceRow
		if err := rows.Scan(&r.MemberID, &r.MemberName, &r.EmployeeID, &r.TeamID, &r.TeamName, &r.SeatCode, &r.FloorName,
			&r.DeviceID, &r.DeviceKind, &r.DeviceModel, &r.AssetTag); err != nil {
			return out, err
		}
		if !matches(f.Query, r.MemberLabel(), r.TeamName, r.SeatLabel(), r.DeviceLabel()) {
			continue
		}
		out.Rows = append(out.Rows, r)
		members[r.MemberID] = true
		if r.DeviceID != nil {
			out.Devices++
		}
	}
	out.Members = len(members)
	return out, rows.Err()
}

// ITTaskReport lists requests routed to IT members: when each was assigned,
// when it was completed, who it was for and what was done.
func (s *Store) ITTaskReport(ctx context.Context, actor Actor, f ReportFilter) (domain.ITTaskReport, error) {
	out := domain.ITTaskReport{Rows: []domain.ITTaskRow{}, Staff: []domain.ITTaskStaff{}, GeneratedAt: domain.NewTime(s.Now())}
	switch f.Status {
	case "", "all", "completed", "open":
	default:
		return out, domain.Invalid("Unknown status filter.", map[string]string{"status": "Use completed or open"})
	}
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		// Assigned to someone in IT, and not withdrawn or turned down.
		conds := []string{"(r.staff_id IS NOT NULL OR r.assignee_id IS NOT NULL)", "r.status IN ('open','in_progress','resolved')"}
		var args []any
		arg := func(v any) string {
			args = append(args, v)
			return fmt.Sprintf("$%d", len(args))
		}
		if team := reportTeam(actor, f); team != "" {
			conds = append(conds, "r.team_id = "+arg(team))
		}
		if actor.User.Role == "it" {
			// Only what is assigned to this person: by account, or by their staff entry.
			mine, err := myStaffEntry(ctx, tx, actor)
			if err != nil {
				return err
			}
			own := "r.assignee_id = " + arg(actor.User.ID)
			if mine != nil {
				own += " OR r.staff_id = " + arg(*mine)
			}
			conds = append(conds, "("+own+")")
		} else {
			// The filter's choices: everyone with a task in the caller's scope.
			// (A task is under the staff member it is routed to, else the IT account that took it.)
			srows, err := tx.Query(ctx, `SELECT DISTINCT COALESCE(r.staff_name, r.assignee_name) FROM it_requests r
				WHERE COALESCE(r.staff_name, r.assignee_name, '') <> '' AND `+strings.Join(conds, " AND ")+` ORDER BY 1`, args...)
			if err != nil {
				return err
			}
			for srows.Next() {
				var st domain.ITTaskStaff
				if err := srows.Scan(&st.Name); err != nil {
					srows.Close()
					return err
				}
				st.ID = st.Name
				out.Staff = append(out.Staff, st)
			}
			srows.Close()
			if err := srows.Err(); err != nil {
				return err
			}
			if name := strings.TrimSpace(f.ITMember); name != "" && name != "all" {
				conds = append(conds, "COALESCE(r.staff_name, r.assignee_name, '') = "+arg(name))
			}
		}
		switch f.Status {
		case "completed":
			conds = append(conds, "r.status = 'resolved'")
		case "open":
			conds = append(conds, "r.status <> 'resolved'")
		}
		rows, err := tx.Query(ctx, `SELECT r.id, r.ticket, r.request_type, r.status,
				COALESCE((SELECT max(e.at) FROM it_request_events e WHERE e.request_id = r.id AND e.kind = 'assigned'), r.started_at, r.created_at),
				r.closed_at, r.staff_id, COALESCE(r.staff_name, r.assignee_name, ''), r.team_id, COALESCE(t.name, ''),
				COALESCE(NULLIF(r.for_member_name, ''), r.requester_name), r.issue_category, r.title, r.device, r.resolution
			FROM it_requests r LEFT JOIN teams t ON t.id = r.team_id
			WHERE `+strings.Join(conds, " AND ")+`
			ORDER BY 5 DESC, r.id`, args...)
		if err != nil {
			return err
		}
		type extra struct {
			category                  *string
			title, device, resolution string
		}
		var list []domain.ITTaskRow
		extras := map[string]extra{}
		var ids []string
		for rows.Next() {
			var r domain.ITTaskRow
			var x extra
			var assigned time.Time
			var closed *time.Time
			if err := rows.Scan(&r.RequestID, &r.Ticket, &r.Type, &r.Status, &assigned, &closed, &r.StaffID, &r.ITMember, &r.TeamID, &r.TeamName,
				&r.MemberName, &x.category, &x.title, &x.device, &x.resolution); err != nil {
				rows.Close()
				return err
			}
			r.AssignedAt = domain.NewTime(assigned)
			if closed != nil && r.Status == domain.RequestResolved {
				v := domain.NewTime(*closed)
				r.CompletedAt = &v
			}
			list = append(list, r)
			extras[r.RequestID] = x
			ids = append(ids, r.RequestID)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		items := map[string][]domain.ITRequestItem{}
		if len(ids) > 0 {
			irows, err := tx.Query(ctx, `SELECT request_id, kind, quantity, description FROM it_request_items WHERE request_id = ANY($1) ORDER BY request_id, position, kind`, ids)
			if err != nil {
				return err
			}
			for irows.Next() {
				var id string
				var it domain.ITRequestItem
				if err := irows.Scan(&id, &it.Kind, &it.Quantity, &it.Description); err != nil {
					irows.Close()
					return err
				}
				items[id] = append(items[id], it)
			}
			irows.Close()
			if err := irows.Err(); err != nil {
				return err
			}
		}
		for _, r := range list {
			x := extras[r.RequestID]
			r.Description = domain.ITTaskDescription(r.Type, r.Status, x.category, x.title, x.device, items[r.RequestID], x.resolution)
			if !matches(f.Query, r.Ticket, r.ITMember, r.TeamName, r.MemberName, r.Description) {
				continue
			}
			out.Rows = append(out.Rows, r)
			if r.CompletedAt != nil {
				out.Completed++
			}
		}
		return nil
	})
	return out, err
}
