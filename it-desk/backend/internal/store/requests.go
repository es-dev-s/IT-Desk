package store

// IT requests: equipment / support asks that are independent of transfers.
// Every read and write is confined by Actor.TeamScope(), so a team lead can
// never see or touch another team's request (it simply does not exist for
// them: 404, not 403).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
)

var (
	errRequestNotFound = domain.NotFound("Request not found.")
	errStaleRequest    = domain.Conflict("stale_request", "This request was updated by someone else. Refresh and try again.")
)

// RequestFilter narrows GET /it-requests.
type RequestFilter struct {
	Status   string // "", "active" (open+in_progress), "closed", or a status
	Type     string // "", "equipment" or "issue"
	Query    string
	TeamID   string // admin/IT only; leads are pinned to their team
	Assignee string // "", "me", "none", or a user id
	Mine     bool   // only requests raised by the caller
	Sort     string // "newest" (default) or "priority"
	Limit    int
	Offset   int
}

const requestSelect = `SELECT r.id, r.ticket, r.request_type, r.issue_category, r.title, r.device, r.status, r.priority, r.notes, r.requester_id, r.requester_name, r.requester_role,
	r.team_id, t.name, t.code, r.for_member_id, r.for_member_name, r.assignee_id, r.assignee_name,
	r.staff_id, r.staff_name, st.title, r.resolution,
	(SELECT count(*) FROM it_request_events e WHERE e.request_id = r.id AND e.kind = 'comment'),
	r.created_at, r.updated_at, r.started_at, r.closed_at, r.version,
	r.acknowledged_by, r.acknowledged_by_name, r.acknowledged_at,
	COALESCE((SELECT json_agg(json_build_object('kind', i.kind, 'quantity', i.quantity, 'description', i.description)
		ORDER BY i.position) FROM it_request_items i WHERE i.request_id = r.id), '[]'::json)
	FROM it_requests r LEFT JOIN teams t ON t.id = r.team_id LEFT JOIN it_staff st ON st.id = r.staff_id`

