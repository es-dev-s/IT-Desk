// Package domain holds the API's data shapes and pure business rules. JSON tags
// match the frontend's Zod schemas exactly (camelCase, ISO dates).
package domain

import (
	"encoding/json"
	"fmt"
	"time"
)

const (
	DateLayout     = "2006-01-02"
	DateTimeLayout = "2006-01-02T15:04:05.000Z"
)

// Time marshals as an ISO-8601 UTC timestamp with millisecond precision.
type Time struct{ time.Time }

func (t Time) MarshalJSON() ([]byte, error) {
	return json.Marshal(t.UTC().Format(DateTimeLayout))
}

func (t *Time) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return fmt.Errorf("invalid timestamp %q", s)
	}
	t.Time = v
	return nil
}

func NewTime(t time.Time) Time { return Time{t.UTC()} }

// FormatDate renders a DATE column as YYYY-MM-DD.
func FormatDate(t time.Time) string { return t.Format(DateLayout) }

// User is a signed-in account as the API exposes it to its owner.
// TeamID is set for team leads only (admins and IT are org-wide).
type User struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Title  string `json:"title"`
	Role   string `json:"role"`
	TeamID string `json:"teamId,omitempty"`
}

// ManagedUser is the admin view of an account.
type ManagedUser struct {
	User
	Status             string `json:"status"`
	MustChangePassword bool   `json:"mustChangePassword"`
	HasPassword        bool   `json:"hasPassword"`
	LockedUntil        *Time  `json:"lockedUntil"`
	FailedAttempts     int    `json:"failedAttempts"`
	LastLoginAt        *Time  `json:"lastLoginAt"`
	ActiveSessions     int    `json:"activeSessions"`
	CreatedAt          Time   `json:"createdAt"`
	UpdatedAt          Time   `json:"updatedAt"`
	Version            int    `json:"version"`
}

// Team is one entry of the team directory. Leads, LeadName and the counts are
// derived on read: leads are the active team-lead accounts on the team (a
// team may have none, or several), MemberCount is active people and
// SeatsTotal counts seats in the team's zones on published floors and
// SeatsOccupied the team's active people who have a seat.
type Team struct {
	ID            string     `json:"id"`
	Slug          string     `json:"slug"`
	Name          string     `json:"name"`
	Code          string     `json:"code"`
	LeadName      string     `json:"leadName"`
	Leads         []TeamLead `json:"leads"`
	Location      string     `json:"location"`
	MemberCount   int        `json:"memberCount"`
	SeatsOccupied int        `json:"seatsOccupied"`
	SeatsTotal    int        `json:"seatsTotal"`
}

// TeamLead is the public summary of a lead account (no email or status).
type TeamLead struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Device struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Model    string `json:"model"`
	AssetTag string `json:"assetTag"`
}

type Member struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	// EmployeeID is optional (members added by hand may have none).
	EmployeeID string `json:"employeeId"`
	Role       string `json:"role"`
	SubGroup   string `json:"subGroup"`
	// Seat is the seat code (e.g. L4-A01); SeatID/FloorID locate it.
	Seat    *string `json:"seat"`
	SeatID  *string `json:"seatId"`
	FloorID *string `json:"floorId"`
	// IsLead marks the team's lead (flag on the record, or an active
	// team-lead account on the same team with the same email).
	IsLead   bool     `json:"isLead"`
	TeamID   string   `json:"teamId"`
	Status   string   `json:"status"`
	JoinedAt string   `json:"joinedAt"`
	Hue      int      `json:"hue"`
	Version  int      `json:"version"`
	Devices  []Device `json:"devices"`
}

type Move struct {
	MemberID   string   `json:"memberId"`
	MemberName string   `json:"memberName"`
	FromSeat   *string  `json:"fromSeat"`
	ToSeat     *string  `json:"toSeat"`
	FromSeatID *string  `json:"fromSeatId"`
	ToSeatID   *string  `json:"toSeatId"`
	Devices    []Device `json:"devices"`
}

type StatusStep struct {
	Status string `json:"status"`
	At     Time   `json:"at"`
}

