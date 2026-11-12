package store

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"itdesk/backend/internal/domain"
)

// MemberHistoryItem is one entry on a member's timeline: record edits, desk
// moves, transfers, exits and IT requests raised for them.
type MemberHistoryItem struct {
	Kind   string    `json:"kind"` // created | updated | desk | team | transfer | exit | request
	At     time.Time `json:"at"`
	Actor  string    `json:"actor"`
	Title  string    `json:"title"`
	Detail string    `json:"detail"`
	Ticket string    `json:"ticket,omitempty"`
	Status string    `json:"status,omitempty"`
	RefID  string    `json:"refId,omitempty"`
	// IT acknowledgement (transfers and IT requests).
	AckBy *string    `json:"acknowledgedBy,omitempty"`
	AckAt *time.Time `json:"acknowledgedAt,omitempty"`
}

type MemberDetail struct {
	Member    domain.Member       `json:"member"`
	CreatedAt time.Time           `json:"createdAt"`
	UpdatedAt time.Time           `json:"updatedAt"`
	History   []MemberHistoryItem `json:"history"`
}

const memberHistoryLimit = 60

// MemberDetail is Member plus timestamps and history. Same scoping as Member:
// a team lead gets 404 for anyone outside their own team.
func (s *Store) MemberDetail(ctx context.Context, actor Actor, id string) (MemberDetail, error) {
	m, err := s.Member(ctx, actor, id)
	if err != nil {
		return MemberDetail{}, err
	}
	pool, err := s.pool()
	if err != nil {
		return MemberDetail{}, err
	}
	out := MemberDetail{Member: m, History: []MemberHistoryItem{}}
	if err := pool.QueryRow(ctx, `SELECT created_at, updated_at FROM members WHERE id = $1`, id).Scan(&out.CreatedAt, &out.UpdatedAt); err != nil {
		return MemberDetail{}, err
	}

	// Record edits from the audit log; consecutive seatId changes are desk moves.
	rows, err := pool.Query(ctx, `SELECT a.at, a.actor, a.action, a.data,
			COALESCE((SELECT c.code FROM floor_cells c WHERE c.id = a.data->>'seatId'), ''),
			COALESCE((SELECT f.name FROM floor_cells c JOIN floors f ON f.id = c.floor_id WHERE c.id = a.data->>'seatId'), '')
		FROM audit_log a
		WHERE a.entity = 'member' AND a.entity_id = $1 AND a.action IN ('member.created', 'member.updated')
		ORDER BY a.at, a.id`, id)
	if err != nil {
		return MemberDetail{}, err
	}
	type seatAt struct{ id, code, floor string }
	var prev *seatAt
	for rows.Next() {
		var at time.Time
		var who, action, code, floor string
		var raw []byte
		if err := rows.Scan(&at, &who, &action, &raw, &code, &floor); err != nil {
			rows.Close()
			return MemberDetail{}, err
		}
		var d struct {
			SeatID         *string `json:"seatId"`
			TeamID         string  `json:"teamId"`
			PreviousTeamID string  `json:"previousTeamId"`
		}
		_ = json.Unmarshal(raw, &d)
		cur := seatAt{code: code, floor: floor}
		if d.SeatID != nil {
			cur.id = *d.SeatID
		}
		if action == "member.created" {
			detail := "No desk"
			if cur.code != "" {
				detail = "Seat " + cur.code + " · " + cur.floor
			}
			out.History = append(out.History, MemberHistoryItem{Kind: "created", At: at, Actor: who, Title: "Added to the team", Detail: detail})
		} else {
			switch {
			case d.PreviousTeamID != "" && d.TeamID != "" && d.PreviousTeamID != d.TeamID:
				out.History = append(out.History, MemberHistoryItem{Kind: "team", At: at, Actor: who, Title: "Moved to another team", Detail: teamLabel(ctx, s, d.PreviousTeamID) + " → " + teamLabel(ctx, s, d.TeamID)})
			case prev != nil && prev.id != cur.id:
				out.History = append(out.History, MemberHistoryItem{Kind: "desk", At: at, Actor: who, Title: "Desk changed", Detail: seatText(prev.code) + " → " + seatText(cur.code)})
			default:
				out.History = append(out.History, MemberHistoryItem{Kind: "updated", At: at, Actor: who, Title: "Details updated"})
			}
		}
		prev = &cur
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return MemberDetail{}, err
	}

	// Transfers (seat moves and team moves) this member was part of.
	rows, err = pool.Query(ctx, `SELECT t.id, t.ticket, t.direction, t.created_at, t.initiated_by, t.it_status,
			COALESCE((SELECT c.code FROM floor_cells c WHERE c.id = mv.from_seat_id), mv.from_seat, ''),
			COALESCE((SELECT c.code FROM floor_cells c WHERE c.id = mv.to_seat_id), mv.to_seat, ''),
			ft.name, tt.name, t.acknowledged_by_name, t.acknowledged_at
		FROM transfer_moves mv
		JOIN transfers t ON t.id = mv.transfer_id
		JOIN teams ft ON ft.id = t.from_team_id
		JOIN teams tt ON tt.id = t.to_team_id
		WHERE mv.member_id = $1 AND t.cancelled_at IS NULL
		ORDER BY t.created_at DESC LIMIT $2`, id, memberHistoryLimit)
	if err != nil {
		return MemberDetail{}, err
	}
	for rows.Next() {
		var it MemberHistoryItem
		var dir, from, to, fromTeam, toTeam string
		if err := rows.Scan(&it.RefID, &it.Ticket, &dir, &it.At, &it.Actor, &it.Status, &from, &to, &fromTeam, &toTeam, &it.AckBy, &it.AckAt); err != nil {
			rows.Close()
			return MemberDetail{}, err
		}
		it.Kind = "transfer"
		if dir == "internal" {
			it.Title = "Seat move"
			it.Detail = seatText(from) + " → " + seatText(to)
		} else {
			it.Title = "Team transfer"
			it.Detail = fromTeam + " → " + toTeam
			if to != "" {
				it.Detail += " · Seat " + to
			}
		}
		out.History = append(out.History, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return MemberDetail{}, err
	}

	// Exits (resigned / unknown); undone ones are skipped.
	rows, err = pool.Query(ctx, `SELECT id, status, created_at, initiated_by, reason FROM exits
		WHERE member_id = $1 AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT $2`, id, memberHistoryLimit)
	if err != nil {
		return MemberDetail{}, err
	}
	for rows.Next() {
		var it MemberHistoryItem
		var status string
		if err := rows.Scan(&it.RefID, &status, &it.At, &it.Actor, &it.Detail); err != nil {
			rows.Close()
			return MemberDetail{}, err
		}
		it.Kind, it.Status = "exit", status
		it.Title = map[string]string{"resigned": "Marked as resigned", "unknown": "Marked as unknown"}[status]
		out.History = append(out.History, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return MemberDetail{}, err
	}

	// IT requests raised for this member.
	rows, err = pool.Query(ctx, `SELECT r.id, r.ticket, r.status, r.created_at, r.requester_name,
			CASE WHEN r.request_type = 'issue' THEN r.title ELSE
			COALESCE((SELECT string_agg(CASE WHEN i.quantity > 1 THEN i.quantity || ' × ' ELSE '' END ||
				CASE WHEN i.kind = 'other' THEN i.description ELSE i.kind END, ', ' ORDER BY i.position) FROM it_request_items i WHERE i.request_id = r.id), '') END,
			r.acknowledged_by_name, r.acknowledged_at, r.request_type = 'issue'
		FROM it_requests r WHERE r.for_member_id = $1 ORDER BY r.created_at DESC LIMIT $2`, id, memberHistoryLimit)
	if err != nil {
		return MemberDetail{}, err
	}
	for rows.Next() {
		var it MemberHistoryItem
		var issue bool
		if err := rows.Scan(&it.RefID, &it.Ticket, &it.Status, &it.At, &it.Actor, &it.Detail, &it.AckBy, &it.AckAt, &issue); err != nil {
			rows.Close()
			return MemberDetail{}, err
		}
		it.Kind, it.Title = "request", "IT request"
		if issue {
			it.Title = "IT issue"
		}
		out.History = append(out.History, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return MemberDetail{}, err
	}

	sort.SliceStable(out.History, func(i, j int) bool { return out.History[i].At.After(out.History[j].At) })
	if len(out.History) > memberHistoryLimit {
		out.History = out.History[:memberHistoryLimit]
	}
	return out, nil
}

func seatText(code string) string {
	if code == "" {
		return "No desk"
	}
	return "Seat " + code
}

func teamLabel(ctx context.Context, s *Store, id string) string {
	pool, err := s.pool()
	if err != nil {
		return id
	}
	var name string
	if pool.QueryRow(ctx, `SELECT name FROM teams WHERE id = $1`, id).Scan(&name) != nil {
		return id
	}
	return name
}
