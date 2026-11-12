// Package analytics computes the dashboard KPIs for a team (or, with no
// current team, for the whole organisation).
package analytics

import (
	"time"

	"itdesk/backend/internal/domain"
)

type Overview struct {
	TeamID          string         `json:"teamId"`
	ActiveMembers   int            `json:"activeMembers"`
	SeatedMembers   int            `json:"seatedMembers"`
	Capacity        int            `json:"capacity"`
	Occupancy       float64        `json:"occupancy"`
	OpenRequests    int            `json:"openRequests"`
	MovesThisWeek   int            `json:"movesThisWeek"`
	PendingIncoming int            `json:"pendingIncoming"`
	ExitsLast30Days int            `json:"exitsLast30Days"`
	Unknown         int            `json:"unknownStatus"`
	ByStatus        map[string]int `json:"transfersByStatus"`
	GeneratedAt     domain.Time    `json:"generatedAt"`
}

// Compute derives KPIs from a workspace snapshot (same rules as the UI).
func Compute(w domain.Workspace, now time.Time) Overview {
	team := w.CurrentTeamID
	o := Overview{TeamID: team, ByStatus: map[string]int{}, GeneratedAt: domain.NewTime(now)}
	in := func(t string) bool { return team == "" || t == team }
	for _, m := range w.Members {
		if !in(m.TeamID) {
			continue
		}
		switch m.Status {
		case "active":
			o.ActiveMembers++
			if m.Seat != nil {
				o.SeatedMembers++
			}
		case "unknown":
			o.Unknown++
		}
	}
	// Capacity is the seats zoned to the team on published floors.
	for _, t := range w.Teams {
		if in(t.ID) {
			o.Capacity += t.SeatsTotal
		}
	}
	if o.Capacity > 0 {
		o.Occupancy = float64(o.SeatedMembers) / float64(o.Capacity)
	}
	weekAgo := now.Add(-7 * 24 * time.Hour)
	for _, t := range w.Transfers {
		if team != "" && t.FromTeamID != team && t.ToTeamID != team {
			continue
		}
		o.ByStatus[t.ItStatus]++
		if t.ItStatus != "completed" {
			o.OpenRequests++
			if team == "" || t.Direction == "in" {
				o.PendingIncoming++
			}
		}
		if t.CreatedAt.After(weekAgo) {
			o.MovesThisWeek += len(t.Moves)
		}
	}
	monthAgo := now.Add(-30 * 24 * time.Hour)
	for _, e := range w.Exits {
		if e.CreatedAt.After(monthAgo) {
			o.ExitsLast30Days++
		}
	}
	return o
}
