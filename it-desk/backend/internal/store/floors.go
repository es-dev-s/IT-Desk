package store

// Floor plans: CRUD, drafts and publishing (admin), and the published,
// occupancy-annotated view every role reads.

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
	"itdesk/backend/internal/realtime"
)

var (
	errFloorNotFound = domain.NotFound("Floor not found.")
	errStaleDraft    = domain.Conflict("stale_draft", "This floor plan was changed in another window. Reload to get the latest draft.")
	errStaleFloor    = domain.Conflict("stale_floor", "This floor was changed by someone else. Reload and try again.")
	errAdminOnly     = domain.Forbidden("forbidden", "Only an admin can change floor plans.")
)

const isLeadExpr = `(m.is_lead OR (m.email IS NOT NULL AND EXISTS (SELECT 1 FROM users lu WHERE lu.team_id = m.team_id
	AND lu.role = 'team_lead' AND lu.status = 'active' AND lower(lu.email) = lower(m.email))))`

func addFloor(list []string, ids ...*string) []string {
	for _, id := range ids {
		if id != nil && *id != "" && !slices.Contains(list, *id) {
			list = append(list, *id)
		}
	}
	return list
}

// publishFloors broadcasts that floors changed (layout, zones or who sits
// where). Payloads carry no names: clients refetch what they may see.
func (s *Store) publishFloors(ctx context.Context, q querier, actor Actor, change string, ids ...string) error {
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		data, err := json.Marshal(domain.EntityChange{Entity: domain.EntityFloor, ID: id, Change: change, ActorID: actor.User.ID})
		if err != nil {
			return err
		}
		if err := publish(ctx, q, s.channel(), realtime.Envelope{Type: realtime.TypeEntity, Broadcast: true, Data: data}); err != nil {
			return err
		}
	}
	return nil
}

func requireAdmin(actor Actor) error {
	if actor.User.Role != "admin" {
		return errAdminOnly
	}
	return nil
}

type floorRow struct {
	domain.FloorSummary
	draft json.RawMessage
}

const floorCols = `id, building_id, name, level, sort_order, seat_prefix, cols, rows, notes, status, version,
	draft_version, published_at, updated_at, draft`

func scanFloor(row pgx.Row) (floorRow, error) {
	var f floorRow
	var pub *time.Time
	var upd time.Time
	err := row.Scan(&f.ID, &f.BuildingID, &f.Name, &f.Level, &f.SortOrder, &f.SeatPrefix, &f.Cols, &f.Rows, &f.Notes,
		&f.Status, &f.Version, &f.DraftVersion, &pub, &upd, &f.draft)
	if pub != nil {
		t := domain.NewTime(*pub)
		f.PublishedAt = &t
	}
	f.UpdatedAt = domain.NewTime(upd)
	return f, err
}

