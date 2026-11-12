package domain

import (
	"strings"
	"testing"
)

func TestITRequestInputValidate(t *testing.T) {
	valid := func() ITRequestInput {
		return ITRequestInput{
			Items: []ITRequestItem{{Kind: "Laptop", Quantity: 1}, {Kind: "other", Quantity: 2, Description: " USB-C dock "}},
			Notes: "  New joiner starts Monday  ",
		}
	}
	in := valid()
	if errs := in.Validate(); len(errs) != 0 {
		t.Fatalf("valid input rejected: %v", errs)
	}
	if in.Priority != "normal" || in.Items[0].Kind != "laptop" || in.Items[1].Description != "USB-C dock" || in.Notes != "New joiner starts Monday" {
		t.Fatalf("not normalised: %+v", in)
	}
	cases := []struct {
		name  string
		edit  func(*ITRequestInput)
		field string
	}{
		{"no items", func(i *ITRequestInput) { i.Items = nil }, "items"},
		{"duplicate kind", func(i *ITRequestInput) { i.Items = append(i.Items, ITRequestItem{Kind: "laptop", Quantity: 1}) }, "items"},
		{"too many", func(i *ITRequestInput) {
			i.Items = []ITRequestItem{{"laptop", 1, ""}, {"mouse", 1, ""}, {"cpu", 1, ""}, {"headphone", 1, ""}, {"other", 1, "x1"}, {"tablet", 1, ""}}
		}, "items"},
		{"unknown kind", func(i *ITRequestInput) { i.Items[0].Kind = "tablet" }, "items.0.kind"},
		{"zero qty", func(i *ITRequestInput) { i.Items[0].Quantity = 0 }, "items.0.quantity"},
		{"qty too big", func(i *ITRequestInput) { i.Items[0].Quantity = 11 }, "items.0.quantity"},
		{"other undescribed", func(i *ITRequestInput) { i.Items[1].Description = "  " }, "items.1.description"},
		{"description too long", func(i *ITRequestInput) { i.Items[0].Description = strings.Repeat("a", 121) }, "items.0.description"},
		{"short notes", func(i *ITRequestInput) { i.Notes = " hi " }, "notes"},
		{"long notes", func(i *ITRequestInput) { i.Notes = strings.Repeat("é", 1001) }, "notes"},
		{"bad priority", func(i *ITRequestInput) { i.Priority = "asap" }, "priority"},
	}
	for _, c := range cases {
		in := valid()
		c.edit(&in)
		if errs := in.Validate(); errs[c.field] == "" {
			t.Errorf("%s: want error on %q, got %v", c.name, c.field, errs)
		}
	}
	// 1000 multi-byte runes is fine (limits are in characters, not bytes).
	in = valid()
	in.Notes = strings.Repeat("é", 1000)
	if errs := in.Validate(); len(errs) != 0 {
		t.Errorf("1000-rune notes rejected: %v", errs)
	}
}

func TestRequestWorkflow(t *testing.T) {
	allowed := map[string]bool{"open>in_progress": true, "in_progress>open": true, "in_progress>resolved": true, "resolved>in_progress": true}
	for _, from := range RequestStatuses {
		for _, to := range RequestStatuses {
			if got := CanMoveRequest(from, to); got != allowed[from+">"+to] {
				t.Errorf("%s → %s = %v", from, to, got)
			}
		}
	}
	for s, closed := range map[string]bool{"open": false, "in_progress": false, "resolved": true, "cancelled": true, "rejected": true} {
		if RequestClosed(s) != closed {
			t.Errorf("RequestClosed(%s)", s)
		}
	}
}

