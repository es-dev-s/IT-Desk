package store

// Live changes on published floors: painting zones, moving a team's zone
// (optionally to another floor, carrying its people), publishing a changed
// draft, seating one person, and undoing zone changes. All of these share
// one engine (applyPlan) that handles displaced people, audit, notifications
// to the affected leads and IT, and the live broadcast.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
)

// occRow is an active person on a seat.
type occRow struct {
	MemberID, Name, TeamID, SeatID, SeatCode, FloorID string
	Version                                           int
}

func occupantsOn(ctx context.Context, q querier, seatIDs []string) (map[string]occRow, error) {
	out := map[string]occRow{}
	if len(seatIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT m.id, m.name, m.team_id, m.seat_id, c.code, c.floor_id, m.version
		FROM members m JOIN floor_cells c ON c.id = m.seat_id
		WHERE m.seat_id = ANY($1) AND m.status = 'active' ORDER BY c.code FOR UPDATE OF m`, seatIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var o occRow
		if err := rows.Scan(&o.MemberID, &o.Name, &o.TeamID, &o.SeatID, &o.SeatCode, &o.FloorID, &o.Version); err != nil {
			return nil, err
		}
		out[o.SeatID] = o
	}
	return out, rows.Err()
}

// plan is a set of live changes applied in one transaction.
type plan struct {
	action   string // audit action, e.g. zone.assigned
	summary  string
	floors   []string           // floors touched (layout or occupancy)
	cellTeam map[string]*string // seat id -> new zone
	cellLead map[string]bool    // seat id -> lead seat flag
	moves    map[string]*string // member id -> new seat (nil = unseat)
	affected []domain.AffectedMember
	undoable bool
}

func newPlan(action string) *plan {
	return &plan{action: action, cellTeam: map[string]*string{}, cellLead: map[string]bool{}, moves: map[string]*string{}}
}

type candSeat struct {
	ID, Code, FloorID string
	Team              *string
	floorOrder        int
}

// freeSeatsFor returns, per team, seats that will be in the team's zone and
// empty once the plan is applied, best first (same floor as `near`, then by
// floor order and code).
func freeSeatsFor(ctx context.Context, q querier, p *plan, teams []string) (map[string][]candSeat, error) {
	out := map[string][]candSeat{}
	if len(teams) == 0 {
		return out, nil
	}
	overlay := make([]string, 0, len(p.cellTeam))
	for id := range p.cellTeam {
		overlay = append(overlay, id)
	}
	rows, err := q.Query(ctx, `SELECT c.id, c.code, c.floor_id, c.team_id, f.sort_order
		FROM floor_cells c JOIN floors f ON f.id = c.floor_id
		WHERE f.status = 'published' AND c.kind = 'seat' AND (c.team_id = ANY($1) OR c.id = ANY($2))
		ORDER BY f.level DESC, f.sort_order DESC, f.name, c.y, c.x, c.id`, teams, overlay)
	if err != nil {
		return nil, err
	}
	var cands []candSeat
	for rows.Next() {
		var c candSeat
		if err := rows.Scan(&c.ID, &c.Code, &c.FloorID, &c.Team, &c.floorOrder); err != nil {
			rows.Close()
			return nil, err
		}
		if t, ok := p.cellTeam[c.ID]; ok {
			c.Team = t
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	ids := make([]string, len(cands))
	for i, c := range cands {
		ids[i] = c.ID
	}
	moving := make([]string, 0, len(p.moves))
	taken := map[string]bool{}
	for m, to := range p.moves {
		moving = append(moving, m)
		if to != nil {
			taken[*to] = true
		}
	}
	holders, err := seatHolders(ctx, q, ids, moving)
	if err != nil {
		return nil, err
	}
	for _, c := range cands {
		if c.Team == nil || !slices.Contains(teams, *c.Team) || taken[c.ID] || holders[c.ID] != "" {
			continue
		}
		out[*c.Team] = append(out[*c.Team], c)
	}
	return out, nil
}

// pickSeat takes the best free seat for a person (same floor first).
func pickSeat(free map[string][]candSeat, team, floor string) *candSeat {
	list := free[team]
	best := -1
	for i, c := range list {
		if c.FloorID == floor {
			best = i
			break
		}
	}
	if best < 0 && len(list) > 0 {
		best = 0
	}
	if best < 0 {
		return nil
	}
	c := list[best]
	free[team] = append(list[:best:best], list[best+1:]...)
	return &c
}

// displace decides what happens to people whose seat is removed or handed
// to another team. mode "" records them as conflicts (nothing applied).
func displace(ctx context.Context, q querier, p *plan, people []occRow, mode string, removed map[string]bool) error {
	if len(people) == 0 {
		return nil
	}
	sort.Slice(people, func(i, j int) bool { return people[i].SeatCode < people[j].SeatCode })
	var free map[string][]candSeat
	if mode == "relocate" {
		var teams []string
		for _, o := range people {
			if !slices.Contains(teams, o.TeamID) {
				teams = append(teams, o.TeamID)
			}
		}
		var err error
		if free, err = freeSeatsFor(ctx, q, p, teams); err != nil {
			return err
		}
	}
	for _, o := range people {
		a := domain.AffectedMember{MemberID: o.MemberID, Name: o.Name, TeamID: o.TeamID, FromSeatID: o.SeatID, FromSeat: o.SeatCode}
		switch {
		case mode == "":
			a.Action = "conflict"
		case mode == "keep" && !removed[o.SeatID]:
			a.Action = "keep"
		case mode == "relocate":
			if c := pickSeat(free, o.TeamID, o.FloorID); c != nil {
				a.Action, a.ToSeatID, a.ToSeat = "relocate", strp(c.ID), strp(c.Code)
				p.moves[o.MemberID] = strp(c.ID)
				p.floors = addFloor(p.floors, &c.FloorID)
				break
			}
			fallthrough
		default:
			a.Action = "unseat"
			p.moves[o.MemberID] = nil
		}
		p.affected = append(p.affected, a)
	}
	return nil
}

func conflictErr(aff []domain.AffectedMember, teams map[string]string) error {
	fields := map[string]string{}
	names := []string{}
	for _, a := range aff {
		if a.Action != "conflict" {
			continue
		}
		fields["member."+a.MemberID] = fmt.Sprintf("%s (%s) on Seat %s", a.Name, teams[a.TeamID], a.FromSeat)
		names = append(names, a.Name)
	}
	if len(names) == 0 {
		return nil
	}
	shown := names
	if len(shown) > 5 {
		shown = append(shown[:5:5], fmt.Sprintf("%d more", len(names)-5))
	}
	return &domain.Error{Status: 409, Code: "zone_conflict", Fields: fields,
		Message: fmt.Sprintf("%d %s seated there: %s. Choose to move them along, unseat them, or cancel.",
			len(names), plural(len(names), "person is", "people are"), strings.Join(shown, ", "))}
}

func hasConflicts(aff []domain.AffectedMember) bool {
	for _, a := range aff {
		if a.Action == "conflict" {
			return true
		}
	}
	return false
}

type cellSnap struct {
	ID       string  `json:"id"`
	FloorID  string  `json:"floorId"`
	TeamID   *string `json:"teamId"`
	LeadSeat bool    `json:"leadSeat"`
}

type memberSnap struct {
	ID      string  `json:"id"`
	SeatID  *string `json:"seatId"`
	Version int     `json:"version"`
}

type zoneSnap struct {
	Cells   []cellSnap   `json:"cells"`
	Members []memberSnap `json:"members"`
}

func snapshot(ctx context.Context, q querier, cellIDs, memberIDs []string) (zoneSnap, error) {
	var s zoneSnap
	if len(cellIDs) > 0 {
		rows, err := q.Query(ctx, `SELECT id, floor_id, team_id, lead_seat FROM floor_cells WHERE id = ANY($1) ORDER BY id`, cellIDs)
		if err != nil {
			return s, err
		}
		for rows.Next() {
			var c cellSnap
			if err := rows.Scan(&c.ID, &c.FloorID, &c.TeamID, &c.LeadSeat); err != nil {
				rows.Close()
				return s, err
			}
			s.Cells = append(s.Cells, c)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return s, err
		}
	}
	if len(memberIDs) > 0 {
		rows, err := q.Query(ctx, `SELECT id, seat_id, version FROM members WHERE id = ANY($1) ORDER BY id`, memberIDs)
		if err != nil {
			return s, err
		}
		for rows.Next() {
			var m memberSnap
			if err := rows.Scan(&m.ID, &m.SeatID, &m.Version); err != nil {
				rows.Close()
				return s, err
			}
			s.Members = append(s.Members, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return s, err
		}
	}
	return s, nil
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// applyPlan writes a plan: zones, lead flags, people's seats, drafts, floor
// versions, a zone_changes row (for undo), audit, notifications, broadcast.
func (s *Store) applyPlan(ctx context.Context, tx pgx.Tx, actor Actor, p *plan, now time.Time) (string, error) {
	cellIDs := keys(p.cellTeam)
	for id := range p.cellLead {
		if !slices.Contains(cellIDs, id) {
			cellIDs = append(cellIDs, id)
		}
	}
	memberIDs := keys(p.moves)
	before, err := snapshot(ctx, tx, cellIDs, memberIDs)
	if err != nil {
		return "", err
	}
	perFloorTeam := map[string]map[string]*string{}
	perFloorLead := map[string]map[string]bool{}
	for _, c := range before.Cells {
		p.floors = addFloor(p.floors, &c.FloorID)
		if t, ok := p.cellTeam[c.ID]; ok {
			if perFloorTeam[c.FloorID] == nil {
				perFloorTeam[c.FloorID] = map[string]*string{}
			}
			perFloorTeam[c.FloorID][c.ID] = t
		}
		if l, ok := p.cellLead[c.ID]; ok {
			if perFloorLead[c.FloorID] == nil {
				perFloorLead[c.FloorID] = map[string]bool{}
			}
			perFloorLead[c.FloorID][c.ID] = l
		}
	}
	for _, id := range keys(p.cellTeam) {
		if _, err := tx.Exec(ctx, `UPDATE floor_cells SET team_id = $2 WHERE id = $1`, id, p.cellTeam[id]); err != nil {
			return "", err
		}
	}
	for _, id := range keys(p.cellLead) {
		if _, err := tx.Exec(ctx, `UPDATE floor_cells SET lead_seat = $2 WHERE id = $1`, id, p.cellLead[id]); err != nil {
			return "", err
		}
	}
	teamsTouched := []*string{}
	for _, a := range p.affected {
		teamsTouched = append(teamsTouched, strp(a.TeamID))
	}
	for _, m := range before.Members {
		if m.SeatID != nil {
			var fid string
			if err := tx.QueryRow(ctx, `SELECT floor_id FROM floor_cells WHERE id = $1`, *m.SeatID).Scan(&fid); err == nil {
				p.floors = addFloor(p.floors, &fid)
			}
		}
	}
	for _, id := range memberIDs {
		if _, err := tx.Exec(ctx, `UPDATE members SET seat_id = $2, version = version + 1, updated_at = $3 WHERE id = $1`,
			id, p.moves[id], now); err != nil {
			return "", err
		}
	}
	for fid, teams := range perFloorTeam {
		if err := syncDraft(ctx, tx, fid, teams, perFloorLead[fid]); err != nil {
			return "", err
		}
		delete(perFloorLead, fid)
	}
	for fid, lead := range perFloorLead {
		if err := syncDraft(ctx, tx, fid, nil, lead); err != nil {
			return "", err
		}
	}
	sort.Strings(p.floors)
	if len(p.floors) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE floors SET version = version + 1, updated_at = now() WHERE id = ANY($1)`, p.floors); err != nil {
			return "", err
		}
	}
	id := ""
	if p.undoable {
		after, err := snapshot(ctx, tx, cellIDs, memberIDs)
		if err != nil {
			return "", err
		}
		b, _ := json.Marshal(before)
		a, _ := json.Marshal(after)
		id = NewID("zc")
		if _, err := tx.Exec(ctx, `INSERT INTO zone_changes (id, actor_id, actor_name, summary, before, after, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, actor.User.ID, actor.User.Name, domain.Truncate(p.summary, 300), b, a, now); err != nil {
			return "", err
		}
	}
	if err := audit(ctx, tx, actor, p.action, "floor", strings.Join(p.floors, ","), map[string]any{
		"summary": p.summary, "seats": len(p.cellTeam), "leadSeats": len(p.cellLead), "affected": p.affected, "zoneChange": id,
	}); err != nil {
		return "", err
	}
	if err := s.notifyMoves(ctx, tx, actor, p); err != nil {
		return "", err
	}
	if err := s.publishFloors(ctx, tx, actor, "zones", p.floors...); err != nil {
		return "", err
	}
	if len(memberIDs) > 0 {
		if err := s.publishMembers(ctx, tx, actor, memberIDs[0], "seat", 0, teamsTouched...); err != nil {
			return "", err
		}
	}
	return id, nil
}

// notifyMoves tells each affected team's leads who moved or lost a seat, and
// IT that devices may need to follow.
func (s *Store) notifyMoves(ctx context.Context, tx pgx.Tx, actor Actor, p *plan) error {
	byTeam := map[string][]string{}
	moved := 0
	for _, a := range p.affected {
		var line string
		switch a.Action {
		case "relocate", "carry":
			line = fmt.Sprintf("%s: Seat %s → Seat %s", a.Name, a.FromSeat, deref(a.ToSeat))
		case "unseat":
			line = fmt.Sprintf("%s: Seat %s → no seat", a.Name, a.FromSeat)
		default:
			continue
		}
		moved++
		byTeam[a.TeamID] = append(byTeam[a.TeamID], line)
	}
	if moved == 0 {
		return nil
	}
	floor := ""
	if len(p.floors) > 0 {
		floor = p.floors[0]
	}
	for _, team := range keys(byTeam) {
		lines := byTeam[team]
		leads, err := teamLeads(ctx, tx, strp(team))
		if err != nil {
			return err
		}
		body := strings.Join(lines, "; ")
		if err := s.notify(ctx, tx, actor, leads, note{kind: domain.NotifyFloorSeats, entityType: domain.EntityFloor, entityID: floor,
			teamID: strp(team), title: fmt.Sprintf("Seats changed for %d of your people", len(lines)), body: domain.Truncate(body, 900)}); err != nil {
			return err
		}
	}
	it, err := activeIT(ctx, tx)
	if err != nil {
		return err
	}
	var all []string
	for _, team := range keys(byTeam) {
		all = append(all, byTeam[team]...)
	}
	return s.notify(ctx, tx, actor, it, note{kind: domain.NotifyFloorSeats, entityType: domain.EntityFloor, entityID: floor,
		title: fmt.Sprintf("%d %s changed seats — devices may need to move", moved, plural(moved, "person", "people")),
		body:  domain.Truncate(p.summary+". "+strings.Join(all, "; "), 900)})
}

func lockFloors(ctx context.Context, tx pgx.Tx, ids []string) (map[string]floorRow, error) {
	ids = slices.Clone(ids)
	sort.Strings(ids)
	out := map[string]floorRow{}
	for _, id := range ids {
		if _, ok := out[id]; ok {
			continue
		}
		f, err := loadFloorRow(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		out[id] = f
	}
	return out, nil
}

func zoneMode(m string) (string, error) {
	mode, ok := domain.NormalizeZoneMode(m)
	if !ok {
		return "", domain.Invalid("Check the highlighted fields.", map[string]string{"onConflict": "Use relocate, unseat or keep"})
	}
	return mode, nil
}

// AssignZone paints seats of a floor with a team (or clears them). On a
// published floor it is live; on a draft floor it edits the draft only.
func (s *Store) AssignZone(ctx context.Context, actor Actor, floorID string, in domain.ZoneInput) (domain.ZoneChangeResult, error) {
	res := domain.ZoneChangeResult{DryRun: in.DryRun, Affected: []domain.AffectedMember{}, Floors: []string{floorID}}
	if err := requireAdmin(actor); err != nil {
		return res, err
	}
	mode, err := zoneMode(in.OnConflict)
	if err != nil {
		return res, err
	}
	if len(in.SeatIDs)+len(in.Codes) == 0 {
		return res, domain.Invalid("Select at least one seat.", map[string]string{"seatIds": "Select at least one seat"})
	}
	if len(in.SeatIDs)+len(in.Codes) > domain.MaxZoneSeats {
		return res, domain.Invalid("Too many seats.", map[string]string{"seatIds": fmt.Sprintf("At most %d seats at once", domain.MaxZoneSeats)})
	}
	if in.TeamID != nil && strings.TrimSpace(*in.TeamID) == "" {
		in.TeamID = nil
	}
	now := s.Now()
	var conflict error
	err = s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		floors, err := lockFloors(ctx, tx, []string{floorID})
		if err != nil {
			return err
		}
		f := floors[floorID]
		teams, err := teamSet(ctx, tx)
		if err != nil {
			return err
		}
		if in.TeamID != nil {
			if _, ok := teams[*in.TeamID]; !ok {
				return domain.Invalid("Check the highlighted fields.", map[string]string{"teamId": "Unknown team"})
			}
		}
		if f.Status != "published" {
			return s.zoneDraftOnly(ctx, tx, actor, f, in, &res)
		}
		codes := make([]string, len(in.Codes))
		for i, c := range in.Codes {
			codes[i] = strings.ToUpper(strings.TrimSpace(c))
		}
		var ids []string
		rows, err := tx.Query(ctx, `SELECT id FROM floor_cells WHERE floor_id = $1 AND kind = 'seat'
			AND (id = ANY($2) OR code = ANY($3)) ORDER BY id FOR UPDATE`, floorID, append([]string{}, in.SeatIDs...), codes)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(ids) < len(dedupe(in.SeatIDs))+len(dedupe(codes)) && len(ids) == 0 {
			return domain.Invalid("Those seats are not on this floor.", map[string]string{"seatIds": "Unknown seats"})
		}
		seats, err := loadSeats(ctx, tx, ids, false)
		if err != nil {
			return err
		}
		p := newPlan("zone.assigned")
		p.undoable = true
		p.floors = []string{floorID}
		for _, id := range ids {
			sr := seats[id]
			if !sameTeam(sr.TeamID, in.TeamID) {
				p.cellTeam[id] = in.TeamID
			}
			if in.LeadSeat != nil && sr.LeadSeat != *in.LeadSeat {
				p.cellLead[id] = *in.LeadSeat
			}
		}
		occ, err := occupantsOn(ctx, tx, keys(p.cellTeam))
		if err != nil {
			return err
		}
		var hit []occRow
		for _, o := range occ {
			if in.TeamID != nil && o.TeamID != *in.TeamID {
				hit = append(hit, o)
			}
		}
		if err := displace(ctx, tx, p, hit, mode, nil); err != nil {
			return err
		}
		res.SeatsChanged = len(keys(p.cellTeam)) + len(keys(p.cellLead))
		res.Affected = p.affected
		target := "no team"
		if in.TeamID != nil {
			target = teams[*in.TeamID]
		}
		p.summary = fmt.Sprintf("%d seats on %s → %s", len(ids), f.Name, target)
		if hasConflicts(p.affected) && !in.DryRun {
			conflict = conflictErr(p.affected, teams)
			return conflict
		}
		if in.DryRun || res.SeatsChanged == 0 {
			return nil
		}
		zc, err := s.applyPlan(ctx, tx, actor, p, now)
		if err != nil {
			return err
		}
		res.ID, res.Floors = zc, p.floors
		t := domain.NewTime(s.undoDeadline(now))
		res.UndoExpiresAt = &t
		return nil
	})
	if db.IsSeatConflict(err) {
		return res, errSeatRace
	}
	return res, err
}

func dedupe(list []string) []string {
	var out []string
	for _, v := range list {
		if v != "" && !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

// zoneDraftOnly paints seats in an unpublished floor's draft.
func (s *Store) zoneDraftOnly(ctx context.Context, tx pgx.Tx, actor Actor, f floorRow, in domain.ZoneInput, res *domain.ZoneChangeResult) error {
	d := f.doc()
	teams := map[string]*string{}
	lead := map[string]bool{}
	for _, e := range d.Elements {
		if e.Kind != domain.KindSeat || !(slices.Contains(in.SeatIDs, e.ID) || (e.Code != "" && slices.ContainsFunc(in.Codes, func(c string) bool {
			return strings.EqualFold(strings.TrimSpace(c), e.Code)
		}))) {
			continue
		}
		teams[e.ID] = in.TeamID
		if in.LeadSeat != nil {
			lead[e.ID] = *in.LeadSeat
		}
	}
	res.SeatsChanged = len(teams)
	if in.DryRun || len(teams) == 0 {
		return nil
	}
	if err := syncDraft(ctx, tx, f.ID, teams, lead); err != nil {
		return err
	}
	return audit(ctx, tx, actor, "zone.assigned", "floor", f.ID, map[string]any{"draft": true, "seats": len(teams), "teamId": in.TeamID})
}

// MoveZone moves a team's zone: the from-seats lose the zone, the to-seats
// (on any published floor) gain it, and with carry the team's people move
// along in seat-code order. People of other teams on the to-seats are handled
// by OnConflict.
func (s *Store) MoveZone(ctx context.Context, actor Actor, in domain.ZoneMoveInput) (domain.ZoneChangeResult, error) {
	res := domain.ZoneChangeResult{DryRun: in.DryRun, Affected: []domain.AffectedMember{}, Floors: []string{}}
	if err := requireAdmin(actor); err != nil {
		return res, err
	}
	mode, err := zoneMode(in.OnConflict)
	if err != nil {
		return res, err
	}
	in.TeamID = strings.TrimSpace(in.TeamID)
	carry := in.Carry == nil || *in.Carry
	errs := map[string]string{}
	if in.TeamID == "" {
		errs["teamId"] = "Choose a team"
	}
	if len(in.ToSeatIDs) == 0 {
		errs["toSeatIds"] = "Choose where the zone goes"
	}
	if len(in.FromSeatIDs) == 0 && in.FromFloorID == "" {
		errs["fromFloorId"] = "Choose the zone to move"
	}
	if len(in.ToSeatIDs) > domain.MaxZoneSeats || len(in.FromSeatIDs) > domain.MaxZoneSeats {
		errs["toSeatIds"] = fmt.Sprintf("At most %d seats at once", domain.MaxZoneSeats)
	}
	if len(errs) > 0 {
		return res, domain.Invalid("Check the highlighted fields.", errs)
	}
	now := s.Now()
	err = s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		teams, err := teamSet(ctx, tx)
		if err != nil {
			return err
		}
		if _, ok := teams[in.TeamID]; !ok {
			return domain.Invalid("Check the highlighted fields.", map[string]string{"teamId": "Unknown team"})
		}
		from := dedupe(in.FromSeatIDs)
		if len(from) == 0 {
			rows, err := tx.Query(ctx, `SELECT id FROM floor_cells WHERE floor_id = $1 AND kind = 'seat' AND team_id = $2 ORDER BY id`, in.FromFloorID, in.TeamID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				from = append(from, id)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}
		to := dedupe(in.ToSeatIDs)
		all := dedupe(append(slices.Clone(from), to...))
		seats, err := loadSeats(ctx, tx, all, false)
		if err != nil {
			return err
		}
		var floorIDs []string
		for _, id := range all {
			sr, ok := seats[id]
			if !ok || !sr.Published {
				return domain.Invalid("Check the highlighted fields.", map[string]string{"toSeatIds": "Every seat must be a seat on a published floor"})
			}
			floorIDs = addFloor(floorIDs, &sr.FloorID)
		}
		for _, id := range from {
			if seats[id].zone() != in.TeamID && !slices.Contains(to, id) {
				return domain.Invalid("Check the highlighted fields.", map[string]string{"fromSeatIds": fmt.Sprintf("%s is not in %s's zone", seats[id].Code, teams[in.TeamID])})
			}
		}
		if _, err := lockFloors(ctx, tx, floorIDs); err != nil {
			return err
		}
		if _, err := loadSeats(ctx, tx, all, true); err != nil {
			return err
		}
		p := newPlan("zone.moved")
		p.undoable = true
		p.floors = floorIDs
		for _, id := range from {
			if !slices.Contains(to, id) {
				p.cellTeam[id] = nil
				if seats[id].LeadSeat {
					p.cellLead[id] = false
				}
			}
		}
		for _, id := range to {
			if seats[id].zone() != in.TeamID {
				p.cellTeam[id] = strp(in.TeamID)
			}
		}
		// Other teams' people on the destination.
		occTo, err := occupantsOn(ctx, tx, to)
		if err != nil {
			return err
		}
		var hit []occRow
		for _, o := range occTo {
			if o.TeamID != in.TeamID {
				hit = append(hit, o)
			}
		}
		if err := displace(ctx, tx, p, hit, mode, nil); err != nil {
			return err
		}
		// Carry the team's people from the old zone, in code order.
		if carry {
			occFrom, err := occupantsOn(ctx, tx, from)
			if err != nil {
				return err
			}
			var movers []occRow
			for _, o := range occFrom {
				if o.TeamID == in.TeamID && !slices.Contains(to, o.SeatID) {
					movers = append(movers, o)
				}
			}
			sort.Slice(movers, func(i, j int) bool { return movers[i].SeatCode < movers[j].SeatCode })
			// Destination seats in layout order, free once conflicts are handled.
			order := slices.Clone(to)
			sort.SliceStable(order, func(i, j int) bool {
				a, b := seats[order[i]], seats[order[j]]
				if a.FloorID != b.FloorID {
					return a.FloorID < b.FloorID
				}
				return a.Code < b.Code
			})
			busy := map[string]bool{}
			for seat, o := range occTo {
				if mv, moving := p.moves[o.MemberID]; !moving || (mv != nil && *mv == seat) {
					busy[seat] = true
				}
			}
			for _, to := range p.moves {
				if to != nil {
					busy[*to] = true
				}
			}
			i := 0
			for _, o := range movers {
				for i < len(order) && busy[order[i]] {
					i++
				}
				a := domain.AffectedMember{MemberID: o.MemberID, Name: o.Name, TeamID: o.TeamID, FromSeatID: o.SeatID, FromSeat: o.SeatCode}
				if i < len(order) {
					dst := seats[order[i]]
					a.Action, a.ToSeatID, a.ToSeat = "carry", strp(dst.ID), strp(dst.Code)
					p.moves[o.MemberID] = strp(dst.ID)
					busy[dst.ID] = true
				} else {
					a.Action = "unseat"
					p.moves[o.MemberID] = nil
				}
				p.affected = append(p.affected, a)
			}
		}
		res.SeatsChanged = len(p.cellTeam)
		res.Affected = p.affected
		res.Floors = p.floors
		p.summary = fmt.Sprintf("%s zone moved: %d seats → %d seats", teams[in.TeamID], len(from), len(to))
		if hasConflicts(p.affected) && !in.DryRun {
			return conflictErr(p.affected, teams)
		}
		if in.DryRun || (len(p.cellTeam) == 0 && len(p.moves) == 0) {
			return nil
		}
		zc, err := s.applyPlan(ctx, tx, actor, p, now)
		if err != nil {
			return err
		}
		res.ID, res.Floors = zc, p.floors
		t := domain.NewTime(s.undoDeadline(now))
		res.UndoExpiresAt = &t
		return nil
	})
	if db.IsSeatConflict(err) {
		return res, errSeatRace
	}
	return res, err
}

// UndoZoneChange restores the zones and seats a zone change touched, if
// nothing it touched has changed since and the window is open.
func (s *Store) UndoZoneChange(ctx context.Context, actor Actor, id string) error {
	if err := requireAdmin(actor); err != nil {
		return err
	}
	now := s.Now()
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var beforeRaw, afterRaw []byte
		var created time.Time
		var undone *time.Time
		var summary string
		err := tx.QueryRow(ctx, `SELECT before, after, created_at, undone_at, summary FROM zone_changes WHERE id = $1 FOR UPDATE`, id).
			Scan(&beforeRaw, &afterRaw, &created, &undone, &summary)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NotFound("Change not found.")
		}
		if err != nil {
			return err
		}
		switch {
		case undone != nil:
			return domain.Conflict("already_undone", "This change was already undone.")
		case now.After(s.undoDeadline(created)):
			return domain.Conflict("undo_expired", "The undo window has passed.")
		}
		var before, after zoneSnap
		if err := json.Unmarshal(beforeRaw, &before); err != nil {
			return err
		}
		if err := json.Unmarshal(afterRaw, &after); err != nil {
			return err
		}
		var floorIDs []string
		var cellIDs, memberIDs []string
		for _, c := range after.Cells {
			floorIDs = addFloor(floorIDs, &c.FloorID)
			cellIDs = append(cellIDs, c.ID)
		}
		for _, m := range after.Members {
			memberIDs = append(memberIDs, m.ID)
		}
		if _, err := lockFloors(ctx, tx, floorIDs); err != nil {
			return err
		}
		now2, err := snapshot(ctx, tx, cellIDs, memberIDs)
		if err != nil {
			return err
		}
		if !sameSnap(now2, after) {
			return domain.Conflict("undo_stale", "Seats changed since then, so this can't be undone automatically.")
		}
		p := newPlan("zone.undone")
		p.summary = "Undo: " + summary
		p.floors = floorIDs
		for _, c := range before.Cells {
			p.cellTeam[c.ID] = c.TeamID
			p.cellLead[c.ID] = c.LeadSeat
		}
		var targets []string
		for _, m := range before.Members {
			p.moves[m.ID] = m.SeatID
			if m.SeatID != nil {
				targets = append(targets, *m.SeatID)
			}
		}
		if len(targets) > 0 {
			seats, err := loadSeats(ctx, tx, targets, true)
			if err != nil {
				return err
			}
			holders, err := seatHolders(ctx, tx, targets, memberIDs)
			if err != nil {
				return err
			}
			for _, t := range targets {
				if _, ok := seats[t]; !ok || holders[t] != "" {
					return domain.Conflict("undo_stale", "A seat involved is now taken, so this can't be undone automatically.")
				}
			}
		}
		// Report who moves back.
		cur := map[string]memberSnap{}
		for _, m := range now2.Members {
			cur[m.ID] = m
		}
		for _, m := range before.Members {
			var name, team string
			_ = tx.QueryRow(ctx, `SELECT name, team_id FROM members WHERE id = $1`, m.ID).Scan(&name, &team)
			a := domain.AffectedMember{MemberID: m.ID, Name: name, TeamID: team, Action: "relocate", ToSeatID: m.SeatID}
			if c := cur[m.ID].SeatID; c != nil {
				a.FromSeatID = *c
				a.FromSeat = codeOf(ctx, tx, *c)
			}
			if m.SeatID != nil {
				a.ToSeat = strp(codeOf(ctx, tx, *m.SeatID))
			} else {
				a.Action = "unseat"
			}
			p.affected = append(p.affected, a)
		}
		if _, err := s.applyPlan(ctx, tx, actor, p, now); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE zone_changes SET undone_at = $2 WHERE id = $1`, id, now)
		return err
	})
	if db.IsSeatConflict(err) {
		return errSeatRace
	}
	return err
}