func loadFloorRow(ctx context.Context, q querier, id string, lock bool) (floorRow, error) {
	sql := `SELECT ` + floorCols + ` FROM floors WHERE id = $1`
	if lock {
		sql += ` FOR UPDATE`
	}
	f, err := scanFloor(q.QueryRow(ctx, sql, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return f, errFloorNotFound
	}
	return f, err
}

// draftDoc is the jsonb stored in floors.draft.
type draftDoc struct {
	Cols     int                   `json:"cols"`
	Rows     int                   `json:"rows"`
	Elements []domain.FloorElement `json:"elements"`
}

func (f floorRow) doc() draftDoc {
	var d draftDoc
	_ = json.Unmarshal(f.draft, &d)
	if d.Cols == 0 {
		d.Cols = f.Cols
	}
	if d.Rows == 0 {
		d.Rows = f.Rows
	}
	if d.Elements == nil {
		d.Elements = []domain.FloorElement{}
	}
	return d
}

// loadCells returns the published elements of floors keyed by floor id.
func loadCells(ctx context.Context, q querier, floorIDs []string) (map[string][]domain.FloorElement, error) {
	out := map[string][]domain.FloorElement{}
	if len(floorIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT floor_id, id, kind, x, y, w, h, COALESCE(code, ''), label, team_id, lead_seat
		FROM floor_cells WHERE floor_id = ANY($1) ORDER BY floor_id, y, x, id`, floorIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var fid string
		var e domain.FloorElement
		if err := rows.Scan(&fid, &e.ID, &e.Kind, &e.X, &e.Y, &e.W, &e.H, &e.Code, &e.Label, &e.TeamID, &e.LeadSeat); err != nil {
			return nil, err
		}
		out[fid] = append(out[fid], e)
	}
	return out, rows.Err()
}

// loadOccupants returns seat id -> occupant for floors. A team lead looking at
// another team's people sees their name and team (so seat pickers can say who
// holds a desk) but not their id or device count.
func loadOccupants(ctx context.Context, q querier, actor Actor, floorIDs []string) (map[string]map[string]domain.SeatOccupant, error) {
	out := map[string]map[string]domain.SeatOccupant{}
	if len(floorIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT c.floor_id, m.seat_id, m.id, m.name, m.team_id, `+isLeadExpr+`,
			(SELECT count(*) FROM devices d WHERE d.member_id = m.id), m.hue
		FROM members m JOIN floor_cells c ON c.id = m.seat_id
		WHERE c.floor_id = ANY($1) AND m.status = 'active'`, floorIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scope := actor.TeamScope()
	for rows.Next() {
		var fid, seat string
		var o domain.SeatOccupant
		if err := rows.Scan(&fid, &seat, &o.MemberID, &o.Name, &o.TeamID, &o.IsLead, &o.Devices, &o.Hue); err != nil {
			return nil, err
		}
		if scope != "" && o.TeamID != scope && !o.IsLead {
			o.MemberID, o.Devices = "", 0
		}
		if out[fid] == nil {
			out[fid] = map[string]domain.SeatOccupant{}
		}
		out[fid][seat] = o
	}
	return out, rows.Err()
}

func floorStats(els []domain.FloorElement, occ map[string]domain.SeatOccupant) domain.FloorStats {
	st := domain.FloorStats{ByTeam: map[string]int{}, Teams: []string{}}
	for _, e := range els {
		if e.Kind != domain.KindSeat {
			continue
		}
		st.Seats++
		if _, ok := occ[e.ID]; ok {
			st.Occupied++
		}
		if e.TeamID != nil {
			st.Zoned++
			st.ByTeam[*e.TeamID]++
		}
	}
	st.Free = st.Seats - st.Occupied
	for t := range st.ByTeam {
		st.Teams = append(st.Teams, t)
	}
	sort.Slice(st.Teams, func(i, j int) bool {
		a, b := st.Teams[i], st.Teams[j]
		if st.ByTeam[a] != st.ByTeam[b] {
			return st.ByTeam[a] > st.ByTeam[b]
		}
		return a < b
	})
	return st
}

// loadFloors returns floors with published layout and occupancy. id limits
// to one floor; publishedOnly hides drafts (always for non-admins).
func loadFloors(ctx context.Context, q querier, actor Actor, id string, publishedOnly bool) ([]domain.Floor, error) {
	if actor.User.Role != "admin" {
		publishedOnly = true
	}
	sql := `SELECT ` + floorCols + ` FROM floors WHERE ($1 = '' OR id = $1) AND (NOT $2 OR status = 'published')
		ORDER BY level DESC, sort_order DESC, name`
	rows, err := q.Query(ctx, sql, id, publishedOnly)
	if err != nil {
		return nil, err
	}
	var list []floorRow
	for rows.Next() {
		f, err := scanFloor(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	ids := make([]string, len(list))
	for i, f := range list {
		ids[i] = f.ID
	}
	cells, err := loadCells(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	occ, err := loadOccupants(ctx, q, actor, ids)
	if err != nil {
		return nil, err
	}
	out := make([]domain.Floor, 0, len(list))
	for _, f := range list {
		fl := domain.Floor{ID: f.ID, BuildingID: f.BuildingID, Name: f.Name, Level: f.Level, SortOrder: f.SortOrder,
			SeatPrefix: f.SeatPrefix, Cols: f.Cols, Rows: f.Rows, Notes: f.Notes, Status: f.Status, Version: f.Version,
			PublishedAt: f.PublishedAt, Elements: cells[f.ID], Occupants: occ[f.ID]}
		if fl.Elements == nil {
			fl.Elements = []domain.FloorElement{}
		}
		if fl.Occupants == nil {
			fl.Occupants = map[string]domain.SeatOccupant{}
		}
		fl.Stats = floorStats(fl.Elements, fl.Occupants)
		out = append(out, fl)
	}
	return out, nil
}

// Floors lists floors (admins also see drafts) with occupancy stats.
func (s *Store) Floors(ctx context.Context, actor Actor) ([]domain.FloorSummary, error) {
	var out []domain.FloorSummary
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		floors, err := loadFloors(ctx, tx, actor, "", false)
		if err != nil {
			return err
		}
		drafts := map[string]floorRow{}
		if actor.User.Role == "admin" {
			rows, err := tx.Query(ctx, `SELECT `+floorCols+` FROM floors`)
			if err != nil {
				return err
			}
			for rows.Next() {
				f, err := scanFloor(rows)
				if err != nil {
					rows.Close()
					return err
				}
				drafts[f.ID] = f
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}
		out = make([]domain.FloorSummary, 0, len(floors))
		for _, f := range floors {
			sum := domain.FloorSummary{ID: f.ID, BuildingID: f.BuildingID, Name: f.Name, Level: f.Level, SortOrder: f.SortOrder,
				SeatPrefix: f.SeatPrefix, Cols: f.Cols, Rows: f.Rows, Notes: f.Notes, Status: f.Status, Version: f.Version,
				PublishedAt: f.PublishedAt, Stats: f.Stats}
			if d, ok := drafts[f.ID]; ok {
				sum.UpdatedAt = d.UpdatedAt
				sum.DraftVersion = d.DraftVersion
				sum.HasDraft = !sameLayout(d.doc(), f)
			}
			out = append(out, sum)
		}
		return nil
	})
	return out, err
}

// sameLayout reports whether a draft matches the published elements.
func sameLayout(d draftDoc, f domain.Floor) bool {
	if d.Cols != f.Cols || d.Rows != f.Rows || len(d.Elements) != len(f.Elements) {
		return false
	}
	pub := map[string]domain.FloorElement{}
	for _, e := range f.Elements {
		pub[e.ID] = e
	}
	for _, e := range d.Elements {
		p, ok := pub[e.ID]
		if !ok || p.Kind != e.Kind || p.X != e.X || p.Y != e.Y || p.W != e.W || p.H != e.H || p.Code != e.Code ||
			p.Label != e.Label || p.LeadSeat != e.LeadSeat || !sameTeam(p.TeamID, e.TeamID) {
			return false
		}
	}
	return true
}

func sameTeam(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// Floor returns one floor (published only for non-admins).
func (s *Store) Floor(ctx context.Context, actor Actor, id string) (domain.Floor, error) {
	var out domain.Floor
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		list, err := loadFloors(ctx, tx, actor, id, false)
		if err != nil {
			return err
		}
		if len(list) == 0 {
			return errFloorNotFound
		}
		out = list[0]
		return nil
	})
	return out, err
}

func teamSet(ctx context.Context, q querier) (map[string]string, error) {
	rows, err := q.Query(ctx, `SELECT id, name FROM teams`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

func mapFloorWriteErr(err error) error {
	if db.Code(err) == "23505" && strings.Contains(err.Error(), "floors_name_uq") {
		return domain.Invalid("Check the highlighted fields.", map[string]string{"name": "Another floor already has this name"})
	}
	return err
}

// CreateFloor adds a floor (draft, or published straight away with Publish).
func (s *Store) CreateFloor(ctx context.Context, actor Actor, in domain.FloorInput) (domain.FloorSummary, error) {
	var out domain.FloorSummary
	if err := requireAdmin(actor); err != nil {
		return out, err
	}
	in.Normalize()
	if errs := in.Validate(true); len(errs) > 0 {
		return out, domain.Invalid("Check the highlighted fields.", errs)
	}
	cols, rows := 30, 12
	if in.Cols != nil {
		cols = *in.Cols
	}
	if in.Rows != nil {
		rows = *in.Rows
	}
	prefix := ""
	if in.SeatPrefix != nil {
		prefix = *in.SeatPrefix
	}
	els := in.Elements
	if in.Template == "facing-rows" {
		var tc, tr int
		tc, tr, els = domain.FacingRowsTemplate(in.TemplateSeats, func() string { return NewID("el") })
		cols, rows = max(cols, tc), max(rows, tr)
		if in.Cols == nil {
			cols = tc
		}
		if in.Rows == nil {
			rows = tr
		}
	}
	if els == nil {
		els = []domain.FloorElement{}
	}
	for i := range els {
		if els[i].ID == "" {
			els[i].ID = NewID("el")
		}
	}
	domain.AutoNumber(prefix, els, false)
	level, sortOrder, notes, building := 0, 0, "", "hq"
	if in.Level != nil {
		level = *in.Level
		sortOrder = level
	}
	if in.SortOrder != nil {
		sortOrder = *in.SortOrder
	}
	if in.Notes != nil {
		notes = *in.Notes
	}
	if in.BuildingID != nil && *in.BuildingID != "" {
		building = *in.BuildingID
	}
	id := NewID("flr")
	doc, err := json.Marshal(draftDoc{Cols: cols, Rows: rows, Elements: els})
	if err != nil {
		return out, err
	}
	err = s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO floors (id, building_id, name, level, sort_order, seat_prefix, cols, rows, notes, draft)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, building, *in.Name, level, sortOrder, prefix, cols, rows, notes, doc); err != nil {
			return mapFloorWriteErr(err)
		}
		return audit(ctx, tx, actor, "floor.created", "floor", id, map[string]any{"name": *in.Name, "elements": len(els)})
	})
	if err != nil {
		return out, err
	}
	if in.Publish {
		if _, err := s.PublishFloor(ctx, actor, id, domain.PublishInput{}); err != nil {
			return out, err
		}
	}
	return s.floorSummary(ctx, actor, id)
}

func (s *Store) floorSummary(ctx context.Context, actor Actor, id string) (domain.FloorSummary, error) {
	list, err := s.Floors(ctx, actor)
	if err != nil {
		return domain.FloorSummary{}, err
	}
	for _, f := range list {
		if f.ID == id {
			return f, nil
		}
	}
	return domain.FloorSummary{}, errFloorNotFound
}

// UpdateFloor edits a floor's name, level, order, seat prefix and notes.
// Published floors stay published.
func (s *Store) UpdateFloor(ctx context.Context, actor Actor, id string, in domain.FloorInput) (domain.FloorSummary, error) {
	if err := requireAdmin(actor); err != nil {
		return domain.FloorSummary{}, err
	}
	in.Normalize()
	if errs := in.Validate(false); len(errs) > 0 {
		return domain.FloorSummary{}, domain.Invalid("Check the highlighted fields.", errs)
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		f, err := loadFloorRow(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if in.ExpectedVersion != nil && *in.ExpectedVersion != f.Version {
			return errStaleFloor
		}
		name, level, sortOrder, prefix, notes := f.Name, f.Level, f.SortOrder, f.SeatPrefix, f.Notes
		if in.Name != nil {
			name = *in.Name
		}
		if in.Level != nil {
			level = *in.Level
		}
		if in.SortOrder != nil {
			sortOrder = *in.SortOrder
		}
		if in.SeatPrefix != nil {
			prefix = *in.SeatPrefix
		}
		if in.Notes != nil {
			notes = *in.Notes
		}
		if _, err := tx.Exec(ctx, `UPDATE floors SET name=$2, level=$3, sort_order=$4, seat_prefix=$5, notes=$6,
			version = version + 1, updated_at = now() WHERE id = $1`, id, name, level, sortOrder, prefix, notes); err != nil {
			return mapFloorWriteErr(err)
		}
		if err := audit(ctx, tx, actor, "floor.updated", "floor", id, map[string]any{"name": name, "level": level}); err != nil {
			return err
		}
		if f.Status == "published" {
			return s.publishFloors(ctx, tx, actor, "updated", id)
		}
		return nil
	})
	if err != nil {
		return domain.FloorSummary{}, err
	}
	return s.floorSummary(ctx, actor, id)
}

// DeleteFloor removes a floor nobody sits on.
func (s *Store) DeleteFloor(ctx context.Context, actor Actor, id string) error {
	if err := requireAdmin(actor); err != nil {
		return err
	}
	return s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		f, err := loadFloorRow(ctx, tx, id, true)
		if err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM members m JOIN floor_cells c ON c.id = m.seat_id
			WHERE c.floor_id = $1`, id).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return domain.Conflict("floor_occupied", fmt.Sprintf("%d %s still seated on this floor. Move them first.", n, plural(n, "person is", "people are")))
		}
		if _, err := tx.Exec(ctx, `UPDATE exits SET seat_id = NULL WHERE seat_id IN (SELECT id FROM floor_cells WHERE floor_id = $1)`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM floors WHERE id = $1`, id); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "floor.deleted", "floor", id, map[string]any{"name": f.Name}); err != nil {
			return err
		}
		return s.publishFloors(ctx, tx, actor, "deleted", id)
	})
}