func scanRequests(rows pgx.Rows) ([]domain.ITRequest, error) {
	defer rows.Close()
	out := []domain.ITRequest{}
	for rows.Next() {
		var r domain.ITRequest
		var created, updated time.Time
		var started, closed *time.Time
		var items []byte
		var ackBy, ackName *string
		var ackAt *time.Time
		if err := rows.Scan(&r.ID, &r.Ticket, &r.Type, &r.Category, &r.Title, &r.Device, &r.Status, &r.Priority, &r.Notes, &r.RequesterID, &r.RequesterName, &r.RequesterRole,
			&r.TeamID, &r.TeamName, &r.TeamCode, &r.ForMemberID, &r.ForMemberName, &r.AssigneeID, &r.AssigneeName,
			&r.StaffID, &r.StaffName, &r.StaffTitle, &r.Resolution,
			&r.CommentCount, &created, &updated, &started, &closed, &r.Version, &ackBy, &ackName, &ackAt, &items); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(items, &r.Items); err != nil {
			return nil, fmt.Errorf("request %s items: %w", r.ID, err)
		}
		r.CreatedAt, r.UpdatedAt = domain.NewTime(created), domain.NewTime(updated)
		r.Acknowledgement = domain.NewAcknowledgement(ackBy, ackName, ackAt)
		if started != nil {
			t := domain.NewTime(*started)
			r.StartedAt = &t
		}
		if closed != nil {
			t := domain.NewTime(*closed)
			r.ClosedAt = &t
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func loadRequestDetail(ctx context.Context, q querier, actor Actor, id string) (domain.ITRequestDetail, error) {
	args := []any{id}
	where := " WHERE r.id = $1"
	if scope := actor.TeamScope(); scope != "" {
		where += " AND r.team_id = $2"
		args = append(args, scope)
	}
	rows, err := q.Query(ctx, requestSelect+where, args...)
	if err != nil {
		return domain.ITRequestDetail{}, err
	}
	list, err := scanRequests(rows)
	if err != nil {
		return domain.ITRequestDetail{}, err
	}
	if len(list) == 0 {
		return domain.ITRequestDetail{}, errRequestNotFound
	}
	d := domain.ITRequestDetail{ITRequest: list[0], Events: []domain.ITRequestEvent{}}
	erows, err := q.Query(ctx, `SELECT id, kind, actor_id, actor_name, actor_role, body, from_status, to_status, at
		FROM it_request_events WHERE request_id = $1 ORDER BY at, id`, id)
	if err != nil {
		return d, err
	}
	defer erows.Close()
	for erows.Next() {
		var e domain.ITRequestEvent
		var at time.Time
		if err := erows.Scan(&e.ID, &e.Kind, &e.ActorID, &e.ActorName, &e.ActorRole, &e.Body, &e.FromStatus, &e.ToStatus, &at); err != nil {
			return d, err
		}
		e.At = domain.NewTime(at)
		d.Events = append(d.Events, e)
	}
	return d, erows.Err()
}

// ITRequests lists requests in the caller's scope with per-status counts.
func (s *Store) ITRequests(ctx context.Context, actor Actor, f RequestFilter) (domain.ITRequestList, error) {
	out := domain.ITRequestList{Items: []domain.ITRequest{}}
	if _, err := s.pool(); err != nil {
		return out, err
	}
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 100
	}
	if f.Offset < 0 {
		f.Offset = 0
	}
	var scopeConds []string
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if scope := actor.TeamScope(); scope != "" {
		scopeConds = append(scopeConds, "r.team_id = "+arg(scope))
	} else if f.TeamID != "" {
		scopeConds = append(scopeConds, "r.team_id = "+arg(f.TeamID))
	}
	if f.Mine {
		scopeConds = append(scopeConds, "r.requester_id = "+arg(actor.User.ID))
	}
	conds := append([]string{}, scopeConds...)
	switch f.Status {
	case "":
	case "active":
		conds = append(conds, "r.status IN ('open','in_progress')")
	case "closed":
		conds = append(conds, "r.status IN ('resolved','cancelled','rejected')")
	default:
		if !domain.IsRequestStatus(f.Status) {
			return out, domain.Invalid("Unknown status filter.", map[string]string{"status": "Unknown status"})
		}
		conds = append(conds, "r.status = "+arg(f.Status))
	}
	if f.Type != "" {
		if !domain.IsRequestType(f.Type) {
			return out, domain.Invalid("Unknown type filter.", map[string]string{"type": "Unknown type"})
		}
		conds = append(conds, "r.request_type = "+arg(f.Type))
	}
	switch f.Assignee {
	case "":
	case "me":
		conds = append(conds, "r.assignee_id = "+arg(actor.User.ID))
	case "none":
		conds = append(conds, "r.assignee_id IS NULL")
	default:
		conds = append(conds, "r.assignee_id = "+arg(f.Assignee))
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		if len(q) > 100 {
			q = q[:100]
		}
		p := arg("%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%")
		conds = append(conds, fmt.Sprintf(`(r.ticket ILIKE %[1]s OR r.notes ILIKE %[1]s OR r.title ILIKE %[1]s OR r.device ILIKE %[1]s
			OR COALESCE(r.issue_category,'') ILIKE %[1]s OR r.requester_name ILIKE %[1]s
			OR COALESCE(r.for_member_name,'') ILIKE %[1]s OR COALESCE(r.assignee_name,'') ILIKE %[1]s OR COALESCE(r.staff_name,'') ILIKE %[1]s OR COALESCE(t.name,'') ILIKE %[1]s
			OR EXISTS (SELECT 1 FROM it_request_items i WHERE i.request_id = r.id AND (i.kind ILIKE %[1]s OR i.description ILIKE %[1]s)))`, p))
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}
	order := " ORDER BY r.created_at DESC, r.id"
	if f.Sort == "priority" {
		order = ` ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
			CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, r.created_at, r.id`
	}

	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM it_requests r LEFT JOIN teams t ON t.id = r.team_id"+where, args...).
			Scan(&out.Total); err != nil {
			return err
		}
		lim := fmt.Sprintf(" LIMIT %d OFFSET %d", f.Limit, f.Offset)
		rows, err := tx.Query(ctx, requestSelect+where+order+lim, args...)
		if err != nil {
			return err
		}
		if out.Items, err = scanRequests(rows); err != nil {
			return err
		}
		cwhere := ""
		if len(scopeConds) > 0 {
			cwhere = " WHERE " + strings.Join(scopeConds, " AND ")
		}
		c := &out.Counts
		return tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='open'), count(*) FILTER (WHERE status='in_progress'),
			count(*) FILTER (WHERE status='resolved'), count(*) FILTER (WHERE status='cancelled'),
			count(*) FILTER (WHERE status='rejected'), count(*),
			count(*) FILTER (WHERE status IN ('open','in_progress') AND assignee_id IS NULL),
			count(*) FILTER (WHERE status IN ('open','in_progress') AND request_type = 'issue')
			FROM it_requests r`+cwhere, args[:countArgs(scopeConds)]...).
			Scan(&c.Open, &c.InProgress, &c.Resolved, &c.Cancelled, &c.Rejected, &c.Total, &c.Unassigned, &c.ActiveIssues)
	})
	return out, err
}

// countArgs: scope conditions are always added first and each binds exactly
// one argument, so the counts query reuses that prefix of args.
func countArgs(scopeConds []string) int { return len(scopeConds) }

// ITRequest reads one request (with its timeline) in the caller's scope.
func (s *Store) ITRequest(ctx context.Context, actor Actor, id string) (domain.ITRequestDetail, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.ITRequestDetail{}, err
	}
	return loadRequestDetail(ctx, pool, actor, id)
}

// CreateITRequest raises an equipment request or reports an issue. Leads raise
// for their own team; admins may pick a team (or none = org-wide). An optional
// member must belong to it.
func (s *Store) CreateITRequest(ctx context.Context, actor Actor, in domain.ITRequestInput) (domain.ITRequestDetail, error) {
	var out domain.ITRequestDetail
	if actor.User.Role != "admin" && actor.User.Role != "team_lead" {
		return out, domain.Forbidden("forbidden", "Only admins and team leads can raise IT requests.")
	}
	if errs := in.Validate(); len(errs) > 0 {
		return out, domain.Invalid("Please fix the highlighted fields.", errs)
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var teamID *string
		if scope := actor.TeamScope(); scope != "" {
			teamID = &scope
		} else if actor.User.Role == "team_lead" {
			return domain.Forbidden("no_team", "Your account is not linked to a team.")
		} else if in.TeamID != "" {
			var ok bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM teams WHERE id = $1)`, in.TeamID).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return domain.Invalid("Please fix the highlighted fields.", map[string]string{"teamId": "Unknown team"})
			}
			teamID = &in.TeamID
		}
		var memberName *string
		var memberID *string
		if in.ForMemberID != "" {
			var name, team, status string
			err := tx.QueryRow(ctx, `SELECT name, team_id, status FROM members WHERE id = $1`, in.ForMemberID).Scan(&name, &team, &status)
			msg := "Choose someone in your team"
			if actor.User.Role == "admin" {
				msg = "Choose someone in the selected team"
			}
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && teamID != nil && team != *teamID) {
				return domain.Invalid("Please fix the highlighted fields.", map[string]string{"forMemberId": msg})
			}
			if err != nil {
				return err
			}
			if status != "active" {
				return domain.Invalid("Please fix the highlighted fields.", map[string]string{"forMemberId": name + " is no longer active"})
			}
			if teamID == nil {
				teamID = &team
			}
			memberName, memberID = &name, &in.ForMemberID
		}
		var staffID, staffName *string
		if in.StaffID != "" {
			n, err := activeStaff(ctx, tx, in.StaffID)
			if err != nil {
				return err
			}
			staffID, staffName = &in.StaffID, &n
		}
		var seq int64
		if err := tx.QueryRow(ctx, `SELECT nextval('request_seq')`).Scan(&seq); err != nil {
			return err
		}
		id, ticket, now := NewID("req"), fmt.Sprintf("REQ-%04d", seq), s.Now()
		var category *string
		if in.Type == domain.RequestTypeIssue {
			category = &in.Category
		}
		if _, err := tx.Exec(ctx, `INSERT INTO it_requests (id, ticket, requester_id, requester_name, requester_role, team_id,
			for_member_id, for_member_name, notes, priority, request_type, issue_category, title, device, staff_id, staff_name, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
			id, ticket, actor.User.ID, actor.User.Name, actor.User.Role, teamID, memberID, memberName, in.Notes, in.Priority,
			in.Type, category, in.Title, in.Device, staffID, staffName, now); err != nil {
			return err
		}
		for i, it := range in.Items {
			if _, err := tx.Exec(ctx, `INSERT INTO it_request_items (request_id, kind, quantity, description, position)
				VALUES ($1,$2,$3,$4,$5)`, id, it.Kind, it.Quantity, it.Description, i); err != nil {
				return err
			}
		}
		to := domain.RequestOpen
		if err := addRequestEvent(ctx, tx, actor, id, "created", "", nil, &to, now); err != nil {
			return err
		}
		if staffName != nil {
			if err := addRequestEvent(ctx, tx, actor, id, "assigned", "Routed to "+*staffName+" (IT staff)", nil, nil, now); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, actor, "it_request.created", "it_request", id, map[string]any{
			"ticket": ticket, "type": in.Type, "category": category, "title": in.Title, "team": teamID, "forMember": memberID,
			"priority": in.Priority, "items": in.Items, "staff": staffID, "staffName": staffName}); err != nil {
			return err
		}
		body := actor.User.Name
		if name := teamName(ctx, tx, teamID); name != "" {
			body += " · " + name
		} else {
			body += " · org-wide"
		}
		if memberName != nil {
			body += " · for " + *memberName
		}
		body += " · " + priorityLabel(in.Priority)
		if staffName != nil {
			body += " · for " + *staffName
		}
		if err := s.fanOutRequest(ctx, tx, actor, id, domain.NotifyRequestCreated, "created", "", body, false); err != nil {
			return err
		}
		var err error
		out, err = loadRequestDetail(ctx, tx, actor, id)
		return err
	})
	return out, err
}

func addRequestEvent(ctx context.Context, q querier, actor Actor, id, kind, body string, from, to *string, at time.Time) error {
	_, err := q.Exec(ctx, `INSERT INTO it_request_events (request_id, kind, actor_id, actor_name, actor_role, body, from_status, to_status, at)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9)`, id, kind, actor.User.ID, actor.User.Name, actor.User.Role, body, from, to, at)
	return err
}

type lockedRequest struct {
	status, ticket string
	requesterID    *string
	assigneeID     *string
	version        int
	acknowledgedAt *time.Time
}

// lockRequest row-locks a request in the caller's scope and checks the
// optimistic version when the client sent one.
func lockRequest(ctx context.Context, tx pgx.Tx, actor Actor, id string, expected *int) (lockedRequest, error) {
	var r lockedRequest
	var team *string
	err := tx.QueryRow(ctx, `SELECT status, ticket, requester_id, assignee_id, version, team_id, acknowledged_at FROM it_requests WHERE id = $1 FOR UPDATE`, id).
		Scan(&r.status, &r.ticket, &r.requesterID, &r.assigneeID, &r.version, &team, &r.acknowledgedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, errRequestNotFound
	}
	if err != nil {
		return r, err
	}
	if scope := actor.TeamScope(); scope != "" && (team == nil || *team != scope) {
		return r, errRequestNotFound
	}
	if expected != nil && *expected != r.version {
		return r, errStaleRequest
	}
	return r, nil
}

// RequestAction is the body shared by the state-changing endpoints.
type RequestAction struct {
	ExpectedVersion *int
	Note            string
}

// CancelITRequest lets the requester withdraw a request while it is still open.
func (s *Store) CancelITRequest(ctx context.Context, actor Actor, id string, act RequestAction) (domain.ITRequestDetail, error) {
	var out domain.ITRequestDetail
	note, ok := domain.ValidateRequestText(act.Note, 0, domain.MaxResolution)
	if !ok {
		return out, domain.Invalid("Please fix the highlighted fields.", map[string]string{"reason": fmt.Sprintf("Keep it under %d characters", domain.MaxResolution)})
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		r, err := lockRequest(ctx, tx, actor, id, act.ExpectedVersion)
		if err != nil {
			return err
		}
		if r.requesterID == nil || *r.requesterID != actor.User.ID {
			return domain.Forbidden("not_requester", "Only the person who raised this request can cancel it.")
		}
		if r.status != domain.RequestOpen {
			return domain.Conflict("not_cancellable", "IT has already picked this up, so it can no longer be cancelled. Add a comment instead.")
		}
		now := s.Now()
		if _, err := tx.Exec(ctx, `UPDATE it_requests SET status='cancelled', resolution=$2, closed_at=$3, updated_at=$3,
			version=version+1 WHERE id=$1`, id, note, now); err != nil {
			return err
		}
		from, to := r.status, domain.RequestCancelled
		if err := addRequestEvent(ctx, tx, actor, id, "cancelled", note, &from, &to, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "it_request.cancelled", "it_request", id, map[string]any{"ticket": r.ticket, "reason": note}); err != nil {
			return err
		}
		if err := s.fanOutRequest(ctx, tx, actor, id, domain.NotifyRequestCancelled, "cancelled",
			"{ticket} was cancelled by "+actor.User.Name, note, true); err != nil {
			return err
		}
		out, err = loadRequestDetail(ctx, tx, actor, id)
		return err
	})
	return out, err
}

// AssignITRequest gives an active request to an IT account (assigneeID "me"
// = claim it yourself, "" = put it back in the unassigned pool).
func (s *Store) AssignITRequest(ctx context.Context, actor Actor, id, assigneeID string, act RequestAction) (domain.ITRequestDetail, error) {
	var out domain.ITRequestDetail
	assigneeID = strings.TrimSpace(assigneeID)
	if assigneeID == "me" {
		assigneeID = actor.User.ID
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		r, err := lockRequest(ctx, tx, actor, id, act.ExpectedVersion)
		if err != nil {
			return err
		}
		if domain.RequestClosed(r.status) {
			return domain.Conflict("request_closed", "This request is closed. Reopen it first.")
		}
		var name *string
		if assigneeID != "" {
			var n string
			err := tx.QueryRow(ctx, `SELECT name FROM users WHERE id = $1 AND role = 'it' AND status = 'active'`, assigneeID).Scan(&n)
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.Invalid("Please fix the highlighted fields.", map[string]string{"assigneeId": "Choose an active IT team member"})
			}
			if err != nil {
				return err
			}
			name = &n
		}
		if (r.assigneeID == nil && assigneeID == "") || (r.assigneeID != nil && *r.assigneeID == assigneeID) {
			out, err = loadRequestDetail(ctx, tx, actor, id) // already so: no-op
			return err
		}
		now := s.Now()
		var idArg any
		if assigneeID != "" {
			idArg = assigneeID
		}
		// Claiming it yourself (as IT) also acknowledges it.
		claim := actor.User.Role == "it" && assigneeID == actor.User.ID
		if _, err := tx.Exec(ctx, `UPDATE it_requests SET assignee_id=$2, assignee_name=$3, updated_at=$4, version=version+1,
			acknowledged_by = CASE WHEN acknowledged_at IS NULL AND $5 THEN $6 ELSE acknowledged_by END,
			acknowledged_by_name = CASE WHEN acknowledged_at IS NULL AND $5 THEN $7 ELSE acknowledged_by_name END,
			acknowledged_at = CASE WHEN acknowledged_at IS NULL AND $5 THEN $4 ELSE acknowledged_at END WHERE id=$1`,
			id, idArg, name, now, claim, actor.User.ID, actor.User.Name); err != nil {
			return err
		}
		body := "Unassigned"
		switch {
		case assigneeID == actor.User.ID:
			body = "Claimed by " + *name
		case name != nil:
			body = "Assigned to " + *name
		}
		if err := addRequestEvent(ctx, tx, actor, id, "assigned", body, nil, nil, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "it_request.assigned", "it_request", id, map[string]any{"ticket": r.ticket, "assignee": idArg}); err != nil {
			return err
		}
		title := "{ticket} is back in the IT queue"
		if name != nil {
			title = "{ticket} is with " + *name
		}
		if err := s.fanOutRequest(ctx, tx, actor, id, domain.NotifyRequestAssigned, "assigned", title, body, false); err != nil {
			return err
		}
		out, err = loadRequestDetail(ctx, tx, actor, id)
		return err
	})
	return out, err
}

// MoveITRequest advances the IT workflow (start, hand back, resolve, reopen).
// Starting an unassigned request claims it for the caller.
func (s *Store) MoveITRequest(ctx context.Context, actor Actor, id, to string, act RequestAction) (domain.ITRequestDetail, error) {
	var out domain.ITRequestDetail
	note, ok := domain.ValidateRequestText(act.Note, 0, domain.MaxResolution)
	if !ok {
		return out, domain.Invalid("Please fix the highlighted fields.", map[string]string{"note": fmt.Sprintf("Keep it under %d characters", domain.MaxResolution)})
	}
	if !domain.IsRequestStatus(to) || to == domain.RequestCancelled || to == domain.RequestRejected {
		return out, domain.Invalid("Please fix the highlighted fields.", map[string]string{"status": "Choose open, in progress or resolved"})
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		r, err := lockRequest(ctx, tx, actor, id, act.ExpectedVersion)
		if err != nil {
			return err
		}
		if !domain.CanMoveRequest(r.status, to) {
			return domain.Conflict("invalid_transition", fmt.Sprintf("Can’t move a request from %s to %s.",
				strings.ReplaceAll(r.status, "_", " "), strings.ReplaceAll(to, "_", " ")))
		}
		now := s.Now()
		set := "status=$2, updated_at=$3, version=version+1"
		args := []any{id, to, now}
		switch to {
		case domain.RequestInProgress:
			set += ", started_at=COALESCE(started_at,$3), closed_at=NULL"
			if r.status == domain.RequestResolved {
				set += ", resolution=''"
			}
			if r.assigneeID == nil {
				set += ", assignee_id=$4, assignee_name=$5"
				args = append(args, actor.User.ID, actor.User.Name)
			}
			if r.acknowledgedAt == nil && actor.User.Role == "it" {
				args = append(args, actor.User.ID, actor.User.Name)
				set += fmt.Sprintf(", acknowledged_by=$%d, acknowledged_by_name=$%d, acknowledged_at=$3", len(args)-1, len(args))
			}
		case domain.RequestResolved:
			set += ", closed_at=$3, resolution=$4"
			args = append(args, note)
		case domain.RequestOpen:
			set += ", started_at=NULL"
		}
		if _, err := tx.Exec(ctx, "UPDATE it_requests SET "+set+" WHERE id=$1", args...); err != nil {
			return err
		}
		from := r.status
		if err := addRequestEvent(ctx, tx, actor, id, "status", note, &from, &to, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "it_request.status_changed", "it_request", id, map[string]any{
			"ticket": r.ticket, "from": from, "to": to, "note": note}); err != nil {
			return err
		}
		body := actor.User.Name + " moved it to " + strings.ReplaceAll(to, "_", " ")
		if note != "" {
			body += ": " + note
		}
		if err := s.fanOutRequest(ctx, tx, actor, id, domain.NotifyRequestStatus, "status",
			"{ticket} is now "+strings.ReplaceAll(to, "_", " "), body, false); err != nil {
			return err
		}
		out, err = loadRequestDetail(ctx, tx, actor, id)
		return err
	})
	return out, err
}

// RejectITRequest closes an active request with a reason the requester sees.
func (s *Store) RejectITRequest(ctx context.Context, actor Actor, id string, act RequestAction) (domain.ITRequestDetail, error) {
	var out domain.ITRequestDetail
	reason, ok := domain.ValidateRequestText(act.Note, 3, domain.MaxResolution)
	if !ok {
		return out, domain.Invalid("Please fix the highlighted fields.", map[string]string{"reason": fmt.Sprintf("Give a reason (3–%d characters)", domain.MaxResolution)})
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		r, err := lockRequest(ctx, tx, actor, id, act.ExpectedVersion)
		if err != nil {
			return err
		}
		if domain.RequestClosed(r.status) {
			return domain.Conflict("request_closed", "This request is already closed.")
		}
		now := s.Now()
		if _, err := tx.Exec(ctx, `UPDATE it_requests SET status='rejected', resolution=$2, closed_at=$3, updated_at=$3,
			assignee_id=COALESCE(assignee_id,$4), assignee_name=COALESCE(assignee_name,$5), version=version+1 WHERE id=$1`,
			id, reason, now, actor.User.ID, actor.User.Name); err != nil {
			return err
		}
		from, to := r.status, domain.RequestRejected
		if err := addRequestEvent(ctx, tx, actor, id, "rejected", reason, &from, &to, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "it_request.rejected", "it_request", id, map[string]any{"ticket": r.ticket, "reason": reason}); err != nil {
			return err
		}
		if err := s.fanOutRequest(ctx, tx, actor, id, domain.NotifyRequestRejected, "rejected",
			"{ticket} was rejected by "+actor.User.Name, reason, false); err != nil {
			return err
		}
		out, err = loadRequestDetail(ctx, tx, actor, id)
		return err
	})
	return out, err
}

// CommentITRequest adds a comment to the timeline of a request in scope.
func (s *Store) CommentITRequest(ctx context.Context, actor Actor, id, body string) (domain.ITRequestDetail, error) {
	var out domain.ITRequestDetail
	body, ok := domain.ValidateRequestText(body, 1, domain.MaxRequestComment)
	if !ok {
		return out, domain.Invalid("Please fix the highlighted fields.", map[string]string{"body": fmt.Sprintf("Write a comment (up to %d characters)", domain.MaxRequestComment)})
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		r, err := lockRequest(ctx, tx, actor, id, nil)
		if err != nil {
			return err
		}
		now := s.Now()
		// Comments don't bump the version (they never conflict with edits),
		// but they do mark the request as recently updated.
		if _, err := tx.Exec(ctx, `UPDATE it_requests SET updated_at=$2 WHERE id=$1`, id, now); err != nil {
			return err
		}
		if err := addRequestEvent(ctx, tx, actor, id, "comment", body, nil, nil, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "it_request.commented", "it_request", id, map[string]any{"ticket": r.ticket, "length": len([]rune(body))}); err != nil {
			return err
		}
		if err := s.fanOutRequest(ctx, tx, actor, id, domain.NotifyRequestComment, "comment",
			actor.User.Name+" commented on {ticket}", body, actor.User.Role != "it"); err != nil {
			return err
		}
		out, err = loadRequestDetail(ctx, tx, actor, id)
		return err
	})
	return out, err
}

// RequestAssignees lists active IT accounts with their current load.
func (s *Store) RequestAssignees(ctx context.Context) ([]domain.Assignee, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `SELECT u.id, u.name, u.title,
		(SELECT count(*) FROM it_requests r WHERE r.assignee_id = u.id AND r.status IN ('open','in_progress'))
		FROM users u WHERE u.role = 'it' AND u.status = 'active' ORDER BY u.name, u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Assignee{}
	for rows.Next() {
		var a domain.Assignee
		if err := rows.Scan(&a.ID, &a.Name, &a.Title, &a.Open); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
