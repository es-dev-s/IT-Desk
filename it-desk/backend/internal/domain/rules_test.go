package domain

import (
	"testing"
	"time"
)

var now = time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)

func TestNextItStatus(t *testing.T) {
	cases := map[string]string{"requested": "scheduled", "scheduled": "moved", "moved": "completed", "completed": "", "bogus": ""}
	for in, want := range cases {
		if got := NextItStatus(in); got != want {
			t.Errorf("NextItStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEffectiveDateWindow(t *testing.T) {
	for _, tc := range []struct {
		in string
		ok bool
	}{
		{"2026-10-23", true}, {"2026-09-23", true}, {"2026-09-22", false},
		{"2027-01-21", true}, {"2027-01-22", false}, {"23/10/2026", false}, {"", false},
	} {
		_, msg := ValidEffectiveDate(tc.in, now)
		if (msg == "") != tc.ok {
			t.Errorf("%q: ok=%v msg=%q", tc.in, tc.ok, msg)
		}
	}
}

func TestTransferValidate(t *testing.T) {
	in := TransferInput{Mode: "internal", EffectiveDate: "2026-10-24", Assignments: []Assignment{
		{MemberID: "a", ToSeatID: " s_b4 "}, {MemberID: "b", ToSeatID: "s_b4"}, {MemberID: "a", ToSeatID: "bad seat!"},
	}}
	errs := in.Validate(now)
	if in.Assignments[0].ToSeatID != "s_b4" {
		t.Errorf("seat not normalised: %q", in.Assignments[0].ToSeatID)
	}
	for _, k := range []string{"assignments.1.toSeat", "assignments.2.toSeat", "assignments"} {
		if errs[k] == "" {
			t.Errorf("expected error for %s, got %v", k, errs)
		}
	}
	ok := TransferInput{Mode: "team", ToTeamID: "t2", EffectiveDate: "2026-10-24", Assignments: []Assignment{{MemberID: "a", ToSeatID: "s_a1"}}}
	if errs := ok.Validate(now); len(errs) != 0 {
		t.Errorf("valid input rejected: %v", errs)
	}
	bad := TransferInput{Mode: "team", EffectiveDate: "2026-10-24", Assignments: []Assignment{{MemberID: "a", ToSeatID: "s_a1"}}}
	if bad.Validate(now)["toTeamId"] == "" {
		t.Error("team transfer without destination accepted")
	}
}

func TestExitValidate(t *testing.T) {
	in := ExitInput{MemberIDs: []string{"a", "a", " ", "b"}, Status: "resigned", Reason: "  Left  ", EffectiveDate: "2026-10-23"}
	if errs := in.Validate(now); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if len(in.MemberIDs) != 2 || in.Reason != "Left" {
		t.Errorf("not normalised: %v %q", in.MemberIDs, in.Reason)
	}
	bad := ExitInput{Status: "fired", Reason: "x", EffectiveDate: "nope"}
	errs := bad.Validate(now)
	for _, k := range []string{"status", "reason", "effectiveDate", "memberIds"} {
		if errs[k] == "" {
			t.Errorf("missing error %s", k)
		}
	}
}

func TestProfileAndSettings(t *testing.T) {
	p := ProfileInput{Name: "Pawan Ojha", Email: "pawan@example.com", Title: "Lead"}
	if errs := p.Validate(); len(errs) != 0 {
		t.Errorf("valid profile rejected: %v", errs)
	}
	p.Email = "Pawan <pawan@example.com>"
	if p.Validate()["email"] == "" {
		t.Error("display-name email accepted")
	}
	if ValidateSettings(Settings{Notifications: map[string]bool{"digest": true}}) != nil {
		t.Error("known setting rejected")
	}
	if ValidateSettings(Settings{Notifications: map[string]bool{"sms": true}}) == nil {
		t.Error("unknown setting accepted")
	}
}

func TestTimeJSON(t *testing.T) {
	b, _ := NewTime(time.Date(2026, 1, 2, 3, 4, 5, 6e6, time.FixedZone("x", 3600))).MarshalJSON()
	if string(b) != `"2026-01-02T02:04:05.006Z"` {
		t.Errorf("got %s", b)
	}
}