// DuplicateFloor copies a floor's draft (new element ids, no zones kept
// unless keepZones) into a new draft floor.
func (s *Store) DuplicateFloor(ctx context.Context, actor Actor, id, name string, keepZones bool) (domain.FloorSummary, error) {
	if err := requireAdmin(actor); err != nil {
		return domain.FloorSummary{}, err
	}
	pool, err := s.pool()
	if err != nil {
		return domain.FloorSummary{}, err
	}
	f, err := loadFloorRow(ctx, pool, id, false)
	if err != nil {
		return domain.FloorSummary{}, err
	}
	d := f.doc()
	for i := range d.Elements {
		d.Elements[i].ID = NewID("el")
		if !keepZones {
			d.Elements[i].TeamID = nil
		}
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = f.Name + " (copy)"
	}
	cols, rows, prefix, notes := d.Cols, d.Rows, f.SeatPrefix, f.Notes
	return s.CreateFloor(ctx, actor, domain.FloorInput{Name: &name, Level: &f.Level, SortOrder: &f.SortOrder, SeatPrefix: &prefix,
		Cols: &cols, Rows: &rows, Notes: &notes, Elements: d.Elements})
}

func draftIssues(d draftDoc, teams map[string]string) []string {
	errs := domain.ValidateLayout(d.Cols, d.Rows, d.Elements, func(id string) bool { _, ok := teams[id]; return ok })
	out := make([]string, 0, len(errs))
	for _, v := range errs {
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

func (s *Store) draftOf(ctx context.Context, q querier, f floorRow) (domain.FloorDraft, error) {
	d := f.doc()
	teams, err := teamSet(ctx, q)
	if err != nil {
		return domain.FloorDraft{}, err
	}
	cells, err := loadCells(ctx, q, []string{f.ID})
	if err != nil {
		return domain.FloorDraft{}, err
	}
	pub := domain.Floor{Cols: f.Cols, Rows: f.Rows, Elements: cells[f.ID]}
	return domain.FloorDraft{FloorID: f.ID, Cols: d.Cols, Rows: d.Rows, SeatPrefix: f.SeatPrefix, Elements: d.Elements,
		DraftVersion: f.DraftVersion, UpdatedAt: f.UpdatedAt, Dirty: f.Status != "published" || !sameLayout(d, pub),
		Issues: draftIssues(d, teams)}, nil
}

// Draft returns the admin's working copy of a floor.
func (s *Store) Draft(ctx context.Context, actor Actor, id string) (domain.FloorDraft, error) {
	if err := requireAdmin(actor); err != nil {
		return domain.FloorDraft{}, err
	}
	var out domain.FloorDraft
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		f, err := loadFloorRow(ctx, tx, id, false)
		if err != nil {
			return err
		}
		out, err = s.draftOf(ctx, tx, f)
		return err
	})
	return out, err
}