type Transfer struct {
	ID            string       `json:"id"`
	Ticket        string       `json:"ticket"`
	Direction     string       `json:"direction"`
	FromTeamID    string       `json:"fromTeamId"`
	ToTeamID      string       `json:"toTeamId"`
	Moves         []Move       `json:"moves"`
	EffectiveDate string       `json:"effectiveDate"`
	CreatedAt     Time         `json:"createdAt"`
	InitiatedBy   string       `json:"initiatedBy"`
	InitiatedByID string       `json:"initiatedById,omitempty"`
	Note          string       `json:"note"`
	ItStatus      string       `json:"itStatus"`
	History       []StatusStep `json:"history"`
	Version       int          `json:"version"`
	// Acknowledgement is set once someone in IT has seen the transfer.
	Acknowledgement *Acknowledgement `json:"acknowledgement"`
}

// Acknowledgement records the IT user who first picked an item up
// ("Seen by … — working on it").
type Acknowledgement struct {
	ByID   *string `json:"byId"`
	ByName string  `json:"byName"`
	At     Time    `json:"at"`
}

// NewAcknowledgement builds an Acknowledgement from nullable columns.
func NewAcknowledgement(byID, byName *string, at *time.Time) *Acknowledgement {
	if at == nil {
		return nil
	}
	a := &Acknowledgement{ByID: byID, At: NewTime(*at)}
	if byName != nil {
		a.ByName = *byName
	}
	return a
}

type ExitRecord struct {
	ID            string  `json:"id"`
	BatchID       string  `json:"batchId"`
	MemberID      string  `json:"memberId"`
	MemberName    string  `json:"memberName"`
	Status        string  `json:"status"`
	Seat          *string `json:"seat"`
	SeatID        *string `json:"seatId"`
	EffectiveDate string  `json:"effectiveDate"`
	CreatedAt     Time    `json:"createdAt"`
	InitiatedBy   string  `json:"initiatedBy"`
	InitiatedByID string  `json:"initiatedById,omitempty"`
	Reason        string  `json:"reason"`
}

type Settings struct {
	Notifications map[string]bool `json:"notifications"`
}

// Workspace is everything the dashboard needs for the signed-in user, in one
// consistent snapshot (read inside a single REPEATABLE READ transaction).
// It is scoped by role: a team lead only receives their own team's people,
// transfers and exits; floors show everyone's seats (other teams' people
// redacted for leads). CurrentTeamID is "" for the admin's org-wide view.
type Workspace struct {
	CurrentTeamID string       `json:"currentTeamId"`
	User          User         `json:"user"`
	Teams         []Team       `json:"teams"`
	Members       []Member     `json:"members"`
	Transfers     []Transfer   `json:"transfers"`
	Exits         []ExitRecord `json:"exits"`
	// Floors are the published floors with occupancy (every role).
	Floors            []Floor  `json:"floors"`
	Settings          Settings `json:"settings"`
	ServerTime        Time     `json:"serverTime"`
	UndoWindowSeconds int      `json:"undoWindowSeconds"`
	// FloorLayoutLocked: layouts are read-only (FLOOR_LAYOUT_LOCKED); the UI hides the builder.
	FloorLayoutLocked bool `json:"floorLayoutLocked"`
}

type TransferResult struct {
	Transfer      Transfer `json:"transfer"`
	Members       []Member `json:"members"`
	UndoExpiresAt Time     `json:"undoExpiresAt"`
}

type ExitResult struct {
	BatchID       string       `json:"batchId"`
	Exits         []ExitRecord `json:"exits"`
	Members       []Member     `json:"members"`
	UndoExpiresAt Time         `json:"undoExpiresAt"`
}

type UndoResult struct {
	Members []Member `json:"members"`
}

type Activity struct {
	ID       int64           `json:"id"`
	At       Time            `json:"at"`
	Actor    string          `json:"actor"`
	Action   string          `json:"action"`
	Entity   string          `json:"entity"`
	EntityID string          `json:"entityId"`
	Data     json.RawMessage `json:"data"`
}

type Page[T any] struct {
	Items  []T `json:"items"`
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}