func sameSnap(a, b zoneSnap) bool {
	if len(a.Cells) != len(b.Cells) || len(a.Members) != len(b.Members) {
		return false
	}
	for i := range a.Cells {
		x, y := a.Cells[i], b.Cells[i]
		if x.ID != y.ID || !sameTeam(x.TeamID, y.TeamID) || x.LeadSeat != y.LeadSeat {
			return false
		}
	}
	for i := range a.Members {
		x, y := a.Members[i], b.Members[i]
		if x.ID != y.ID || x.Version != y.Version || !sameTeam(x.SeatID, y.SeatID) {
			return false
		}
	}
	return true
}

// AssignSeat seats (or unseats, SeatID nil) one person. Admins may use any
// published seat; a lead only seats their own people within their own zone.
func (s *Store) AssignSeat(ctx context.Context, actor Actor, memberID string, in domain.SeatAssignInput) (domain.Member, error) {
	var out domain.Member
	switch actor.User.Role {
	case "admin", "team_lead":
	default:
		return out, domain.Forbidden("forbidden", "You can't change seats.")
	}
	if in.SeatID != nil && strings.TrimSpace(*in.SeatID) == "" {
		in.SeatID = nil
	}
	now := s.Now()
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var team, name string
		var cur *string
		var version int
		var status string
		err := tx.QueryRow(ctx, `SELECT team_id, name, seat_id, version, status FROM members WHERE id = $1 FOR UPDATE`, memberID).
			Scan(&team, &name, &cur, &version, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NotFound("Person not found.")
		}
		if err != nil {
			return err
		}
		if scope := actor.TeamScope(); actor.User.Role != "admin" && scope != team {
			return domain.NotFound("Person not found.")
		}
		if status != "active" {
			return domain.Conflict("not_active", "Only active people can have a seat.")
		}
		if in.ExpectedVersion != nil && *in.ExpectedVersion != version {
			return domain.Conflict("stale_version", "This person was changed by someone else. Reload and try again.")
		}
		if sameTeam(cur, in.SeatID) {
			return nil
		}
		var floors []string
		if in.SeatID != nil {
			pre, err := loadSeats(ctx, tx, []string{*in.SeatID}, false)
			if err != nil {
				return err
			}
			seats, err := loadSeats(ctx, tx, []string{*in.SeatID}, true)
			if err != nil {
				return err
			}
			holders, err := seatHolders(ctx, tx, []string{*in.SeatID}, []string{memberID})
			if err != nil {
				return err
			}
			if msg, claim, err := checkSeatOrClaim(actor, pre, seats, holders, *in.SeatID, team); err != nil {
				return err
			} else if claim {
				if err := s.claimSeat(ctx, tx, actor, seats[*in.SeatID], team); err != nil {
					return err
				}
			} else if msg != "" {
				if holders[*in.SeatID] != "" {
					return errSeatRace
				}
				return domain.Invalid("Check the highlighted fields.", map[string]string{"seatId": msg})
			}
			floors = addFloor(floors, strp(seats[*in.SeatID].FloorID))
		}
		var from string
		if cur != nil {
			from = codeOf(ctx, tx, *cur)
			var fid string
			if err := tx.QueryRow(ctx, `SELECT floor_id FROM floor_cells WHERE id = $1`, *cur).Scan(&fid); err == nil {
				floors = addFloor(floors, &fid)
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE members SET seat_id = $2, version = version + 1, updated_at = $3 WHERE id = $1`, memberID, in.SeatID, now); err != nil {
			return err
		}
		to := ""
		if in.SeatID != nil {
			to = codeOf(ctx, tx, *in.SeatID)
		}
		if err := audit(ctx, tx, actor, "member.seat", "member", memberID, map[string]any{"name": name, "from": from, "to": to, "seatId": in.SeatID}); err != nil {
			return err
		}
		if actor.User.Role == "admin" && from != "" {
			p := &plan{summary: fmt.Sprintf("%s moved by an admin", name), floors: floors,
				affected: []domain.AffectedMember{{MemberID: memberID, Name: name, TeamID: team, FromSeat: from, ToSeat: nilIfEmpty(to), Action: map[bool]string{true: "relocate", false: "unseat"}[to != ""]}}}
			if err := s.notifyMoves(ctx, tx, actor, p); err != nil {
				return err
			}
		}
		if err := s.publishFloors(ctx, tx, actor, "occupancy", floors...); err != nil {
			return err
		}
		return s.publishMembers(ctx, tx, actor, memberID, "seat", version+1, &team)
	})
	if db.IsSeatConflict(err) {
		return out, errSeatRace
	}
	if err != nil {
		return out, err
	}
	return s.Member(ctx, actor, memberID)
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func codeOf(ctx context.Context, q querier, id string) string {
	c, _ := seatCode(ctx, q, &id)
	return deref(c)
}