// SaveDraft replaces (patch=false) or patches the draft. Drafts may be
// incomplete; problems are reported in Issues and block only publishing.
func (s *Store) SaveDraft(ctx context.Context, actor Actor, id string, in domain.DraftInput, patch bool) (domain.FloorDraft, error) {
	if err := requireAdmin(actor); err != nil {
		return domain.FloorDraft{}, err
	}
	var out domain.FloorDraft
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		f, err := loadFloorRow(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if in.ExpectedDraftVersion != nil && *in.ExpectedDraftVersion != f.DraftVersion {
			return errStaleDraft
		}
		d := f.doc()
		if patch {
			domain.NormalizeElements(in.Upsert)
			del := map[string]bool{}
			for _, id := range in.Delete {
				del[id] = true
			}
			idx := map[string]int{}
			kept := d.Elements[:0]
			for _, e := range d.Elements {
				if !del[e.ID] {
					idx[e.ID] = len(kept)
					kept = append(kept, e)
				}
			}
			d.Elements = kept
			for _, e := range in.Upsert {
				if e.ID == "" {
					e.ID = NewID("el")
				}
				if i, ok := idx[e.ID]; ok {
					d.Elements[i] = e
				} else {
					idx[e.ID] = len(d.Elements)
					d.Elements = append(d.Elements, e)
				}
			}
		} else {
			if in.Elements == nil {
				in.Elements = []domain.FloorElement{}
			}
			domain.NormalizeElements(in.Elements)
			for i := range in.Elements {
				if in.Elements[i].ID == "" {
					in.Elements[i].ID = NewID("el")
				}
			}
			d.Elements = in.Elements
		}
		if in.Cols != nil {
			d.Cols = *in.Cols
		}
		if in.Rows != nil {
			d.Rows = *in.Rows
		}
		if d.Cols < domain.MinCols || d.Cols > domain.MaxCols || d.Rows < domain.MinRows || d.Rows > domain.MaxRows {
			return domain.Invalid("Check the grid size.", map[string]string{"cols": fmt.Sprintf("Use %d–%d columns and %d–%d rows",
				domain.MinCols, domain.MaxCols, domain.MinRows, domain.MaxRows)})
		}
		if len(d.Elements) > domain.MaxFloorElements {
			return domain.Invalid("This floor plan is too large.", map[string]string{"elements": fmt.Sprintf("At most %d elements", domain.MaxFloorElements)})
		}
		prefix := f.SeatPrefix
		if in.SeatPrefix != nil {
			p := strings.ToUpper(strings.TrimSpace(*in.SeatPrefix))
			if !domain.SeatPrefixPattern.MatchString(p) {
				return domain.Invalid("Check the highlighted fields.", map[string]string{"seatPrefix": "Up to 8 capital letters, digits or dashes"})
			}
			prefix = p
		}
		raw, err := json.Marshal(d)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE floors SET draft = $2, seat_prefix = $3, draft_version = draft_version + 1,
			draft_updated_at = now(), updated_at = now() WHERE id = $1`, id, raw, prefix); err != nil {
			return err
		}
		f, err = loadFloorRow(ctx, tx, id, false)
		if err != nil {
			return err
		}
		out, err = s.draftOf(ctx, tx, f)
		return err
	})
	return out, err
}

// syncDraft mirrors live zone changes into a floor's draft so the builder
// shows them and a later publish keeps them.
func syncDraft(ctx context.Context, tx pgx.Tx, floorID string, teams map[string]*string, lead map[string]bool) error {
	f, err := loadFloorRow(ctx, tx, floorID, false)
	if err != nil {
		return err
	}
	d := f.doc()
	changed := false
	for i := range d.Elements {
		e := &d.Elements[i]
		if t, ok := teams[e.ID]; ok && e.Kind == domain.KindSeat {
			e.TeamID = t
			changed = true
		}
		if l, ok := lead[e.ID]; ok && e.Kind == domain.KindSeat {
			e.LeadSeat = l
			changed = true
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

// DiscardDraft throws away unpublished builder changes: the draft becomes a
// copy of the live layout again. Live zones, seat numbers and seated people
// are untouched.
func (s *Store) DiscardDraft(ctx context.Context, actor Actor, id string) (domain.FloorDraft, error) {
	if err := requireAdmin(actor); err != nil {
		return domain.FloorDraft{}, err
	}
	var out domain.FloorDraft
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		f, err := loadFloorRow(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if f.Status != "published" {
			return domain.BadRequest("This floor has never been published, so there is nothing to go back to.")
		}
		cells, err := loadCells(ctx, tx, []string{f.ID})
		if err != nil {
			return err
		}
		els := cells[f.ID]
		if els == nil {
			els = []domain.FloorElement{}
		}
		for i := range els {
			els[i].CodeLocked = els[i].Kind == domain.KindSeat
		}
		raw, err := json.Marshal(draftDoc{Cols: f.Cols, Rows: f.Rows, Elements: els})
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE floors SET draft = $2, draft_version = draft_version + 1,
			draft_updated_at = now(), updated_at = now() WHERE id = $1`, id, raw); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "floor.draft_discarded", "floor", id, map[string]any{"name": f.Name}); err != nil {
			return err
		}
		if f, err = loadFloorRow(ctx, tx, id, false); err != nil {
			return err
		}
		out, err = s.draftOf(ctx, tx, f)
		return err
	})
	return out, err
}
