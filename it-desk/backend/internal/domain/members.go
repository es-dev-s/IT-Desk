package domain

import (
	"fmt"
	"net/mail"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var (
	AssetTagPattern   = regexp.MustCompile(`^IT-[A-Z]{2}-[0-9]{4}$`)
	EmployeeIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)
)

const MaxMemberDevices = 12

// DeviceInput is one piece of kit in an add / edit member form. ID is set
// when editing a device the member already has (keeps its identity).
type DeviceInput struct {
	ID       string `json:"id,omitempty"`
	Kind     string `json:"kind"`
	Model    string `json:"model"`
	AssetTag string `json:"assetTag"`
}

// MemberInput is the body of POST /members and PATCH /members/{id}.
type MemberInput struct {
	Name        string `json:"name"`
	EmployeeID  string `json:"employeeId"`
	Email       string `json:"email"`
	Designation string `json:"designation"`
	SubGroup    string `json:"subGroup"`
	TeamID      string `json:"teamId"`
	// SeatID is a published seat (floor_cells.id); null = no seat.
	SeatID *string `json:"seatId"`
	// IsLead flags the team's lead on the people list (lead badge). Only an
	// admin may set or change it; nil (omitted) keeps the stored flag.
	IsLead          *bool         `json:"isLead"`
	Devices         []DeviceInput `json:"devices"`
	ExpectedVersion *int          `json:"expectedVersion,omitempty"`
}

// Normalize trims every field and upper-cases asset tags.
func (in *MemberInput) Normalize() {
	in.Name = strings.Join(strings.Fields(in.Name), " ")
	in.EmployeeID = strings.TrimSpace(in.EmployeeID)
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	in.Designation = strings.Join(strings.Fields(in.Designation), " ")
	in.SubGroup = strings.Join(strings.Fields(in.SubGroup), " ")
	if in.SubGroup == "" {
		in.SubGroup = "General"
	}
	in.TeamID = strings.TrimSpace(in.TeamID)
	if in.SeatID != nil {
		s := NormalizeSeat(*in.SeatID)
		if s == "" {
			in.SeatID = nil
		} else {
			in.SeatID = &s
		}
	}
	for i := range in.Devices {
		d := &in.Devices[i]
		d.Kind = strings.ToLower(strings.TrimSpace(d.Kind))
		d.Model = strings.Join(strings.Fields(d.Model), " ")
		d.AssetTag = strings.ToUpper(strings.TrimSpace(d.AssetTag))
		d.ID = strings.TrimSpace(d.ID)
	}
}

// Validate checks shape only (call Normalize first). Keys match the form.
func (in MemberInput) Validate() map[string]string {
	errs := map[string]string{}
	if n := utf8.RuneCountInString(in.Name); n < 2 || n > 80 {
		errs["name"] = "Enter a name (2–80 characters)"
	}
	if in.EmployeeID != "" && !EmployeeIDPattern.MatchString(in.EmployeeID) {
		errs["employeeId"] = "Use up to 32 letters, digits, dots, dashes or underscores"
	}
	if in.Email != "" {
		if a, err := mail.ParseAddress(in.Email); err != nil || a.Address != in.Email || len(in.Email) > 254 {
			errs["email"] = "Enter a valid email address"
		}
	}
	if n := utf8.RuneCountInString(in.Designation); n < 2 || n > 80 {
		errs["designation"] = "Enter a designation (2–80 characters)"
	}
	if n := utf8.RuneCountInString(in.SubGroup); n < 2 || n > 60 {
		errs["subGroup"] = "Enter a group (2–60 characters)"
	}
	if in.TeamID == "" {
		errs["teamId"] = "Choose a team"
	}
	if in.SeatID != nil && !SeatIDPattern.MatchString(*in.SeatID) {
		errs["seat"] = "Pick a seat on a floor plan"
	}
	if len(in.Devices) > MaxMemberDevices {
		errs["devices"] = fmt.Sprintf("Add at most %d devices", MaxMemberDevices)
	}
	seen := map[string]int{}
	for i, d := range in.Devices {
		key := fmt.Sprintf("devices.%d.", i)
		if !slices.Contains(DeviceKinds, d.Kind) {
			errs[key+"kind"] = "Choose a device type"
		}
		if n := utf8.RuneCountInString(d.Model); n < 2 || n > 80 {
			errs[key+"model"] = "Enter the model (2–80 characters)"
		}
		if !AssetTagPattern.MatchString(d.AssetTag) {
			errs[key+"assetTag"] = "Asset tags look like IT-LP-0142"
		} else if j, dup := seen[d.AssetTag]; dup {
			errs[key+"assetTag"] = fmt.Sprintf("Same tag as device %d", j+1)
		} else {
			seen[d.AssetTag] = i
		}
	}
	return errs
}

// HueFor derives a stable avatar hue from a name.
func HueFor(s string) int {
	h := uint32(2166136261)
	for _, b := range []byte(strings.ToLower(s)) {
		h ^= uint32(b)
		h *= 16777619
	}
	return int(h % 360)
}
