package domain

import (
	"fmt"
	"strings"
)

// Reports (GET /reports/…): flat, spreadsheet-shaped rows. Scoping follows the
// caller's role and is applied in the store queries.

// MemberDeviceRow is one device a person holds; someone with no devices gets a
// single row with the device fields empty.
type MemberDeviceRow struct {
	MemberID    string  `json:"memberId"`
	MemberName  string  `json:"memberName"`
	EmployeeID  string  `json:"employeeId"`
	TeamID      string  `json:"teamId"`
	TeamName    string  `json:"teamName"`
	SeatCode    *string `json:"seatCode"`
	FloorName   *string `json:"floorName"`
	DeviceID    *string `json:"deviceId"`
	DeviceKind  string  `json:"deviceKind"`
	DeviceModel string  `json:"deviceModel"`
	AssetTag    string  `json:"assetTag"`
}

type MemberDeviceReport struct {
	Rows        []MemberDeviceRow `json:"rows"`
	Members     int               `json:"members"`
	Devices     int               `json:"devices"`
	GeneratedAt Time              `json:"generatedAt"`
}

// MemberLabel is "Name (ID)", or just the name when no employee id is on file.
func (r MemberDeviceRow) MemberLabel() string {
	if r.EmployeeID != "" {
		return r.MemberName + " (" + r.EmployeeID + ")"
	}
	return r.MemberName
}

// SeatLabel is the seat number, with the floor when known.
func (r MemberDeviceRow) SeatLabel() string {
	if r.SeatCode == nil {
		return ""
	}
	if r.FloorName != nil && *r.FloorName != "" {
		return *r.SeatCode + " · " + *r.FloorName
	}
	return *r.SeatCode
}

// DeviceLabel is the device name with its number, e.g. "ThinkPad T14 (Laptop) — IT-LP-0001".
func (r MemberDeviceRow) DeviceLabel() string {
	if r.DeviceID == nil {
		return ""
	}
	name := r.DeviceModel
	if kind := titleWord(r.DeviceKind); kind != "" {
		if name == "" {
			name = kind
		} else {
			name += " (" + kind + ")"
		}
	}
	if r.AssetTag != "" {
		name += " — " + r.AssetTag
	}
	return name
}

// ITTaskRow is one request routed to someone in IT.
type ITTaskRow struct {
	RequestID   string  `json:"requestId"`
	Ticket      string  `json:"ticket"`
	Type        string  `json:"type"`
	Status      string  `json:"status"`
	AssignedAt  Time    `json:"assignedAt"`
	CompletedAt *Time   `json:"completedAt"`
	StaffID     *string `json:"staffId"`
	// ITMember is who in IT the task is assigned to.
	ITMember string  `json:"itMember"`
	TeamID   *string `json:"teamId"`
	TeamName string  `json:"teamName"`
	// MemberName is who the work was for: the person named on the request, else whoever raised it.
	MemberName  string `json:"memberName"`
	Description string `json:"description"`
}

// ITTaskStaff is a choice in the IT-member filter; ID is the value to send back (their name).
type ITTaskStaff struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ITTaskReport struct {
	Rows []ITTaskRow `json:"rows"`
	// Staff are the IT members the caller may filter by (empty for IT accounts, who only see their own).
	Staff       []ITTaskStaff `json:"staff"`
	Completed   int           `json:"completed"`
	GeneratedAt Time          `json:"generatedAt"`
}

// ITTaskDescription says what was done, in one line: the devices handed over
// for an equipment request, or the issue and the device it was about, followed
// by IT's resolution note (which is where a replacement's number is recorded).
func ITTaskDescription(reqType, status string, category *string, title, device string, items []ITRequestItem, resolution string) string {
	var b strings.Builder
	if reqType == RequestTypeIssue {
		if category != nil && *category != "" {
			b.WriteString(titleWord(*category) + " issue")
		} else {
			b.WriteString("Device issue")
		}
		if status == "resolved" {
			b.WriteString(" fixed")
		}
		if t := strings.TrimSpace(title); t != "" {
			b.WriteString(": " + t)
		}
		if d := strings.TrimSpace(device); d != "" {
			b.WriteString(" · Device: " + d)
		}
	} else {
		if status == "resolved" {
			b.WriteString("New device given: ")
		} else {
			b.WriteString("New device requested: ")
		}
		parts := make([]string, 0, len(items))
		for _, it := range items {
			name := titleWord(it.Kind)
			if d := strings.TrimSpace(it.Description); d != "" {
				if it.Kind == "other" {
					name = d
				} else {
					name += " (" + d + ")"
				}
			}
			if it.Quantity > 1 {
				name = fmt.Sprintf("%d × %s", it.Quantity, name)
			}
			parts = append(parts, name)
		}
		if len(parts) == 0 {
			parts = append(parts, "equipment")
		}
		b.WriteString(strings.Join(parts, ", "))
	}
	if r := strings.TrimSpace(resolution); r != "" {
		b.WriteString(" · Resolution: " + r)
	}
	return b.String()
}

func titleWord(s string) string {
	s = strings.TrimSpace(s)
	switch s {
	case "":
		return ""
	case "cpu":
		return "CPU"
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
