package domain

import (
	"net/mail"
	"strings"
	"unicode/utf8"
)

// UserInput is what an admin submits to create or edit an account.
type UserInput struct {
	Email           string `json:"email"`
	Name            string `json:"name"`
	Title           string `json:"title"`
	Role            string `json:"role"`
	TeamID          string `json:"teamId"`
	ExpectedVersion *int   `json:"expectedVersion,omitempty"`
}

func NormalizeEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// Validate normalises the input and returns field errors.
func (in *UserInput) Validate() map[string]string {
	errs := map[string]string{}
	in.Email = NormalizeEmail(in.Email)
	in.Name, in.Title = strings.TrimSpace(in.Name), strings.TrimSpace(in.Title)
	in.Role, in.TeamID = strings.TrimSpace(in.Role), strings.TrimSpace(in.TeamID)
	if a, err := mail.ParseAddress(in.Email); err != nil || a.Address != in.Email || len(in.Email) > 254 || !strings.Contains(in.Email[strings.LastIndex(in.Email, "@"):], ".") {
		errs["email"] = "Enter a valid work email"
	}
	if n := utf8.RuneCountInString(in.Name); n < 2 || n > 80 {
		errs["name"] = "Enter a full name (2–80 characters)"
	}
	if utf8.RuneCountInString(in.Title) > 80 {
		errs["title"] = "Keep the title under 80 characters"
	}
	switch in.Role {
	case "team_lead":
		if in.TeamID == "" {
			errs["teamId"] = "Choose the team this lead manages"
		}
	case "admin", "it":
		in.TeamID = ""
	default:
		errs["role"] = "Choose a role"
	}
	return errs
}
