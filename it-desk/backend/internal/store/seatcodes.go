package store

// Real seat numbers: the admin can give any published seat the number that is
// physically on the desk. Only floor_cells.code changes; the seat id stays,
// so members, transfers and history keep pointing at the same desk and show
// the new number everywhere (codes are always read through the seat id).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
)

func seatCodeTaken(code, seatID string) *domain.Error {
	return &domain.Error{Status: http.StatusConflict, Code: "seat_code_taken",
		Message: fmt.Sprintf("Seat number %s is already used on this floor.", code),
		Fields: map[string]string{"code": fmt.Sprintf("Seat %s is taken by another seat — renumber that one too (swaps work in one go)", code),
			"seatId": seatID}}
}

// SetSeatCodes renumbers seats on a published floor in one transaction, so
// swaps (A01↔A02) work. It audits, tells the leads of seated people and IT,
// and broadcasts the floor live.
func (s *Store) SetSeatCodes(ctx context.Context, actor Actor, floorID string, in domain.SeatCodesInput) (domain.SeatCodesResult, error) {
	res := domain.SeatCodesResult{DryRun: in.DryRun, Changed: []domain.SeatCodeChange{}}
	if err := requireAdmin(actor); err != nil {
		return res, err
	}
	if len(in.Changes) == 0 {
		return res, domain.Invalid("Choose at least one seat.", map[string]string{"changes": "Nothing to renumber"})
	}
	if len(in.Changes) > domain.MaxSeatCodeChanges {
		return res, domain.Invalid("Too many seats.", map[string]string{"changes": fmt.Sprintf("At most %d seats at once", domain.MaxSeatCodeChanges)})
	}
	want := map[string]string{} // seat id → new code
	usedBy := map[string]string{}
	for _, c := range in.Changes {
		id := strings.TrimSpace(c.SeatID)
		code := strings.ToUpper(strings.TrimSpace(c.Code))
		if !domain.SeatCodePattern.MatchString(code) {
			return res, domain.Invalid("Check the seat number.", map[string]string{"code": "Use up to 16 capital letters, digits or dashes, starting with a letter or digit"})
		}
		if _, dup := want[id]; dup {
			return res, domain.Invalid("A seat is listed twice.", map[string]string{"changes": "Each seat once"})
		}
		if other, dup := usedBy[code]; dup && other != id {
			return res, domain.Invalid(fmt.Sprintf("Seat number %s is given to two seats.", code), map[string]string{"code": code + " is used twice"})
		}
		want[id], usedBy[code] = code, id
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		floors, err := lockFloors(ctx, tx, []string{floorID})
		if err != nil {
			return err
		}
		f := floors[floorID]
		if f.Status != "published" {
			return domain.Conflict("floor_not_published", "Publish the floor first; draft seat numbers are edited in the builder.")
		}
		rows, err := tx.Query(ctx, `SELECT id, code FROM floor_cells WHERE floor_id = $1 AND kind = 'seat' ORDER BY id FOR UPDATE`, floorID)
		if err != nil {
			return err
		}
		current := map[string]string{}
		for rows.Next() {
			var id, code string
			if err := rows.Scan(&id, &code); err != nil {
				rows.Close()
				return err
			}
			current[id] = code
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		final := map[string]string{}
		for id, code := range current {
			final[id] = code
		}
		for id, code := range want {
			if _, ok := current[id]; !ok {
				return domain.Invalid("That seat is not on this floor.", map[string]string{"seatId": "Unknown seat"})
			}
			if current[id] != code {
				final[id] = code
				res.Changed = append(res.Changed, domain.SeatCodeChange{SeatID: id, Code: code})
			}
		}
		owner := map[string]string{}
		for id, code := range final {
			if o, ok := owner[code]; ok {
				mine := id
				if _, ok := want[o]; ok {
					mine = o
				}
				return seatCodeTaken(code, mine)
			}
			owner[code] = id
		}
		sort.Slice(res.Changed, func(i, j int) bool { return res.Changed[i].SeatID < res.Changed[j].SeatID })
		if in.DryRun || len(res.Changed) == 0 {
			return nil
		}
		ids := make([]string, len(res.Changed))
		for i, c := range res.Changed {
			ids[i] = c.SeatID
		}
		// Two steps so swaps never trip the per-floor unique index mid-way.
		if _, err := tx.Exec(ctx, `UPDATE floor_cells SET code = 'TMP-' || upper(substr(md5(id), 1, 12)) WHERE id = ANY($1)`, ids); err != nil {
			return err
		}
		lines := make([]string, 0, len(res.Changed))
		for _, c := range res.Changed {
			if _, err := tx.Exec(ctx, `UPDATE floor_cells SET code = $2 WHERE id = $1`, c.SeatID, c.Code); err != nil {
				return err
			}
			lines = append(lines, fmt.Sprintf("Seat %s → %s", current[c.SeatID], c.Code))
		}
		if err := syncDraftCodes(ctx, tx, floorID, want); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE floors SET version = version + 1, updated_at = now() WHERE id = $1`, floorID); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "floor.seat_codes", "floor", floorID, map[string]any{"floor": f.Name, "changes": lines}); err != nil {
			return err
		}
		if err := s.notifySeatCodes(ctx, tx, actor, f.Name, floorID, ids, current); err != nil {
			return err
		}
		return s.publishFloors(ctx, tx, actor, "codes", floorID)
	})
	if err != nil && db.Code(err) == "23505" {
		return res, domain.Conflict("seat_code_taken", "That seat number is already used on this floor.")
	}
	return res, err
}

// syncDraftCodes mirrors new numbers into the working draft (same seat ids).
func syncDraftCodes(ctx context.Context, tx pgx.Tx, floorID string, codes map[string]string) error {
	f, err := loadFloorRow(ctx, tx, floorID, false)
	if err != nil {
		return err
	}
	d := f.doc()
	changed := false
	for i := range d.Elements {
		e := &d.Elements[i]
		if c, ok := codes[e.ID]; ok && e.Kind == domain.KindSeat && (e.Code != c || !e.CodeLocked) {
			e.Code, e.CodeLocked, changed = c, true, true
		}
	}
	if !changed {
		return nil
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE floors SET draft = $2, draft_version = draft_version + 1, draft_updated_at = now() WHERE id = $1`, floorID, raw)
	return err
}

// notifySeatCodes tells the leads of anyone sitting on a renumbered seat, and IT.
func (s *Store) notifySeatCodes(ctx context.Context, tx pgx.Tx, actor Actor, floorName, floorID string, ids []string, old map[string]string) error {
	occ, err := occupantsOn(ctx, tx, ids)
	if err != nil || len(occ) == 0 {
		return err
	}
	byTeam := map[string][]string{}
	var all []string
	for _, o := range occ {
		var code string
		if err := tx.QueryRow(ctx, `SELECT code FROM floor_cells WHERE id = $1`, o.SeatID).Scan(&code); err != nil {
			return err
		}
		line := fmt.Sprintf("%s: Seat %s is now Seat %s", o.Name, old[o.SeatID], code)
		byTeam[o.TeamID] = append(byTeam[o.TeamID], line)
		all = append(all, line)
	}
	sort.Strings(all)
	for _, team := range keys(byTeam) {
		leads, err := teamLeads(ctx, tx, strp(team))
		if err != nil {
			return err
		}
		lines := byTeam[team]
		sort.Strings(lines)
		if err := s.notify(ctx, tx, actor, leads, note{kind: domain.NotifyFloorSeats, entityType: domain.EntityFloor, entityID: floorID, teamID: strp(team),
			title: fmt.Sprintf("Seat numbers changed on %s", floorName), body: domain.Truncate(strings.Join(lines, "; "), 900)}); err != nil {
			return err
		}
	}
	it, err := activeIT(ctx, tx)
	if err != nil {
		return err
	}
	return s.notify(ctx, tx, actor, it, note{kind: domain.NotifyFloorSeats, entityType: domain.EntityFloor, entityID: floorID,
		title: fmt.Sprintf("Seat numbers changed on %s (%d seated)", floorName, len(all)), body: domain.Truncate(strings.Join(all, "; "), 900)})
}
