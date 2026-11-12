package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
)

// memberCols: is_lead is the stored flag OR an active team-lead account on
// the same team with the same email (so a lead's roster row gets the badge).
const memberCols = `id, name, COALESCE(email, ''), COALESCE(employee_id, ''), role, sub_group, team_id, seat_id,
	(is_lead OR (email IS NOT NULL AND EXISTS (SELECT 1 FROM users lu WHERE lu.team_id = members.team_id
		AND lu.role = 'team_lead' AND lu.status = 'active' AND lower(lu.email) = lower(members.email)))),
	status, joined_at, hue, version`

func scanMember(row pgx.Row) (domain.Member, error) {
	var m domain.Member
	var joined time.Time
	err := row.Scan(&m.ID, &m.Name, &m.Email, &m.EmployeeID, &m.Role, &m.SubGroup, &m.TeamID, &m.SeatID, &m.IsLead, &m.Status, &joined, &m.Hue, &m.Version)
	m.JoinedAt = domain.FormatDate(joined)
	m.Devices = []domain.Device{}
	return m, err
}

// loadMembers returns members matching where/args (with their devices),
// ordered by name. lock adds FOR UPDATE (rows are locked in id order).
func loadMembers(ctx context.Context, q querier, where string, args []any, lock bool) ([]domain.Member, error) {
	sql := `SELECT ` + memberCols + ` FROM members`
	if where != "" {
		sql += " WHERE " + where
	}
	if lock {
		sql += " ORDER BY id FOR UPDATE"
	} else {
		sql += " ORDER BY name, id"
	}
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	var out []domain.Member
	for rows.Next() {
		m, err := scanMember(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return []domain.Member{}, nil
	}
	if err := seatCodes(ctx, q, out); err != nil {
		return nil, err
	}
	ids := make([]string, len(out))
	idx := make(map[string]int, len(out))
	for i, m := range out {
		ids[i] = m.ID
		idx[m.ID] = i
	}
	drows, err := q.Query(ctx, `SELECT member_id, id, kind, model, asset_tag FROM devices
		WHERE member_id = ANY($1) ORDER BY member_id, position, id`, ids)
	if err != nil {
		return nil, err
	}
	defer drows.Close()
	for drows.Next() {
		var mid string
		var d domain.Device
		if err := drows.Scan(&mid, &d.ID, &d.Kind, &d.Model, &d.AssetTag); err != nil {
			return nil, err
		}
		out[idx[mid]].Devices = append(out[idx[mid]].Devices, d)
	}
	return out, drows.Err()
}

func membersByID(ctx context.Context, q querier, ids []string, lock bool) (map[string]domain.Member, error) {
	list, err := loadMembers(ctx, q, "id = ANY($1)", []any{ids}, lock)
	if err != nil {
		return nil, err
	}
	out := make(map[string]domain.Member, len(list))
	for _, m := range list {
		out[m.ID] = m
	}
	return out, nil
}

type TransferFilter struct {
	ID        string
	Direction string
	Status    string
	Query     string
	TeamID    string
	Limit     int
	Offset    int
}

func (f TransferFilter) where() (string, []any) {
	conds := []string{"t.cancelled_at IS NULL"}
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		conds = append(conds, fmt.Sprintf(cond, len(args)))
	}
	if f.ID != "" {
		add("t.id = $%d", f.ID)
	}
	if f.Direction != "" {
		add("t.direction = $%d", f.Direction)
	}
	if f.Status != "" {
		add("t.it_status = $%d", f.Status)
	}
	if f.TeamID != "" {
		add("(t.from_team_id = $%[1]d OR t.to_team_id = $%[1]d)", f.TeamID)
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		add(`(t.ticket ILIKE $%[1]d OR t.note ILIKE $%[1]d OR EXISTS (
			SELECT 1 FROM transfer_moves mv WHERE mv.transfer_id = t.id AND mv.member_name ILIKE $%[1]d))`,
			"%"+escapeLike(q)+"%")
	}
	return strings.Join(conds, " AND "), args
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// loadTransfers returns transfers (newest first) with moves, kit snapshots and
// IT history, plus the total count ignoring limit/offset.
func loadTransfers(ctx context.Context, q querier, f TransferFilter) ([]domain.Transfer, int, error) {
	where, args := f.where()
	var total int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM transfers t WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	sql := `SELECT t.id, t.ticket, t.direction, t.from_team_id, t.to_team_id, t.effective_date, t.created_at,
		t.initiated_by, t.initiated_by_user, t.note, t.it_status, t.version,
		t.acknowledged_by, t.acknowledged_by_name, t.acknowledged_at FROM transfers t WHERE ` + where +
		` ORDER BY t.created_at DESC, t.id`
	if f.Limit > 0 {
		sql += fmt.Sprintf(" LIMIT %d OFFSET %d", f.Limit, max(f.Offset, 0))
	}
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	var list []domain.Transfer
	for rows.Next() {
		var t domain.Transfer
		var owner *string
		var eff, created time.Time
		var ackBy, ackName *string
		var ackAt *time.Time
		if err := rows.Scan(&t.ID, &t.Ticket, &t.Direction, &t.FromTeamID, &t.ToTeamID, &eff, &created,
			&t.InitiatedBy, &owner, &t.Note, &t.ItStatus, &t.Version, &ackBy, &ackName, &ackAt); err != nil {
			rows.Close()
			return nil, 0, err
		}
		t.EffectiveDate = domain.FormatDate(eff)
		t.CreatedAt = domain.NewTime(created)
		t.Acknowledgement = domain.NewAcknowledgement(ackBy, ackName, ackAt)
		if owner != nil {
			t.InitiatedByID = *owner
		}
		t.Moves = []domain.Move{}
		t.History = []domain.StatusStep{}
		list = append(list, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(list) == 0 {
		return []domain.Transfer{}, total, nil
	}
	ids := make([]string, len(list))
	idx := make(map[string]int, len(list))
	for i, t := range list {
		ids[i] = t.ID
		idx[t.ID] = i
	}

	type key struct{ t, m string }
	moveIdx := map[key]int{}
	mrows, err := q.Query(ctx, `SELECT transfer_id, member_id, member_name,
			COALESCE((SELECT c.code FROM floor_cells c WHERE c.id = from_seat_id), from_seat),
			COALESCE((SELECT c.code FROM floor_cells c WHERE c.id = to_seat_id), to_seat),
			from_seat_id, to_seat_id
		FROM transfer_moves WHERE transfer_id = ANY($1) ORDER BY transfer_id, position`, ids)
	if err != nil {
		return nil, 0, err
	}
	for mrows.Next() {
		var tid string
		var mv domain.Move
		if err := mrows.Scan(&tid, &mv.MemberID, &mv.MemberName, &mv.FromSeat, &mv.ToSeat, &mv.FromSeatID, &mv.ToSeatID); err != nil {
			mrows.Close()
			return nil, 0, err
		}
		mv.Devices = []domain.Device{}
		t := &list[idx[tid]]
		moveIdx[key{tid, mv.MemberID}] = len(t.Moves)
		t.Moves = append(t.Moves, mv)
	}
	mrows.Close()

	drows, err := q.Query(ctx, `SELECT transfer_id, member_id, device_id, kind, model, asset_tag
		FROM transfer_move_devices WHERE transfer_id = ANY($1) ORDER BY transfer_id, member_id, position`, ids)
	if err != nil {
		return nil, 0, err
	}
	for drows.Next() {
		var tid, mid string
		var d domain.Device
		if err := drows.Scan(&tid, &mid, &d.ID, &d.Kind, &d.Model, &d.AssetTag); err != nil {
			drows.Close()
			return nil, 0, err
		}
		t := &list[idx[tid]]
		if i, ok := moveIdx[key{tid, mid}]; ok {
			t.Moves[i].Devices = append(t.Moves[i].Devices, d)
		}
	}
	drows.Close()

	hrows, err := q.Query(ctx, `SELECT transfer_id, status, at FROM transfer_history
		WHERE transfer_id = ANY($1) ORDER BY transfer_id, at, array_position(ARRAY['requested','scheduled','moved','completed'], status)`, ids)
	if err != nil {
		return nil, 0, err
	}
	defer hrows.Close()
	for hrows.Next() {
		var tid string
		var st domain.StatusStep
		var at time.Time
		if err := hrows.Scan(&tid, &st.Status, &at); err != nil {
			return nil, 0, err
		}
		st.At = domain.NewTime(at)
		list[idx[tid]].History = append(list[idx[tid]].History, st)
	}
	return list, total, hrows.Err()
}

func loadTransfer(ctx context.Context, q querier, id string) (domain.Transfer, error) {
	list, _, err := loadTransfers(ctx, q, TransferFilter{ID: id})
	if err != nil {
		return domain.Transfer{}, err
	}
	if len(list) == 0 {
		return domain.Transfer{}, domain.NotFound("Transfer request not found.")
	}
	return list[0], nil
}

func loadExits(ctx context.Context, q querier, where string, args ...any) ([]domain.ExitRecord, error) {
	sql := `SELECT id, batch_id, member_id, member_name, status,
		COALESCE((SELECT c.code FROM floor_cells c WHERE c.id = exits.seat_id), seat), seat_id, effective_date, created_at, initiated_by, initiated_by_user, reason
		FROM exits WHERE cancelled_at IS NULL`
	if where != "" {
		sql += " AND " + where
	}
	rows, err := q.Query(ctx, sql+" ORDER BY created_at DESC, id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.ExitRecord{}
	for rows.Next() {
		var e domain.ExitRecord
		var eff, created time.Time
		var owner *string
		if err := rows.Scan(&e.ID, &e.BatchID, &e.MemberID, &e.MemberName, &e.Status, &e.Seat, &e.SeatID, &eff, &created,
			&e.InitiatedBy, &owner, &e.Reason); err != nil {
			return nil, err
		}
		if owner != nil {
			e.InitiatedByID = *owner
		}
		e.EffectiveDate = domain.FormatDate(eff)
		e.CreatedAt = domain.NewTime(created)
		out = append(out, e)
	}
	return out, rows.Err()
}

func loadTeams(ctx context.Context, q querier) ([]domain.Team, error) {
	rows, err := q.Query(ctx, `SELECT t.id, t.slug, t.name, t.code, t.location,
			COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name, u.id)
				FROM users u WHERE u.team_id = t.id AND u.role = 'team_lead' AND u.status = 'active'), '[]'::json),
			(SELECT count(*) FROM members m WHERE m.team_id = t.id AND m.status = 'active'),
			(SELECT count(*) FROM members m WHERE m.team_id = t.id AND m.status = 'active' AND m.seat_id IS NOT NULL),
			(SELECT count(*) FROM floor_cells c JOIN floors f ON f.id = c.floor_id
				WHERE c.team_id = t.id AND c.kind = 'seat' AND f.status = 'published')
		FROM teams t ORDER BY t.sort_order, t.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Team{}
	for rows.Next() {
		var t domain.Team
		var leads []byte
		if err := rows.Scan(&t.ID, &t.Slug, &t.Name, &t.Code, &t.Location, &leads, &t.MemberCount, &t.SeatsOccupied, &t.SeatsTotal); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(leads, &t.Leads); err != nil {
			return nil, fmt.Errorf("team %s leads: %w", t.ID, err)
		}
		if t.Leads == nil {
			t.Leads = []domain.TeamLead{}
		}
		names := make([]string, len(t.Leads))
		for i, l := range t.Leads {
			names[i] = l.Name
		}
		t.LeadName = strings.Join(names, ", ")
		out = append(out, t)
	}
	return out, rows.Err()
}

func loadSettings(ctx context.Context, q querier, userID string) (domain.Settings, error) {
	var raw []byte
	if err := q.QueryRow(ctx, `SELECT preferences FROM users WHERE id = $1`, userID).Scan(&raw); err != nil {
		return domain.Settings{}, err
	}
	s := domain.Settings{Notifications: map[string]bool{"scheduled": true, "moved": true, "incoming": true, "digest": false, "liveSound": false}}
	var stored domain.Settings
	if err := json.Unmarshal(raw, &stored); err == nil {
		for k, v := range stored.Notifications {
			s.Notifications[k] = v
		}
	}
	return s, nil
}

// Workspace reads the dashboard snapshot in one consistent transaction,
// scoped to the actor. teamID selects the team in focus for org-wide roles
// (admin team switcher); team leads are always pinned to their own team.
func (s *Store) Workspace(ctx context.Context, actor Actor, teamID string) (domain.Workspace, error) {
	var w domain.Workspace
	scope := actor.TeamScope()
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		var err error
		w.User = actor.User
		if w.Teams, err = loadTeams(ctx, tx); err != nil {
			return err
		}
		w.CurrentTeamID = pickTeam(w.Teams, scope, teamID)
		if w.Floors, err = loadFloors(ctx, tx, actor, "", true); err != nil {
			return err
		}
		switch {
		case scope != "":
			if w.Members, err = loadMembers(ctx, tx, "team_id = $1", []any{scope}, false); err != nil {
				return err
			}
			if w.Transfers, _, err = loadTransfers(ctx, tx, TransferFilter{TeamID: scope}); err != nil {
				return err
			}
			if w.Exits, err = loadExits(ctx, tx, "member_id IN (SELECT id FROM members WHERE team_id = $1)", scope); err != nil {
				return err
			}
		default:
			if w.Members, err = loadMembers(ctx, tx, "", nil, false); err != nil {
				return err
			}
			if w.Transfers, _, err = loadTransfers(ctx, tx, TransferFilter{}); err != nil {
				return err
			}
			if actor.User.Role == "admin" {
				if w.Exits, err = loadExits(ctx, tx, ""); err != nil {
					return err
				}
			} else {
				w.Exits = []domain.ExitRecord{}
			}
		}
		w.Settings, err = loadSettings(ctx, tx, actor.User.ID)
		return err
	})
	w.ServerTime = domain.NewTime(s.Now())
	w.UndoWindowSeconds = int(s.UndoWindow.Seconds())
	return w, err
}

func pickTeam(teams []domain.Team, scope, want string) string {
	if scope != "" {
		return scope
	}
	for _, t := range teams {
		if t.ID == want {
			return want
		}
	}
	// Org-level roles default to the org-wide view ("All teams").
	return ""
}

func (s *Store) Teams(ctx context.Context) ([]domain.Team, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	return loadTeams(ctx, pool)
}

type MemberFilter struct {
	TeamID string
	Status string
	Query  string
}

func (s *Store) Members(ctx context.Context, actor Actor, f MemberFilter) ([]domain.Member, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	if scope := actor.TeamScope(); scope != "" {
		f.TeamID = scope
	}
	var conds []string
	var args []any
	if f.TeamID != "" {
		args = append(args, f.TeamID)
		conds = append(conds, fmt.Sprintf("team_id = $%d", len(args)))
	}
	if f.Status != "" {
		args = append(args, f.Status)
		conds = append(conds, fmt.Sprintf("status = $%d", len(args)))
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		args = append(args, "%"+escapeLike(q)+"%")
		n := len(args)
		conds = append(conds, fmt.Sprintf("(name ILIKE $%d OR email ILIKE $%d OR EXISTS (SELECT 1 FROM floor_cells sc WHERE sc.id = members.seat_id AND sc.code ILIKE $%d) OR sub_group ILIKE $%d OR employee_id ILIKE $%d)", n, n, n, n, n))
	}
	return loadMembers(ctx, pool, strings.Join(conds, " AND "), args, false)
}

func (s *Store) Member(ctx context.Context, actor Actor, id string) (domain.Member, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.Member{}, err
	}
	list, err := loadMembers(ctx, pool, "id = $1", []any{id}, false)
	if err != nil {
		return domain.Member{}, err
	}
	if len(list) == 0 || (actor.TeamScope() != "" && list[0].TeamID != actor.TeamScope()) {
		return domain.Member{}, domain.NotFound("Member not found.")
	}
	return list[0], nil
}

func (s *Store) Transfers(ctx context.Context, actor Actor, f TransferFilter) (domain.Page[domain.Transfer], error) {
	pool, err := s.pool()
	if err != nil {
		return domain.Page[domain.Transfer]{}, err
	}
	if scope := actor.TeamScope(); scope != "" {
		f.TeamID = scope
	}
	items, total, err := loadTransfers(ctx, pool, f)
	return domain.Page[domain.Transfer]{Items: items, Total: total, Limit: f.Limit, Offset: f.Offset}, err
}

func (s *Store) Transfer(ctx context.Context, actor Actor, id string) (domain.Transfer, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.Transfer{}, err
	}
	list, _, err := loadTransfers(ctx, pool, TransferFilter{ID: id, TeamID: actor.TeamScope()})
	if err != nil {
		return domain.Transfer{}, err
	}
	if len(list) == 0 {
		return domain.Transfer{}, domain.NotFound("Transfer request not found.")
	}
	return list[0], nil
}

func (s *Store) Exits(ctx context.Context, actor Actor) ([]domain.ExitRecord, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	if scope := actor.TeamScope(); scope != "" {
		return loadExits(ctx, pool, "member_id IN (SELECT id FROM members WHERE team_id = $1)", scope)
	}
	return loadExits(ctx, pool, "")
}

func (s *Store) Activity(ctx context.Context, limit int) ([]domain.Activity, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `SELECT id, at, actor, action, entity, entity_id, data FROM audit_log
		ORDER BY at DESC, id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Activity{}
	for rows.Next() {
		var a domain.Activity
		var at time.Time
		if err := rows.Scan(&a.ID, &at, &a.Actor, &a.Action, &a.Entity, &a.EntityID, &a.Data); err != nil {
			return nil, err
		}
		a.At = domain.NewTime(at)
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) Settings(ctx context.Context, actor Actor) (domain.Settings, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.Settings{}, err
	}
	return loadSettings(ctx, pool, actor.User.ID)
}
