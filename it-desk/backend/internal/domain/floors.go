package domain

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Floor plans: a grid of cols x rows cells holding elements. Seats are 1x1
// and carry a code unique on the floor plus an optional team zone; the other
// kinds are landmarks that may span w x h cells.

const (
	KindSeat  = "seat"
	KindBlock = "block" // desk island / aisle (orange on the source sheets)
	KindVoid  = "void"  // not usable (black)
	KindWall  = "wall"
	KindDoor  = "door"
	KindRoom  = "room"  // labelled landmark area: Washroom, Server, Room, meeting room
	KindLabel = "label" // free text
)

var (
	ElementKinds      = []string{KindSeat, KindBlock, KindVoid, KindWall, KindDoor, KindRoom, KindLabel}
	ElementIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	SeatCodePattern   = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{0,15}$`)
	SeatPrefixPattern = regexp.MustCompile(`^[A-Z0-9-]{0,8}$`)
	SeatIDPattern     = ElementIDPattern
	// Grid limits. Kept in sync with migrations/0008_floor_grid_limits.sql and
	// Frontend/lib/floors.ts (GRID) — TestGridLimitsInSync fails if they drift.
	MinCols, MaxCols  = 2, 200
	MinRows, MaxRows  = 2, 200
	MaxFloorElements  = 4000
	MaxZoneSeats      = 2000
	ZoneConflictModes = []string{"", "relocate", "unseat", "keep"}
)

// FloorElement is one thing drawn on the grid (draft and published alike).
type FloorElement struct {
	ID       string  `json:"id"`
	Kind     string  `json:"kind"`
	X        int     `json:"x"`
	Y        int     `json:"y"`
	W        int     `json:"w"`
	H        int     `json:"h"`
	Code     string  `json:"code,omitempty"`
	Label    string  `json:"label,omitempty"`
	TeamID   *string `json:"teamId"`
	LeadSeat bool    `json:"leadSeat,omitempty"`
	// CodeLocked (draft only) keeps a manually typed code out of auto-numbering.
	CodeLocked bool `json:"codeLocked,omitempty"`
}

// SeatOccupant is who sits on a published seat. For a team lead looking at
// another team's seat the person is redacted (name and id empty) unless the
// occupant is a team lead (lead names are public in the team directory).
type SeatOccupant struct {
	MemberID string `json:"memberId,omitempty"`
	Name     string `json:"name,omitempty"`
	TeamID   string `json:"teamId"`
	IsLead   bool   `json:"isLead"`
	Devices  int    `json:"devices"`
	Hue      int    `json:"hue"`
	Redacted bool   `json:"redacted,omitempty"`
}

type FloorStats struct {
	Seats    int            `json:"seats"`
	Occupied int            `json:"occupied"`
	Zoned    int            `json:"zoned"`
	Free     int            `json:"free"`
	ByTeam   map[string]int `json:"byTeam"` // zone seats per team
	Teams    []string       `json:"teams"`  // teams with a zone here, by seat count
}

// Floor is a published floor with its occupancy (what every role sees).
type Floor struct {
	ID          string                  `json:"id"`
	BuildingID  string                  `json:"buildingId"`
	Name        string                  `json:"name"`
	Level       int                     `json:"level"`
	SortOrder   int                     `json:"sortOrder"`
	SeatPrefix  string                  `json:"seatPrefix"`
	Cols        int                     `json:"cols"`
	Rows        int                     `json:"rows"`
	Notes       string                  `json:"notes"`
	Status      string                  `json:"status"`
	Version     int                     `json:"version"`
	PublishedAt *Time                   `json:"publishedAt"`
	Elements    []FloorElement          `json:"elements"`
	Occupants   map[string]SeatOccupant `json:"occupants"`
	Stats       FloorStats              `json:"stats"`
}

// FloorSummary is a row of the floors list.
type FloorSummary struct {
	ID           string     `json:"id"`
	BuildingID   string     `json:"buildingId"`
	Name         string     `json:"name"`
	Level        int        `json:"level"`
	SortOrder    int        `json:"sortOrder"`
	SeatPrefix   string     `json:"seatPrefix"`
	Cols         int        `json:"cols"`
	Rows         int        `json:"rows"`
	Notes        string     `json:"notes"`
	Status       string     `json:"status"`
	Version      int        `json:"version"`
	DraftVersion int        `json:"draftVersion,omitempty"`
	HasDraft     bool       `json:"hasUnpublishedChanges,omitempty"`
	PublishedAt  *Time      `json:"publishedAt"`
	UpdatedAt    Time       `json:"updatedAt"`
	Stats        FloorStats `json:"stats"`
}

// FloorDraft is the admin's working copy.
type FloorDraft struct {
	FloorID      string         `json:"floorId"`
	Cols         int            `json:"cols"`
	Rows         int            `json:"rows"`
	SeatPrefix   string         `json:"seatPrefix"`
	Elements     []FloorElement `json:"elements"`
	DraftVersion int            `json:"draftVersion"`
	UpdatedAt    Time           `json:"updatedAt"`
	// Dirty: the draft differs from the published layout.
	Dirty  bool     `json:"dirty"`
	Issues []string `json:"issues"`
}

// FloorInput creates a floor or edits its meta.
type FloorInput struct {
	Name       *string `json:"name"`
	Level      *int    `json:"level"`
	SortOrder  *int    `json:"sortOrder"`
	SeatPrefix *string `json:"seatPrefix"`
	Cols       *int    `json:"cols"`
	Rows       *int    `json:"rows"`
	Notes      *string `json:"notes"`
	BuildingID *string `json:"buildingId"`
	// Template (create only): "facing-rows" builds two facing rows of
	// TemplateSeats desks around a centre block with a door.
	Template      string `json:"template,omitempty"`
	TemplateSeats int    `json:"templateSeats,omitempty"`
	// Elements (create only) seeds the draft (e.g. a scripted import).
	Elements        []FloorElement `json:"elements,omitempty"`
	Publish         bool           `json:"publish,omitempty"`
	ExpectedVersion *int           `json:"expectedVersion,omitempty"`
}

// DraftInput replaces (PUT) or patches (PATCH) a draft.
type DraftInput struct {
	Cols                 *int           `json:"cols"`
	Rows                 *int           `json:"rows"`
	SeatPrefix           *string        `json:"seatPrefix"`
	Elements             []FloorElement `json:"elements"` // PUT: full replace
	Upsert               []FloorElement `json:"upsert"`   // PATCH: add or replace by id
	Delete               []string       `json:"delete"`   // PATCH: remove by id
	ExpectedDraftVersion *int           `json:"expectedDraftVersion"`
}

// ZoneInput assigns (or clears, teamId null) the team zone of seats on a
// floor. Seats may be named by id or code. OnConflict decides what happens to
// people already sitting on those seats who are on another team:
// "" (refuse with 409 and the list), relocate (move them to free seats in
// their own team's zone, unseat if none), unseat, or keep (they stay).
type ZoneInput struct {
	TeamID     *string  `json:"teamId"`
	SeatIDs    []string `json:"seatIds"`
	Codes      []string `json:"codes"`
	LeadSeat   *bool    `json:"leadSeat"`
	OnConflict string   `json:"onConflict"`
	DryRun     bool     `json:"dryRun"`
}

// SeatCodeChange gives one published seat its real, physical number.
type SeatCodeChange struct {
	SeatID string `json:"seatId"`
	Code   string `json:"code"`
}

// SeatCodesInput renumbers seats on a published floor. Seat ids never change,
// so members, transfers and history keep pointing at the same desk.
type SeatCodesInput struct {
	Changes []SeatCodeChange `json:"changes"`
	DryRun  bool             `json:"dryRun"`
}

// SeatCodesResult reports what changed (or would change).
type SeatCodesResult struct {
	DryRun  bool             `json:"dryRun"`
	Changed []SeatCodeChange `json:"changed"`
}

// MaxSeatCodeChanges caps one renumbering call.
const MaxSeatCodeChanges = 500

// ZoneMoveInput moves a team's zone: the team's seats in FromSeatIDs (or all
// its seats on FromFloorID) lose the zone, ToSeatIDs (on any floor) gain it,
// and with Carry the team's people on the old seats move along to free new
// seats in code order.
type ZoneMoveInput struct {
	TeamID      string   `json:"teamId"`
	FromFloorID string   `json:"fromFloorId"`
	FromSeatIDs []string `json:"fromSeatIds"`
	ToSeatIDs   []string `json:"toSeatIds"`
	Carry       *bool    `json:"carry"`
	OnConflict  string   `json:"onConflict"`
	DryRun      bool     `json:"dryRun"`
}

// SeatAssignInput puts a member on a seat (or clears it with null).
type SeatAssignInput struct {
	SeatID          *string `json:"seatId"`
	ExpectedVersion *int    `json:"expectedVersion"`
}

// AffectedMember is one person a zone change touches.
type AffectedMember struct {
	MemberID   string  `json:"memberId"`
	Name       string  `json:"name"`
	TeamID     string  `json:"teamId"`
	FromSeatID string  `json:"fromSeatId"`
	FromSeat   string  `json:"fromSeat"`
	ToSeatID   *string `json:"toSeatId"`
	ToSeat     *string `json:"toSeat"`
	Action     string  `json:"action"` // carry | relocate | unseat | keep | conflict
}

type ZoneChangeResult struct {
	ID            string           `json:"id,omitempty"`
	DryRun        bool             `json:"dryRun"`
	SeatsChanged  int              `json:"seatsChanged"`
	Affected      []AffectedMember `json:"affected"`
	Floors        []string         `json:"floors"`
	UndoExpiresAt *Time            `json:"undoExpiresAt,omitempty"`
}

// PublishInput publishes a draft. OnConflict handles people on seats that
// are removed or whose zone moves to another team (see ZoneInput).
type PublishInput struct {
	ExpectedDraftVersion *int   `json:"expectedDraftVersion"`
	OnConflict           string `json:"onConflict"`
	DryRun               bool   `json:"dryRun"`
}

type PublishResult struct {
	Floor    *Floor           `json:"floor,omitempty"`
	DryRun   bool             `json:"dryRun"`
	Affected []AffectedMember `json:"affected"`
	Added    int              `json:"added"`
	Removed  int              `json:"removed"`
	Changed  int              `json:"changed"`
}

// NormalizeElements trims and upper-cases in place.
func NormalizeElements(els []FloorElement) {
	for i := range els {
		e := &els[i]
		e.ID = strings.TrimSpace(e.ID)
		e.Kind = strings.ToLower(strings.TrimSpace(e.Kind))
		e.Code = strings.ToUpper(strings.TrimSpace(e.Code))
		e.Label = strings.Join(strings.Fields(e.Label), " ")
		if e.W <= 0 {
			e.W = 1
		}
		if e.H <= 0 {
			e.H = 1
		}
		if e.TeamID != nil && strings.TrimSpace(*e.TeamID) == "" {
			e.TeamID = nil
		}
		if e.Kind != KindSeat {
			e.Code, e.TeamID, e.LeadSeat, e.CodeLocked = "", nil, false, false
		}
	}
}

// AutoNumber fills empty seat numbers (and refreshes unlocked ones when all
// is true) with plain numbers in reading order: top row first, left to right,
// so the n-th seat is "n" (1, 2, … 100 …). Numbers already held by locked
// (hand-set or published) seats are skipped; prefix is kept for older callers
// and ignored.
func AutoNumber(prefix string, els []FloorElement, all bool) {
	_ = prefix
	used := map[string]bool{}
	for _, e := range els {
		if e.Kind == KindSeat && e.Code != "" && (e.CodeLocked || !all) {
			used[e.Code] = true
		}
	}
	idx := make([]int, 0, len(els))
	for i, e := range els {
		if e.Kind == KindSeat {
			idx = append(idx, i)
		}
	}
	sort.SliceStable(idx, func(a, b int) bool {
		ea, eb := els[idx[a]], els[idx[b]]
		if ea.Y != eb.Y {
			return ea.Y < eb.Y
		}
		return ea.X < eb.X
	})
	next := 1
	for pos, i := range idx {
		e := &els[i]
		if e.CodeLocked || (!all && e.Code != "") {
			continue
		}
		num := max(pos+1, next)
		for used[strconv.Itoa(num)] {
			num++
		}
		e.Code = strconv.Itoa(num)
		used[e.Code] = true
		next = num + 1
	}
}

// solid kinds may not overlap each other; labels may sit on anything and
// rooms may hold doors (a door into a room) but not seats.
func solid(kind string) bool { return kind != KindLabel }

// ValidateLayout checks a layout for publishing. It returns human-readable
// problems keyed by element id ("" for floor-wide problems).
func ValidateLayout(cols, rows int, els []FloorElement, teamExists func(string) bool) map[string]string {
	errs := map[string]string{}
	add := func(id, msg string) {
		if _, ok := errs[id]; !ok {
			errs[id] = msg
		}
	}
	if cols < MinCols || cols > MaxCols {
		add("cols", fmt.Sprintf("Use %d–%d columns", MinCols, MaxCols))
	}
	if rows < MinRows || rows > MaxRows {
		add("rows", fmt.Sprintf("Use %d–%d rows", MinRows, MaxRows))
	}
	if len(els) > MaxFloorElements {
		add("elements", fmt.Sprintf("A floor holds at most %d elements", MaxFloorElements))
		return errs
	}
	ids := map[string]bool{}
	codes := map[string]string{}
	grid := map[[2]int]string{}
	for _, e := range els {
		key := e.ID
		if !ElementIDPattern.MatchString(e.ID) {
			add("elements", "Element ids use 1–40 letters, digits, dashes or underscores")
			continue
		}
		if ids[e.ID] {
			add(key, "Duplicate element id "+e.ID)
			continue
		}
		ids[e.ID] = true
		if !contains(ElementKinds, e.Kind) {
			add(key, "Unknown element type "+e.Kind)
			continue
		}
		if e.X < 0 || e.Y < 0 || e.W < 1 || e.H < 1 || e.X+e.W > cols || e.Y+e.H > rows {
			add(key, fmt.Sprintf("%s at %d,%d is outside the %dx%d grid", e.Kind, e.X, e.Y, cols, rows))
			continue
		}
		if utf8.RuneCountInString(e.Label) > 80 {
			add(key, "Labels are at most 80 characters")
		}
		if e.Kind == KindSeat {
			if e.W != 1 || e.H != 1 {
				add(key, "Seats are one cell")
			}
			switch {
			case e.Code == "":
				add(key, "Seat needs a code")
			case !SeatCodePattern.MatchString(e.Code):
				add(key, "Seat codes use up to 16 capital letters, digits or dashes (e.g. L4-A01)")
			case codes[e.Code] != "":
				add(key, "Seat code "+e.Code+" is used twice")
				add(codes[e.Code], "Seat code "+e.Code+" is used twice")
			default:
				codes[e.Code] = e.ID
			}
			if e.TeamID != nil && teamExists != nil && !teamExists(*e.TeamID) {
				add(key, "Unknown team "+*e.TeamID)
			}
		}
		if !solid(e.Kind) {
			continue
		}
		for dx := 0; dx < e.W; dx++ {
			for dy := 0; dy < e.H; dy++ {
				c := [2]int{e.X + dx, e.Y + dy}
				if other, ok := grid[c]; ok {
					a, b := kindOf(els, other), e.Kind
					// A door may sit in a room's outline.
					if (a == KindRoom && b == KindDoor) || (a == KindDoor && b == KindRoom) {
						continue
					}
					add(key, fmt.Sprintf("%s overlaps %s at %d,%d", e.Kind, a, c[0], c[1]))
					continue
				}
				grid[c] = e.ID
			}
		}
	}
	return errs
}

func kindOf(els []FloorElement, id string) string {
	for _, e := range els {
		if e.ID == id {
			return e.Kind
		}
	}
	return ""
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// ValidateFloorMeta checks name / level / prefix / size on create or edit.
func (in *FloorInput) Normalize() {
	if in.Name != nil {
		n := strings.Join(strings.Fields(*in.Name), " ")
		in.Name = &n
	}
	if in.SeatPrefix != nil {
		p := strings.ToUpper(strings.TrimSpace(*in.SeatPrefix))
		in.SeatPrefix = &p
	}
	if in.Notes != nil {
		n := strings.TrimSpace(*in.Notes)
		in.Notes = &n
	}
	NormalizeElements(in.Elements)
}

func (in FloorInput) Validate(create bool) map[string]string {
	errs := map[string]string{}
	if in.Name != nil {
		if n := utf8.RuneCountInString(*in.Name); n < 1 || n > 80 {
			errs["name"] = "Enter a floor name (1–80 characters)"
		}
	} else if create {
		errs["name"] = "Enter a floor name"
	}
	if in.Level != nil && (*in.Level < -10 || *in.Level > 200) {
		errs["level"] = "Use a level between -10 and 200"
	}
	if in.SeatPrefix != nil && !SeatPrefixPattern.MatchString(*in.SeatPrefix) {
		errs["seatPrefix"] = "Up to 8 capital letters, digits or dashes (e.g. L4-)"
	}
	if in.Cols != nil && (*in.Cols < MinCols || *in.Cols > MaxCols) {
		errs["cols"] = fmt.Sprintf("Use %d–%d columns", MinCols, MaxCols)
	}
	if in.Rows != nil && (*in.Rows < MinRows || *in.Rows > MaxRows) {
		errs["rows"] = fmt.Sprintf("Use %d–%d rows", MinRows, MaxRows)
	}
	if in.Notes != nil && utf8.RuneCountInString(*in.Notes) > 500 {
		errs["notes"] = "Keep notes under 500 characters"
	}
	switch in.Template {
	case "", "facing-rows":
	default:
		errs["template"] = "Unknown template"
	}
	if in.Template != "" && (in.TemplateSeats < 1 || in.TemplateSeats > 60) {
		errs["templateSeats"] = "Use 1–60 seats per row"
	}
	return errs
}

// FacingRowsTemplate builds two facing rows of n desks across a centre block
// with a door at the bottom-left (the "Level-4" sheet). It returns the grid
// size and elements; codes are auto-numbered by the caller.
func FacingRowsTemplate(n int, newID func() string) (cols, rows int, els []FloorElement) {
	cols = n + 2
	if cols < MinCols {
		cols = MinCols
	}
	rows = 7
	for i := 0; i < n; i++ {
		els = append(els, FloorElement{ID: newID(), Kind: KindSeat, X: 1 + i, Y: 1, W: 1, H: 1})
	}
	els = append(els, FloorElement{ID: newID(), Kind: KindBlock, X: 1, Y: 2, W: n, H: 2})
	for i := 0; i < n; i++ {
		els = append(els, FloorElement{ID: newID(), Kind: KindSeat, X: 1 + i, Y: 4, W: 1, H: 1})
	}
	els = append(els, FloorElement{ID: newID(), Kind: KindDoor, X: 0, Y: 5, W: 1, H: 1, Label: "Door"})
	return cols, rows, els
}

// NormalizeZoneMode validates onConflict.
func NormalizeZoneMode(m string) (string, bool) {
	m = strings.ToLower(strings.TrimSpace(m))
	return m, contains(ZoneConflictModes, m)
}
