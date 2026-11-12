package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
)

// PublishFloor makes the draft live. On an already published floor it
// applies the difference in place (never unpublishing): people on removed
// seats, or on seats handed to another team, are handled by OnConflict.
// Seat codes are filled in and locked on publish so they never shift.
func (s *Store) PublishFloor(ctx context.Context, actor Actor, id string, in domain.PublishInput) (domain.PublishResult, error) {
	res := domain.PublishResult{DryRun: in.DryRun, Affected: []domain.AffectedMember{}}
	if err := requireAdmin(actor); err != nil {
		return res, err
	}
	mode, err := zoneMode(in.OnConflict)
	if err != nil {
		return res, err
	}
	now := s.Now()
	err = s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		f, err := loadFloorRow(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if in.ExpectedDraftVersion != nil && *in.ExpectedDraftVersion != f.DraftVersion {
			return errStaleDraft
		}
		d := f.doc()
		domain.NormalizeElements(d.Elements)
		for i := range d.Elements {
			if d.Elements[i].ID == "" {
				d.Elements[i].ID = NewID("el")
			}
		}
		domain.AutoNumber(f.SeatPrefix, d.Elements, false)
		for i := range d.Elements {
			if d.Elements[i].Kind == domain.KindSeat {
				d.Elements[i].CodeLocked = true
			} else {
				d.Elements[i].Code, d.Elements[i].TeamID, d.Elements[i].LeadSeat, d.Elements[i].CodeLocked = "", nil, false, false
			}
		}
		teams, err := teamSet(ctx, tx)
		if err != nil {
			return err
		}
		if errs := domain.ValidateLayout(d.Cols, d.Rows, d.Elements, func(t string) bool { _, ok := teams[t]; return ok }); len(errs) > 0 {
			return domain.Invalid("Fix the highlighted problems before publishing.", errs)
		}
		cells, err := loadCells(ctx, tx, []string{id})
		if err != nil {
			return err
		}
		cur := map[string]domain.FloorElement{}
		for _, e := range cells[id] {
			cur[e.ID] = e
		}
		next := map[string]domain.FloorElement{}
		for _, e := range d.Elements {
			next[e.ID] = e
		}
		p := newPlan("floor.published")
		p.floors = []string{id}
		removed := map[string]bool{}
		var curSeats []string
		for _, e := range cells[id] {
			if e.Kind != domain.KindSeat {
				continue
			}
			curSeats = append(curSeats, e.ID)
			n, ok := next[e.ID]
			if !ok || n.Kind != domain.KindSeat {
				removed[e.ID] = true
				p.cellTeam[e.ID] = nil // not a candidate for relocation
			} else if !sameTeam(e.TeamID, n.TeamID) {
				p.cellTeam[e.ID] = n.TeamID
			}
		}
		occ, err := occupantsOn(ctx, tx, curSeats)
		if err != nil {
			return err
		}
		var hit []occRow
		for seat, o := range occ {
			if removed[seat] {
				hit = append(hit, o)
				continue
			}
			if t := next[seat].TeamID; t != nil && *t != o.TeamID {
				hit = append(hit, o)
			}
		}
		if err := displace(ctx, tx, p, hit, mode, removed); err != nil {
			return err
		}
		res.Affected = p.affected
		for _, e := range d.Elements {
			if c, ok := cur[e.ID]; !ok {
				res.Added++
			} else if !sameCell(c, e) {
				res.Changed++
			}
		}
		for cid := range cur {
			if _, ok := next[cid]; !ok {
				res.Removed++
			}
		}
		if hasConflicts(p.affected) && !in.DryRun {
			return conflictErr(p.affected, teams)
		}
		if in.DryRun {
			return nil
		}
		b := &pgx.Batch{}
		for _, mid := range keys(p.moves) {
			b.Queue(`UPDATE members SET seat_id = $2, version = version + 1, updated_at = $3 WHERE id = $1`, mid, p.moves[mid], now)
		}
		for _, cid := range keys(cur) {
			if _, ok := next[cid]; !ok {
				b.Queue(`DELETE FROM floor_cells WHERE id = $1`, cid)
			}
		}
		// Free every code that changes first so swaps don't trip the unique index.
		tmp := 0
		for _, e := range d.Elements {
			if c, ok := cur[e.ID]; ok && c.Kind == domain.KindSeat && c.Code != e.Code {
				tmp++
				b.Queue(`UPDATE floor_cells SET code = $2 WHERE id = $1`, e.ID, fmt.Sprintf("TMP-%X", tmp))
			}
		}
		for _, e := range d.Elements {
			var code *string
			if e.Kind == domain.KindSeat {
				code = strp(e.Code)
			}
			if c, ok := cur[e.ID]; ok {
				if !sameCell(c, e) {
					b.Queue(`UPDATE floor_cells SET kind=$2, x=$3, y=$4, w=$5, h=$6, code=$7, label=$8, team_id=$9, lead_seat=$10 WHERE id = $1`,
						e.ID, e.Kind, e.X, e.Y, e.W, e.H, code, e.Label, e.TeamID, e.LeadSeat)
				}
				continue
			}
			b.Queue(`INSERT INTO floor_cells (id, floor_id, kind, x, y, w, h, code, label, team_id, lead_seat)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, e.ID, id, e.Kind, e.X, e.Y, e.W, e.H, code, e.Label, e.TeamID, e.LeadSeat)
		}
		raw, err := json.Marshal(d)
		if err != nil {
			return err
		}
		b.Queue(`UPDATE floors SET status = 'published', cols = $2, rows = $3, draft = $4, draft_version = draft_version + 1,
			version = version + 1, published_at = $5, published_by = $6, updated_at = $5 WHERE id = $1`,
			id, d.Cols, d.Rows, raw, now, actor.User.ID)
		if err := tx.SendBatch(ctx, b).Close(); err != nil {
			if db.Code(err) == "23505" {
				if db.Constraint(err) == "floor_cells_pkey" {
					return domain.Invalid("An element id is already used on another floor.", map[string]string{"elements": "Element ids must be unique across floors"})
				}
				return domain.Invalid("Two seats share a code.", map[string]string{"elements": "Seat codes must be unique on a floor"})
			}
			return err
		}
		if err := audit(ctx, tx, actor, "floor.published", "floor", id, map[string]any{"name": f.Name, "added": res.Added,
			"removed": res.Removed, "changed": res.Changed, "affected": p.affected}); err != nil {
			return err
		}
		p.summary = fmt.Sprintf("%s republished", f.Name)
		if err := s.notifyMoves(ctx, tx, actor, p); err != nil {
			return err
		}
		if err := s.publishFloors(ctx, tx, actor, "published", p.floors...); err != nil {
			return err
		}
		if len(p.moves) > 0 {
			var ts []*string
			for _, a := range p.affected {
				ts = append(ts, strp(a.TeamID))
			}
			return s.publishMembers(ctx, tx, actor, keys(p.moves)[0], "seat", 0, ts...)
		}
		return nil
	})
	if err != nil {
		if db.IsSeatConflict(err) {
			return res, errSeatRace
		}
		return res, err
	}
	if !in.DryRun {
		fl, err := s.Floor(ctx, actor, id)
		if err != nil {
			return res, err
		}
		res.Floor = &fl
	}
	return res, nil
}

func sameCell(a, b domain.FloorElement) bool {
	return a.Kind == b.Kind && a.X == b.X && a.Y == b.Y && a.W == b.W && a.H == b.H && a.Code == b.Code &&
		a.Label == b.Label && a.LeadSeat == b.LeadSeat && sameTeam(a.TeamID, b.TeamID)
}
