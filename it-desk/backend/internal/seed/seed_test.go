package seed

import (
	"regexp"
	"testing"
)

var (
	codeRe = regexp.MustCompile(`^[A-Z]{2,3}$`)
	slugRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
)

// The team catalogue: the 24 unit names, in order, each with a unique badge
// code and slug; every piece of demo data points at one of them.
func TestTeamCatalogue(t *testing.T) {
	d, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Elite Closers", "Power Players", "Summit Seekers", "Ace Performers", "Conversion Queens",
		"Fortune Finders", "Language Warriors", "Victoria", "Rapid Response", "Trend Setters", "Deal Avengers",
		"Success Sharks", "Growth Gladiators", "Limit Breakers", "Alpha Winners", "Nitro Negotiators",
		"Compliance Crew", "KPI Krushers", "Victory Magnets", "Mountain Movers", "Veritas Engines", "Learn Lab",
		"Magic Makers", "Peak Achievers"}
	if len(d.Teams) != len(want) {
		t.Fatalf("want %d teams, got %d", len(want), len(d.Teams))
	}
	teams := map[string]bool{}
	codes, slugs := map[string]bool{}, map[string]bool{}
	for i, tm := range d.Teams {
		if tm.Name != want[i] {
			t.Errorf("team %d: want %q, got %q", i, want[i], tm.Name)
		}
		if !codeRe.MatchString(tm.Code) || codes[tm.Code] {
			t.Errorf("%s: bad or duplicate code %q", tm.Name, tm.Code)
		}
		if !slugRe.MatchString(tm.Slug) || slugs[tm.Slug] || tm.ID != tm.Slug {
			t.Errorf("%s: bad or duplicate slug %q (id %q)", tm.Name, tm.Slug, tm.ID)
		}
		if tm.Location == "" {
			t.Errorf("%s: no floor", tm.Name)
		}
		codes[tm.Code], slugs[tm.Slug], teams[tm.ID] = true, true, true
	}
	if !teams[d.CurrentTeamID] {
		t.Errorf("current team %q not in catalogue", d.CurrentTeamID)
	}
	for _, m := range d.Members {
		if !teams[m.TeamID] {
			t.Errorf("member %s: unknown team %q", m.ID, m.TeamID)
		}
	}
	for _, tr := range d.Transfers {
		if !teams[tr.FromTeamID] || !teams[tr.ToTeamID] {
			t.Errorf("transfer %s: unknown team %q→%q", tr.ID, tr.FromTeamID, tr.ToTeamID)
		}
	}
	for id := range d.ReservedSeats {
		if !teams[id] {
			t.Errorf("reserved seats: unknown team %q", id)
		}
	}
	accounts := map[string]bool{}
	for _, a := range Accounts(d) {
		accounts[a.ID] = true
		if a.Role == "team_lead" && !teams[a.TeamID] {
			t.Errorf("lead %s: unknown team %q", a.ID, a.TeamID)
		}
	}
	for _, r := range demoRequests {
		if r.team != "" && !teams[r.team] {
			t.Errorf("request by %s: unknown team %q", r.requester, r.team)
		}
		if !accounts[r.requester] {
			t.Errorf("request: unknown requester %q", r.requester)
		}
	}
}
