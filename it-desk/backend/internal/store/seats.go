package store

// Seats on published floors: lookup, zone scoping and occupancy checks used
// by member writes, transfers, exits and the floor endpoints.

import (
	"context"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
)

// seatRow is a published seat with its floor.
type seatRow struct {
	ID, Code, FloorID, FloorName string
	TeamID                       *string
	LeadSeat                     bool
	Published                    bool
}

func (r seatRow) zone() string {
	if r.TeamID == nil {
		return ""
	}
	return *r.TeamID
}

// loadSeats returns seats by id. lock takes FOR UPDATE on the seat rows in id
// order, which serialises concurrent writes that put someone on those seats.
func loadSeats(ctx context.Context, q querier, ids []string, lock bool) (map[string]seatRow, error) {
	out := map[string]seatRow{}
	if len(ids) == 0 {
		return out, nil
	}
	sql := `SELECT c.id, c.code, c.floor_id, f.name, c.team_id, c.lead_seat, f.status = 'published'
		FROM floor_cells c JOIN floors f ON f.id = c.floor_id
		WHERE c.id = ANY($1) AND c.kind = 'seat' ORDER BY c.id`
	if lock {
		sql += " FOR UPDATE OF c"
	}
	rows, err := q.Query(ctx, sql, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r seatRow
		if err := rows.Scan(&r.ID, &r.Code, &r.FloorID, &r.FloorName, &r.TeamID, &r.LeadSeat, &r.Published); err != nil {
			return nil, err
		}
		out[r.ID] = r
	}
	return out, rows.Err()
}

// seatHolders maps seat id -> active member id for the given seats, ignoring
// the excluded members (people who are moving off them in the same write).
func seatHolders(ctx context.Context, q querier, ids, exclude []string) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	if exclude == nil {
		exclude = []string{}
	}
	rows, err := q.Query(ctx, `SELECT seat_id, id FROM members
		WHERE seat_id = ANY($1) AND status = 'active' AND NOT (id = ANY($2))`, ids, exclude)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var seat, member string
		if err := rows.Scan(&seat, &member); err != nil {
			return nil, err
		}
		out[seat] = member
	}
	return out, rows.Err()
}

func errZoneScope(code string) error {
	msg := "That seat is outside your team's zone. Ask an admin to change the zone, or use a team transfer."
	if code != "" {
		msg = "Seat " + code + " is outside your team's zone. Ask an admin to change the zone, or use a team transfer."
	}
	return domain.Forbidden("zone_scope", msg)
}

// checkSeatFor verifies one seat for a person of team. It returns a field
// message (validation problem), or an error (403 zone scope / DB).
//   - the seat must exist on a published floor and be free (taken = holders);
//   - a team lead may only use seats in team's zone; admins may use any seat.
func checkSeatFor(actor Actor, seats map[string]seatRow, taken map[string]string, seatID, team string) (string, error) {
	r, ok := seats[seatID]
	if !ok || !r.Published {
		return "That seat is not on a published floor", nil
	}
	if actor.User.Role != "admin" && r.zone() != team {
		return "", errZoneScope(r.Code)
	}
	if _, busy := taken[seatID]; busy {
		return "Seat " + r.Code + " is taken. Pick a free seat.", nil
	}
	return "", nil
}

