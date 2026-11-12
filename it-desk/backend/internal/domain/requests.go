package domain

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// IT request vocab. Kinds, priorities and statuses mirror the CHECK
// constraints in migration 0003 and the frontend's Zod enums.
const (
	RequestOpen       = "open"
	RequestInProgress = "in_progress"
	RequestResolved   = "resolved"
	RequestCancelled  = "cancelled"
	RequestRejected   = "rejected"

	MaxRequestItems    = 5
	MaxItemQuantity    = 10
	MinRequestNotes    = 5
	MaxRequestNotes    = 1000
	MaxItemDescription = 120
	MaxRequestComment  = 1000
	MaxResolution      = 500
	MinIssueTitle      = 3
	MaxIssueTitle      = 120
	MaxIssueDevice     = 80

	// Request types: equipment asks (items) and issues (something is broken).
	RequestTypeEquipment = "equipment"
	RequestTypeIssue     = "issue"
)

var (
	RequestKinds      = []string{"laptop", "headphone", "mouse", "cpu", "other"}
	RequestPriorities = []string{"low", "normal", "high", "urgent"}
	RequestStatuses   = []string{RequestOpen, RequestInProgress, RequestResolved, RequestCancelled, RequestRejected}
	RequestTypes      = []string{RequestTypeEquipment, RequestTypeIssue}
	IssueCategories   = []string{"hardware", "network", "software", "access", "other"}
)

// IsRequestType reports whether s is a known request type.
func IsRequestType(s string) bool { return oneOf(s, RequestTypes) }

func oneOf(v string, set []string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

// IsRequestStatus reports whether s is a known request status.
func IsRequestStatus(s string) bool { return oneOf(s, RequestStatuses) }

// RequestClosed reports whether a request has reached a terminal status.
func RequestClosed(status string) bool {
	return status == RequestResolved || status == RequestCancelled || status == RequestRejected
}

// CanMoveRequest is the IT workflow: open → in_progress → resolved, with
// in_progress → open to hand a request back and resolved → in_progress to
// reopen. Rejection and cancellation have their own endpoints.
func CanMoveRequest(from, to string) bool {
	switch from + ">" + to {
	case "open>in_progress", "in_progress>open", "in_progress>resolved", "resolved>in_progress":
		return true
	}
	return false
}

type ITRequestItem struct {
	Kind        string `json:"kind"`
	Quantity    int    `json:"quantity"`
	Description string `json:"description"`
}

type ITRequest struct {
	ID       string          `json:"id"`
	Ticket   string          `json:"ticket"`
	Type     string          `json:"type"` // equipment | issue
	Status   string          `json:"status"`
	Priority string          `json:"priority"`
	Items    []ITRequestItem `json:"items"`
	// Issue-only fields (nil / empty for equipment requests).
	Category      *string `json:"category"`
	Title         string  `json:"title"`
	Device        string  `json:"device"`
	Notes         string  `json:"notes"`
	RequesterID   *string `json:"requesterId"`
	RequesterName string  `json:"requesterName"`
	RequesterRole string  `json:"requesterRole"`
	TeamID        *string `json:"teamId"`
	TeamName      *string `json:"teamName"`
	TeamCode      *string `json:"teamCode"`
	ForMemberID   *string `json:"forMemberId"`
	ForMemberName *string `json:"forMemberName"`
	AssigneeID    *string `json:"assigneeId"`
	AssigneeName  *string `json:"assigneeName"`
	// IT staff directory entry the request is routed to (optional, no login).
	StaffID      *string `json:"staffId"`
	StaffName    *string `json:"staffName"`
	StaffTitle   *string `json:"staffTitle"`
	Resolution   string  `json:"resolution"`
	CommentCount int     `json:"commentCount"`
	CreatedAt    Time    `json:"createdAt"`
	UpdatedAt    Time    `json:"updatedAt"`
	StartedAt    *Time   `json:"startedAt"`
	ClosedAt     *Time   `json:"closedAt"`
	Version      int     `json:"version"`
	// Acknowledgement is set once someone in IT has seen the request.
	Acknowledgement *Acknowledgement `json:"acknowledgement"`
}

type ITRequestEvent struct {
	ID         int64   `json:"id"`
	Kind       string  `json:"kind"`
	ActorID    *string `json:"actorId"`
	ActorName  string  `json:"actorName"`
	ActorRole  string  `json:"actorRole"`
	Body       string  `json:"body"`
	FromStatus *string `json:"fromStatus"`
	ToStatus   *string `json:"toStatus"`
	At         Time    `json:"at"`
}

type ITRequestDetail struct {
	ITRequest
	Events []ITRequestEvent `json:"events"`
}

// RequestCounts are per-status totals within the caller's scope.
type RequestCounts struct {
	Open       int `json:"open"`
	InProgress int `json:"inProgress"`
	Resolved   int `json:"resolved"`
	Cancelled  int `json:"cancelled"`
	Rejected   int `json:"rejected"`
	Total      int `json:"total"`
	// Unassigned open/in-progress requests (IT's triage number).
	Unassigned int `json:"unassigned"`
	// Open + in-progress requests of type issue.
	ActiveIssues int `json:"activeIssues"`
}

type ITRequestList struct {
	Items  []ITRequest   `json:"items"`
	Total  int           `json:"total"`
	Counts RequestCounts `json:"counts"`
}

// Assignee is an IT account a request can be given to.
type Assignee struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Title string `json:"title"`
	Open  int    `json:"open"` // open + in-progress requests currently assigned
}

