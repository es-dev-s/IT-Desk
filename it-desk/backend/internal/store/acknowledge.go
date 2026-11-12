package store

// IT acknowledgements ("Seen by … — working on it") and the fan-out rules
// for transfers and IT requests:
//
//   - new transfer / new request      → every active IT account
//   - IT acknowledges / advances      → the requester + the leads of the teams involved
//   - request status / reject         → the requester + the team's leads
//   - request assigned to someone     → that IT account + the requester
//   - comment by IT                   → the requester + the team's leads
//   - comment by a requester          → the assignee, or all IT while unassigned
//   - requester cancels               → the assignee, or all IT while unassigned
//
// Leads are only ever addressed through teamLeads(team), so a lead never
// hears about another team. The actor is never notified of their own action.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
)

var errStaleTransfer = domain.Conflict("stale_transfer", "This transfer was updated by someone else. Refresh and try again.")

func stageLabel(status string) string {
	switch status {
	case "requested":
		return "Requested"
	case "scheduled":
		return "Scheduled"
	case "moved":
		return "Moved"
	case "completed":
		return "Completed"
	}
	return status
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func transferNote(t domain.Transfer, kind, title, body string) note {
	team := t.FromTeamID
	return note{kind: kind, entityType: domain.EntityTransfer, entityID: t.ID, ticket: t.Ticket, teamID: &team, title: title, body: body}
}

// fanOutTransferCreated tells IT about a new transfer (single or bulk).
func (s *Store) fanOutTransferCreated(ctx context.Context, q querier, actor Actor, t domain.Transfer) error {
	from := teamName(ctx, q, &t.FromTeamID)
	body := actor.User.Name + " · " + plural(len(t.Moves), "person", "people")
	if t.Direction == "out" {
		body += " → " + teamName(ctx, q, &t.ToTeamID)
	} else {
		body += " · seat move"
	}
	body += " · effective " + t.EffectiveDate
	it, err := activeIT(ctx, q)
	if err != nil {
		return err
	}
	if err := s.notify(ctx, q, actor, it, transferNote(t, domain.NotifyTransferCreated,
		fmt.Sprintf("New transfer %s from %s", t.Ticket, from), body)); err != nil {
		return err
	}
	return s.publishEntity(ctx, q, actor, domain.EntityChange{Entity: domain.EntityTransfer, ID: t.ID, Ticket: t.Ticket,
		Change: "created", Version: t.Version}, &t.FromTeamID, &t.ToTeamID)
}

// fanOutTransfer tells the requester and the leads of both teams.
func (s *Store) fanOutTransfer(ctx context.Context, q querier, actor Actor, t domain.Transfer, kind, change, title, body string) error {
	leads, err := teamLeads(ctx, q, &t.FromTeamID, &t.ToTeamID)
	if err != nil {
		return err
	}
	recipients := append([]string{t.InitiatedByID}, leads...)
	if err := s.notify(ctx, q, actor, recipients, transferNote(t, kind, title, body)); err != nil {
		return err
	}
	return s.publishEntity(ctx, q, actor, domain.EntityChange{Entity: domain.EntityTransfer, ID: t.ID, Ticket: t.Ticket,
		Change: change, Version: t.Version}, &t.FromTeamID, &t.ToTeamID)
}

// AcknowledgeTransfer records that an IT user has seen a transfer and is
// working on it. It does not change the IT stage. Idempotent: once
// acknowledged, repeating it returns the transfer unchanged (whoever was
// first stays on record). expectedVersion guards the first acknowledgement.
func (s *Store) AcknowledgeTransfer(ctx context.Context, actor Actor, id string, expectedVersion *int) (domain.Transfer, error) {
	var t domain.Transfer
	if actor.User.Role != "it" {
		return t, domain.Forbidden("forbidden", "Only IT can acknowledge transfers.")
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var status string
		var version int
		var cancelled, acked *time.Time
		err := tx.QueryRow(ctx, `SELECT it_status, version, cancelled_at, acknowledged_at FROM transfers WHERE id = $1 FOR UPDATE`, id).
			Scan(&status, &version, &cancelled, &acked)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NotFound("Transfer request not found.")
		} else if err != nil {
			return err
		}
		if cancelled != nil {
			return domain.Conflict("cancelled", "This request was cancelled.")
		}
		if acked != nil { // idempotent
			t, err = loadTransfer(ctx, tx, id)
			return err
		}
		if expectedVersion != nil && *expectedVersion != version {
			return errStaleTransfer
		}
		if status == "completed" {
			return domain.Conflict("already_completed", "This request is already completed.")
		}
		now := s.Now()
		if _, err := tx.Exec(ctx, `UPDATE transfers SET acknowledged_by = $2, acknowledged_by_name = $3, acknowledged_at = $4,
			version = version + 1, updated_at = $4 WHERE id = $1`, id, actor.User.ID, actor.User.Name, now); err != nil {
			return err
		}
		if t, err = loadTransfer(ctx, tx, id); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "transfer.acknowledged", "transfer", id, map[string]any{"ticket": t.Ticket}); err != nil {
			return err
		}
		return s.fanOutTransfer(ctx, tx, actor, t, domain.NotifyTransferAcknowledged, "acknowledged",
			fmt.Sprintf("%s has seen %s", actor.User.Name, t.Ticket), "Seen by "+actor.User.Name+" — working on it")
	})
	return t, err
}