func TestITIssueInputValidate(t *testing.T) {
	valid := func() ITRequestInput {
		return ITRequestInput{
			Type: " Issue ", Category: "Network", Title: "  No Wi-Fi on floor 3 ", Device: " LT-0423 ",
			Notes: "Nobody on floor 3 can connect since 9am.", Priority: "urgent",
		}
	}
	in := valid()
	if errs := in.Validate(); len(errs) != 0 {
		t.Fatalf("valid issue rejected: %v", errs)
	}
	if in.Type != "issue" || in.Category != "network" || in.Title != "No Wi-Fi on floor 3" || in.Device != "LT-0423" {
		t.Fatalf("issue not normalised: %+v", in)
	}
	cases := []struct {
		name  string
		edit  func(*ITRequestInput)
		field string
	}{
		{"unknown type", func(i *ITRequestInput) { i.Type = "incident" }, "type"},
		{"no category", func(i *ITRequestInput) { i.Category = "" }, "category"},
		{"bad category", func(i *ITRequestInput) { i.Category = "printer" }, "category"},
		{"short title", func(i *ITRequestInput) { i.Title = " ab " }, "title"},
		{"long title", func(i *ITRequestInput) { i.Title = strings.Repeat("a", 121) }, "title"},
		{"long device", func(i *ITRequestInput) { i.Device = strings.Repeat("d", 81) }, "device"},
		{"items on an issue", func(i *ITRequestInput) { i.Items = []ITRequestItem{{Kind: "laptop", Quantity: 1}} }, "items"},
		{"short description", func(i *ITRequestInput) { i.Notes = "bad" }, "notes"},
	}
	for _, c := range cases {
		in := valid()
		c.edit(&in)
		if errs := in.Validate(); errs[c.field] == "" {
			t.Errorf("%s: want error on %q, got %v", c.name, c.field, errs)
		}
	}
	// Equipment requests (the default type) drop issue-only fields.
	eq := ITRequestInput{Items: []ITRequestItem{{Kind: "mouse", Quantity: 1}}, Notes: "Mouse died", Category: "hardware", Title: "x", Device: "y"}
	if errs := eq.Validate(); len(errs) != 0 || eq.Type != "equipment" || eq.Category != "" || eq.Title != "" || eq.Device != "" {
		t.Errorf("equipment default: %v %+v", errs, eq)
	}
}

func TestITStaffInputValidate(t *testing.T) {
	name, title, order := "  Rita   Shrestha ", " Network  Engineer ", 3
	in := ITStaffInput{Name: &name, Title: &title, SortOrder: &order}
	if errs := in.Validate(true); len(errs) != 0 || *in.Name != "Rita Shrestha" || *in.Title != "Network Engineer" {
		t.Fatalf("valid staff: %v %+v", in.Validate(true), in)
	}
	if errs := (&ITStaffInput{}).Validate(true); errs["name"] == "" {
		t.Errorf("create without name accepted")
	}
	if errs := (&ITStaffInput{}).Validate(false); len(errs) != 0 {
		t.Errorf("empty patch rejected: %v", errs)
	}
	short, long, neg := "A", strings.Repeat("t", 81), -1
	if errs := (&ITStaffInput{Name: &short, Title: &long, SortOrder: &neg}).Validate(false); errs["name"] == "" || errs["title"] == "" || errs["sortOrder"] == "" {
		t.Errorf("bad staff input: %v", errs)
	}
}

func TestChatSides(t *testing.T) {
	me, other := "u1", "u2"
	cases := []struct {
		role      string
		requester *string
		want      string
	}{
		{"it", &me, ChatSideIT},
		{"team_lead", &other, ChatSideRequester},
		{"admin", &me, ChatSideRequester},
		{"admin", &other, ChatSideIT},
		{"admin", nil, ChatSideIT},
	}
	for _, c := range cases {
		if got := ChatSideFor(c.role, me, c.requester); got != c.want {
			t.Errorf("ChatSideFor(%s, requester=%v) = %s, want %s", c.role, c.requester, got, c.want)
		}
	}
	allowed := map[string][]string{"admin": {"requester", "it"}, "it": {"it"}, "team_lead": {"requester"}, "": {}}
	for role, sides := range allowed {
		for _, side := range []string{"requester", "it", "bogus"} {
			want := false
			for _, s := range sides {
				want = want || s == side
			}
			if got := CanPostAs(role, side); got != want {
				t.Errorf("CanPostAs(%q, %q) = %v, want %v", role, side, got, want)
			}
		}
	}
}

func TestNormalizeMessage(t *testing.T) {
	for in, want := range map[string]string{
		"  hi  ":                "hi",
		"a\r\nb\rc":             "a\nb\nc",
		"a\n\n\n\n\n\n\nb":      "a\n\n\nb",
		"नमस्ते, laptop चाहियो": "नमस्ते, laptop चाहियो",
	} {
		if got, ok := NormalizeMessage(in); !ok || got != want {
			t.Errorf("NormalizeMessage(%q) = %q %v, want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"", " \n\t ", strings.Repeat("é", MaxMessageBody+1)} {
		if _, ok := NormalizeMessage(in); ok {
			t.Errorf("NormalizeMessage accepted %d runes", len([]rune(in)))
		}
	}
	if _, ok := NormalizeMessage(strings.Repeat("é", MaxMessageBody)); !ok {
		t.Errorf("NormalizeMessage rejected exactly the limit")
	}
}