// seatCodes fills Seat/FloorID on members from their seat ids.
func seatCodes(ctx context.Context, q querier, ms []domain.Member) error {
	var ids []string
	for _, m := range ms {
		if m.SeatID != nil && !slices.Contains(ids, *m.SeatID) {
			ids = append(ids, *m.SeatID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `SELECT id, code, floor_id FROM floor_cells WHERE id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	type loc struct{ code, floor string }
	found := map[string]loc{}
	for rows.Next() {
		var id string
		var l loc
		var code *string
		if err := rows.Scan(&id, &code, &l.floor); err != nil {
			return err
		}
		if code != nil {
			l.code = *code
		}
		found[id] = l
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range ms {
		if ms[i].SeatID == nil {
			continue
		}
		if l, ok := found[*ms[i].SeatID]; ok {
			code, floor := l.code, l.floor
			ms[i].Seat, ms[i].FloorID = &code, &floor
		}
	}
	return nil
}

// seatCode returns a seat's code (nil when id is nil or gone).
func seatCode(ctx context.Context, q querier, id *string) (*string, error) {
	if id == nil {
		return nil, nil
	}
	var code *string
	err := q.QueryRow(ctx, `SELECT code FROM floor_cells WHERE id = $1`, *id).Scan(&code)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return code, err
}

// liveSeats keeps only the ids that still exist (seats removed since a
// snapshot are restored as "no seat").
func liveSeats(ctx context.Context, q querier, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT id FROM floor_cells WHERE id = ANY($1) AND kind = 'seat'`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// checkSeatOrClaim is checkSeatFor for writes that may claim a desk: a team
// lead may also take a free seat that has no zone yet. claim reports that
// the seat must join team's zone (see claimSeat) in the same transaction.
// pre is the seat as read before taking the row lock: if it had no zone then
// but someone claimed it while we waited, the lead gets 409 seat_taken.
func checkSeatOrClaim(actor Actor, pre, seats map[string]seatRow, taken map[string]string, seatID, team string) (msg string, claim bool, err error) {
	r, ok := seats[seatID]
	if p, had := pre[seatID]; had && ok && actor.User.Role != "admin" && p.zone() == "" && r.zone() != "" {
		return "", false, errSeatRace
	}
	if ok && r.Published && actor.User.Role != "admin" && r.zone() == "" {
		if _, busy := taken[seatID]; busy {
			return "Seat " + r.Code + " is taken. Pick a free seat.", false, nil
		}
		return "", true, nil
	}
	msg, err = checkSeatFor(actor, seats, taken, seatID, team)
	return msg, false, err
}

// claimSeat puts one unzoned seat into team's zone (published layout and the
// floor's draft), audits it, tells admins and IT, and broadcasts the floor.
// The conditional update makes a concurrent claim lose with seat_taken.
func (s *Store) claimSeat(ctx context.Context, tx pgx.Tx, actor Actor, seat seatRow, team string) error {
	tag, err := tx.Exec(ctx, `UPDATE floor_cells SET team_id = $2 WHERE id = $1 AND kind = 'seat' AND team_id IS NULL`, seat.ID, team)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errSeatRace
	}
	if err := syncDraft(ctx, tx, seat.FloorID, map[string]*string{seat.ID: &team}, nil); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE floors SET version = version + 1, updated_at = now() WHERE id = $1`, seat.FloorID); err != nil {
		return err
	}
	var teamName string
	if err := tx.QueryRow(ctx, `SELECT name FROM teams WHERE id = $1`, team).Scan(&teamName); err != nil {
		return err
	}
	summary := fmt.Sprintf("Seat %s claimed for %s by %s", seat.Code, teamName, actor.User.Name)
	if err := audit(ctx, tx, actor, "seat.claimed", "floor", seat.FloorID, map[string]any{
		"summary": summary, "seatId": seat.ID, "code": seat.Code, "teamId": team, "floor": seat.FloorName,
	}); err != nil {
		return err
	}
	admins, err := userIDs(ctx, tx, `SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id`)
	if err != nil {
		return err
	}
	it, err := activeIT(ctx, tx)
	if err != nil {
		return err
	}
	if err := s.notify(ctx, tx, actor, append(admins, it...), note{kind: domain.NotifyFloorSeats, entityType: domain.EntityFloor, entityID: seat.FloorID,
		title: summary, body: fmt.Sprintf("%s · Seat %s had no team zone and now belongs to %s.", seat.FloorName, seat.Code, teamName)}); err != nil {
		return err
	}
	return s.publishFloors(ctx, tx, actor, "zones", seat.FloorID)
}