// ---- IT requests --------------------------------------------------------------

type requestInfo struct {
	id, ticket  string
	teamID      *string
	requesterID *string
	assigneeID  *string
	version     int
	summary     string
	issue       bool
}

func loadRequestInfo(ctx context.Context, q querier, id string) (requestInfo, error) {
	r := requestInfo{id: id}
	err := q.QueryRow(ctx, `SELECT r.ticket, r.team_id, r.requester_id, r.assignee_id, r.version,
		CASE WHEN r.request_type = 'issue' THEN initcap(r.issue_category) || ': ' || r.title
		ELSE COALESCE((SELECT string_agg(CASE WHEN i.kind = 'other' THEN i.description
			ELSE initcap(i.kind) END || ' ×' || i.quantity, ', ' ORDER BY i.position)
			FROM it_request_items i WHERE i.request_id = r.id), '') END,
		r.request_type = 'issue'
		FROM it_requests r WHERE r.id = $1`, id).Scan(&r.ticket, &r.teamID, &r.requesterID, &r.assigneeID, &r.version, &r.summary, &r.issue)
	return r, err
}

func requestNote(r requestInfo, kind, title, body string) note {
	return note{kind: kind, entityType: domain.EntityITRequest, entityID: r.id, ticket: r.ticket, teamID: r.teamID, title: title, body: body}
}

func (s *Store) publishRequest(ctx context.Context, q querier, actor Actor, r requestInfo, change string) error {
	return s.publishEntity(ctx, q, actor, domain.EntityChange{Entity: domain.EntityITRequest, ID: r.id, Ticket: r.ticket,
		Change: change, Version: r.version}, r.teamID)
}

// requesterSide is the person who raised the request plus their team's leads.
func requesterSide(ctx context.Context, q querier, r requestInfo) ([]string, error) {
	leads, err := teamLeads(ctx, q, r.teamID)
	if err != nil {
		return nil, err
	}
	return append([]string{deref(r.requesterID)}, leads...), nil
}

// itSide is the assignee, or every active IT account while unassigned.
func itSide(ctx context.Context, q querier, r requestInfo) ([]string, error) {
	if r.assigneeID != nil {
		return []string{*r.assigneeID}, nil
	}
	return activeIT(ctx, q)
}

func priorityLabel(p string) string {
	if p == "" {
		return ""
	}
	return strings.ToUpper(p[:1]) + p[1:] + " priority"
}