// ITRequestInput is the body of POST /it-requests.
type ITRequestInput struct {
	// Type is "equipment" (default) or "issue".
	Type  string          `json:"type"`
	Items []ITRequestItem `json:"items"`
	// Issue fields: category and title are required for issues, device is optional.
	Category    string `json:"category"`
	Title       string `json:"title"`
	Device      string `json:"device"`
	Notes       string `json:"notes"`
	Priority    string `json:"priority"`
	ForMemberID string `json:"forMemberId"`
	// TeamID is honoured for admins only (leads always raise for their team).
	TeamID string `json:"teamId"`
	// StaffID optionally routes the request to someone in the IT staff directory.
	StaffID string `json:"staffId"`
}

// Validate normalises the input and returns field errors keyed like the
// form (type, items, items.N.quantity, items.N.description, category, title,
// device, notes, priority).
func (in *ITRequestInput) Validate() map[string]string {
	errs := map[string]string{}
	in.Type = strings.TrimSpace(strings.ToLower(in.Type))
	if in.Type == "" {
		in.Type = RequestTypeEquipment
	}
	in.Category = strings.TrimSpace(strings.ToLower(in.Category))
	in.Title = strings.TrimSpace(in.Title)
	in.Device = strings.TrimSpace(in.Device)
	in.Notes = strings.TrimSpace(in.Notes)
	in.Priority = strings.TrimSpace(in.Priority)
	in.ForMemberID = strings.TrimSpace(in.ForMemberID)
	in.TeamID = strings.TrimSpace(in.TeamID)
	in.StaffID = strings.TrimSpace(in.StaffID)
	if in.Priority == "" {
		in.Priority = "normal"
	}
	if !oneOf(in.Priority, RequestPriorities) {
		errs["priority"] = "Choose a priority"
	}
	switch n := utf8.RuneCountInString(in.Notes); {
	case n < MinRequestNotes && in.Type == RequestTypeIssue:
		errs["notes"] = fmt.Sprintf("Describe what’s happening (at least %d characters)", MinRequestNotes)
	case n < MinRequestNotes:
		errs["notes"] = fmt.Sprintf("Tell IT what you need (at least %d characters)", MinRequestNotes)
	case n > MaxRequestNotes:
		errs["notes"] = fmt.Sprintf("Keep notes under %d characters", MaxRequestNotes)
	}
	switch in.Type {
	case RequestTypeIssue:
		in.validateIssue(errs)
		return errs
	case RequestTypeEquipment:
		// Issue-only fields don't apply to equipment asks.
		in.Category, in.Title, in.Device = "", "", ""
	default:
		errs["type"] = "Choose equipment or issue"
		return errs
	}
	if len(in.Items) == 0 {
		errs["items"] = "Pick at least one item"
	} else if len(in.Items) > MaxRequestItems {
		errs["items"] = "Too many items"
	}
	seen := map[string]bool{}
	for i := range in.Items {
		it := &in.Items[i]
		it.Kind = strings.TrimSpace(strings.ToLower(it.Kind))
		it.Description = strings.TrimSpace(it.Description)
		key := fmt.Sprintf("items.%d", i)
		if !oneOf(it.Kind, RequestKinds) {
			errs[key+".kind"] = "Unknown item"
			continue
		}
		if seen[it.Kind] {
			errs["items"] = "Each item can only be listed once"
		}
		seen[it.Kind] = true
		if it.Quantity < 1 || it.Quantity > MaxItemQuantity {
			errs[key+".quantity"] = fmt.Sprintf("Quantity must be 1–%d", MaxItemQuantity)
		}
		n := utf8.RuneCountInString(it.Description)
		if n > MaxItemDescription {
			errs[key+".description"] = fmt.Sprintf("Keep it under %d characters", MaxItemDescription)
		} else if it.Kind == "other" && n < 2 {
			errs[key+".description"] = "Describe what you need"
		}
	}
	return errs
}

func (in *ITRequestInput) validateIssue(errs map[string]string) {
	if len(in.Items) > 0 {
		errs["items"] = "Issues don’t list equipment — raise an equipment request instead"
	}
	if !oneOf(in.Category, IssueCategories) {
		errs["category"] = "Choose what kind of issue it is"
	}
	switch n := utf8.RuneCountInString(in.Title); {
	case n < MinIssueTitle:
		errs["title"] = fmt.Sprintf("Sum it up in a few words (at least %d characters)", MinIssueTitle)
	case n > MaxIssueTitle:
		errs["title"] = fmt.Sprintf("Keep the title under %d characters", MaxIssueTitle)
	}
	if utf8.RuneCountInString(in.Device) > MaxIssueDevice {
		errs["device"] = fmt.Sprintf("Keep it under %d characters", MaxIssueDevice)
	}
}

// ValidateRequestText trims s and checks it is between min and max runes.
func ValidateRequestText(s string, min, max int) (string, bool) {
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	return s, n >= min && n <= max
}
