package domain

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// IT staff directory: people in IT a request can be routed to (migration
// 0011). An entry may be linked to the IT account that is that person
// (migration 0012, it_staff.user_id): they then sign in, see what is routed to
// them and reply in chat as themselves.
const (
	MinStaffName  = 2
	MaxStaffName  = 80
	MaxStaffTitle = 80
)

type ITStaff struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Title     string `json:"title"`
	Active    bool   `json:"active"`
	SortOrder int    `json:"sortOrder"`
	Open      int    `json:"open"` // open + in-progress requests routed to them
	CreatedAt Time   `json:"createdAt"`
	UpdatedAt Time   `json:"updatedAt"`
	Version   int    `json:"version"`
	// HasLogin: linked to an account. Login (which account) is admin-only.
	HasLogin bool        `json:"hasLogin"`
	Login    *StaffLogin `json:"login,omitempty"`
}

// StaffLogin is the account linked to a directory entry.
type StaffLogin struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// ITStaffInput is the body of POST /admin/it-staff and PATCH /admin/it-staff/{id}.
// On PATCH, nil fields are left unchanged.
type ITStaffInput struct {
	Name            *string `json:"name"`
	Title           *string `json:"title"`
	Active          *bool   `json:"active"`
	SortOrder       *int    `json:"sortOrder"`
	// UserID links the entry to an IT account; "" unlinks (PATCH only).
	UserID          *string `json:"userId"`
	ExpectedVersion *int    `json:"expectedVersion"`
}

// Validate trims the text fields; create requires a name.
func (in *ITStaffInput) Validate(create bool) map[string]string {
	errs := map[string]string{}
	if in.Name != nil {
		v := strings.Join(strings.Fields(*in.Name), " ")
		in.Name = &v
	}
	if in.Title != nil {
		v := strings.Join(strings.Fields(*in.Title), " ")
		in.Title = &v
	}
	if create && in.Name == nil {
		errs["name"] = "Enter a name"
	} else if in.Name != nil {
		if n := utf8.RuneCountInString(*in.Name); n < MinStaffName || n > MaxStaffName {
			errs["name"] = fmt.Sprintf("Use %d–%d characters", MinStaffName, MaxStaffName)
		}
	}
	if in.Title != nil && utf8.RuneCountInString(*in.Title) > MaxStaffTitle {
		errs["title"] = fmt.Sprintf("Keep it under %d characters", MaxStaffTitle)
	}
	if in.UserID != nil {
		v := strings.TrimSpace(*in.UserID)
		in.UserID = &v
	}
	if in.SortOrder != nil && (*in.SortOrder < 0 || *in.SortOrder > 10000) {
		errs["sortOrder"] = "Use 0–10000"
	}
	return errs
}