// fanOutRequest notifies after a request mutation (called inside the tx,
// after the change is written).
func (s *Store) fanOutRequest(ctx context.Context, q querier, actor Actor, id, kind, change, title, body string, toITSide bool) error {
	r, err := loadRequestInfo(ctx, q, id)
	if err != nil {
		return err
	}
	if title == "" {
		title = r.ticket
	}
	title = strings.ReplaceAll(title, "{ticket}", r.ticket)
	var recipients []string
	switch {
	case kind == domain.NotifyRequestCreated:
		recipients, err = activeIT(ctx, q)
	case toITSide:
		recipients, err = itSide(ctx, q, r)
	default:
		recipients, err = requesterSide(ctx, q, r)
	}
	if err != nil {
		return err
	}
	if kind == domain.NotifyRequestComment && toITSide { // keep the requester's side in the loop too
		side, err := requesterSide(ctx, q, r)
		if err != nil {
			return err
		}
		recipients = append(recipients, side...)
	}
	if kind == domain.NotifyRequestAssigned && r.assigneeID != nil && *r.assigneeID != actor.User.ID {
		recipients = append(recipients, *r.assigneeID)
	}
	if kind == domain.NotifyRequestCreated {
		what := "request"
		if r.issue {
			what = "issue"
		}
		title = fmt.Sprintf("New %s %s · %s", what, r.ticket, domain.Truncate(r.summary, 120))
	}
	if err := s.notify(ctx, q, actor, recipients, requestNote(r, kind, title, body)); err != nil {
		return err
	}
	return s.publishRequest(ctx, q, actor, r, change)
}

// AcknowledgeITRequest records that an IT user has seen a request: it is
// claimed for them if unassigned and moves open → in progress. Idempotent:
// an already-acknowledged request is returned unchanged.
func (s *Store) AcknowledgeITRequest(ctx context.Context, actor Actor, id string, act RequestAction) (domain.ITRequestDetail, error) {
	var out domain.ITRequestDetail
	if actor.User.Role != "it" {
		return out, domain.Forbidden("forbidden", "Only IT can acknowledge requests.")
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		r, err := lockRequest(ctx, tx, actor, id, nil)
		if err != nil {
			return err
		}
		if r.acknowledgedAt != nil {
			out, err = loadRequestDetail(ctx, tx, actor, id)
			return err
		}
		if act.ExpectedVersion != nil && *act.ExpectedVersion != r.version {
			return errStaleRequest
		}
		if domain.RequestClosed(r.status) {
			return domain.Conflict("request_closed", "This request is already closed.")
		}
		now := s.Now()
		to := r.status
		if r.status == domain.RequestOpen {
			to = domain.RequestInProgress
		}
		if _, err := tx.Exec(ctx, `UPDATE it_requests SET acknowledged_by = $2, acknowledged_by_name = $3, acknowledged_at = $4,
			assignee_id = COALESCE(assignee_id, $2), assignee_name = CASE WHEN assignee_id IS NULL THEN $3 ELSE assignee_name END,
			status = $5, started_at = CASE WHEN $5 = 'in_progress' THEN COALESCE(started_at, $4) ELSE started_at END,
			updated_at = $4, version = version + 1 WHERE id = $1`, id, actor.User.ID, actor.User.Name, now, to); err != nil {
			return err
		}
		var from, toP *string
		if to != r.status {
			f := r.status
			from, toP = &f, &to
		}
		if err := addRequestEvent(ctx, tx, actor, id, "acknowledged", "Seen by "+actor.User.Name+" — working on it", from, toP, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "it_request.acknowledged", "it_request", id, map[string]any{
			"ticket": r.ticket, "claimed": r.assigneeID == nil, "from": r.status, "to": to}); err != nil {
			return err
		}
		if err := s.fanOutRequest(ctx, tx, actor, id, domain.NotifyRequestAcknowledged, "acknowledged",
			actor.User.Name+" has seen {ticket}", "Seen by "+actor.User.Name+" — working on it", false); err != nil {
			return err
		}
		out, err = loadRequestDetail(ctx, tx, actor, id)
		return err
	})
	return out, err
}
