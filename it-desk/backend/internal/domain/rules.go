package domain

import (
	"fmt"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ItStatuses    = []string{"requested", "scheduled", "moved", "completed"}
	DeviceKinds   = []string{"laptop", "monitor", "dock", "phone", "keyboard", "mouse", "headset"}
	Notifications = []string{"scheduled", "moved", "incoming", "digest", "liveSound"}
)

const (
	MaxBatch     = 50
	NoteMax      = 280
	ReasonMin    = 4
	ReasonMax    = 280
	EffectiveMin = 30 // days before today
	EffectiveMax = 90 // days after today
)

// NextItStatus returns the stage after cur, or "" when cur is final/unknown.
func NextItStatus(cur string) string {
	for i, s := range ItStatuses {
		if s == cur && i+1 < len(ItStatuses) {
			return ItStatuses[i+1]
		}
	}
	return ""
}

// NormalizeSeat trims a seat id (ids are case-sensitive).
func NormalizeSeat(s string) string { return strings.TrimSpace(s) }

// ValidEffectiveDate accepts YYYY-MM-DD between 30 days ago and 90 days ahead.
func ValidEffectiveDate(v string, now time.Time) (time.Time, string) {
	d, err := time.Parse(DateLayout, v)
	if err != nil {
		return time.Time{}, "Use the YYYY-MM-DD format"
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if d.Before(today.AddDate(0, 0, -EffectiveMin)) || d.After(today.AddDate(0, 0, EffectiveMax)) {
		return time.Time{}, "Pick a date between 30 days ago and 90 days ahead"
	}
	return d, ""
}

type Assignment struct {
	MemberID        string `json:"memberId"`
	ToSeatID        string `json:"toSeatId"`
	ExpectedVersion *int   `json:"expectedVersion,omitempty"`
}

type TransferInput struct {
	Mode            string              `json:"mode"` // internal | team
	ToTeamID        string              `json:"toTeamId"`
	Assignments     []Assignment        `json:"assignments"`
	DevicesByMember map[string][]string `json:"devicesByMember"`
	EffectiveDate   string              `json:"effectiveDate"`
	Note            string              `json:"note"`
}

// Validate checks the request shape. Rules that need current state (who sits
// where) are enforced again inside the database transaction.
func (in *TransferInput) Validate(now time.Time) map[string]string {
	errs := map[string]string{}
	set := func(k, msg string) {
		if _, ok := errs[k]; !ok {
			errs[k] = msg
		}
	}
	in.Note = strings.TrimSpace(in.Note)
	in.ToTeamID = strings.TrimSpace(in.ToTeamID)
	switch in.Mode {
	case "internal", "team":
	default:
		set("mode", "Choose a seat move or a team transfer")
	}
	if in.Mode == "team" && in.ToTeamID == "" {
		set("toTeamId", "Choose a destination team")
	}
	if len(in.Assignments) == 0 {
		set("assignments", "Choose at least one member")
	}
	if len(in.Assignments) > MaxBatch {
		set("assignments", fmt.Sprintf("Move at most %d people at once", MaxBatch))
	}
	if _, msg := ValidEffectiveDate(in.EffectiveDate, now); msg != "" {
		set("effectiveDate", msg)
	}
	if utf8.RuneCountInString(in.Note) > NoteMax {
		set("note", "Keep the note under 280 characters")
	}
	seenMember := map[string]bool{}
	seenSeat := map[string]bool{}
	for i := range in.Assignments {
		a := &in.Assignments[i]
		a.MemberID = strings.TrimSpace(a.MemberID)
		a.ToSeatID = NormalizeSeat(a.ToSeatID)
		key := fmt.Sprintf("assignments.%d.toSeat", i)
		if a.MemberID == "" {
			set(fmt.Sprintf("assignments.%d.memberId", i), "Choose a member")
		} else if seenMember[a.MemberID] {
			set("assignments", "A member is listed twice")
		}
		seenMember[a.MemberID] = true
		switch {
		case a.ToSeatID == "":
			set(key, "Assign a seat")
		case !SeatIDPattern.MatchString(a.ToSeatID):
			set(key, "Pick a seat on the floor plan")
		case seenSeat[a.ToSeatID]:
			set(key, "That seat is assigned twice")
		}
		seenSeat[a.ToSeatID] = true
	}
	return errs
}

func (in *TransferInput) MemberIDs() []string {
	ids := make([]string, len(in.Assignments))
	for i, a := range in.Assignments {
		ids[i] = a.MemberID
	}
	return ids
}

type ExitInput struct {
	MemberIDs     []string `json:"memberIds"`
	Status        string   `json:"status"` // resigned | unknown
	Reason        string   `json:"reason"`
	EffectiveDate string   `json:"effectiveDate"`
}

func (in *ExitInput) Validate(now time.Time) map[string]string {
	errs := map[string]string{}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Status != "resigned" && in.Status != "unknown" {
		errs["status"] = "Status must be resigned or unknown"
	}
	n := utf8.RuneCountInString(in.Reason)
	if n < ReasonMin {
		errs["reason"] = "Add a short reason (at least 4 characters)"
	} else if n > ReasonMax {
		errs["reason"] = "Keep it under 280 characters"
	}
	if _, msg := ValidEffectiveDate(in.EffectiveDate, now); msg != "" {
		errs["effectiveDate"] = msg
	}
	uniq := make([]string, 0, len(in.MemberIDs))
	seen := map[string]bool{}
	for _, id := range in.MemberIDs {
		id = strings.TrimSpace(id)
		if id != "" && !seen[id] {
			seen[id] = true
			uniq = append(uniq, id)
		}
	}
	in.MemberIDs = uniq
	if len(uniq) == 0 {
		errs["memberIds"] = "Choose at least one member"
	} else if len(uniq) > MaxBatch*2 {
		errs["memberIds"] = "Too many members in one request"
	}
	return errs
}

type ProfileInput struct {
	Name  string `json:"name"`
	Email string `json:"email"`
	Title string `json:"title"`
}

func (in *ProfileInput) Validate() map[string]string {
	errs := map[string]string{}
	in.Name, in.Email, in.Title = strings.TrimSpace(in.Name), strings.ToLower(strings.TrimSpace(in.Email)), strings.TrimSpace(in.Title)
	if utf8.RuneCountInString(in.Name) < 2 || utf8.RuneCountInString(in.Name) > 80 {
		errs["name"] = "Enter your full name"
	}
	if a, err := mail.ParseAddress(in.Email); err != nil || a.Address != in.Email {
		errs["email"] = "Enter a valid work email"
	}
	if utf8.RuneCountInString(in.Title) < 2 || utf8.RuneCountInString(in.Title) > 80 {
		errs["title"] = "Enter your title"
	}
	return errs
}

func ValidateSettings(s Settings) map[string]string {
	allowed := map[string]bool{}
	for _, k := range Notifications {
		allowed[k] = true
	}
	for k := range s.Notifications {
		if !allowed[k] {
			return map[string]string{"notifications": "Unknown notification " + k}
		}
	}
	return nil
}
