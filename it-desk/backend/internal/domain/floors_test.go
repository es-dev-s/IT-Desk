package domain

import (
	"fmt"
	"testing"
)

func TestAutoNumber(t *testing.T) {
	els := []FloorElement{
		{ID: "a", Kind: KindSeat, X: 3, Y: 1}, {ID: "b", Kind: KindSeat, X: 1, Y: 1},
		{ID: "c", Kind: KindSeat, X: 1, Y: 4}, {ID: "d", Kind: KindSeat, X: 2, Y: 4, Code: "VIP-1", CodeLocked: true},
		{ID: "e", Kind: KindBlock, X: 1, Y: 2, W: 3, H: 2},
	}
	AutoNumber("L4-", els, true)
	got := map[string]string{}
	for _, e := range els {
		got[e.ID] = e.Code
	}
	want := map[string]string{"a": "2", "b": "1", "c": "3", "d": "VIP-1", "e": ""}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: got %q want %q", k, got[k], v)
		}
	}
}

func TestValidateLayout(t *testing.T) {
	team := "t1"
	els := []FloorElement{
		{ID: "s1", Kind: KindSeat, X: 0, Y: 0, W: 1, H: 1, Code: "A01", TeamID: &team},
		{ID: "s2", Kind: KindSeat, X: 1, Y: 0, W: 1, H: 1, Code: "A01"},
		{ID: "b1", Kind: KindBlock, X: 0, Y: 0, W: 2, H: 1},
		{ID: "r1", Kind: KindRoom, X: 2, Y: 1, W: 2, H: 1, Label: "Server"},
		{ID: "d1", Kind: KindDoor, X: 2, Y: 1, W: 1, H: 1},
		{ID: "l1", Kind: KindLabel, X: 0, Y: 0, W: 2, H: 1, Label: "Zone"},
		{ID: "x1", Kind: KindSeat, X: 9, Y: 0, W: 1, H: 1, Code: "Z9"},
	}
	errs := ValidateLayout(6, 3, els, func(id string) bool { return id == "t1" })
	for _, k := range []string{"s1", "s2", "b1", "x1"} {
		if errs[k] == "" {
			t.Errorf("expected problem for %s: %v", k, errs)
		}
	}
	for _, k := range []string{"r1", "d1", "l1"} {
		if errs[k] != "" {
			t.Errorf("unexpected problem for %s: %s", k, errs[k])
		}
	}
}

func TestFacingRowsTemplate(t *testing.T) {
	n := 0
	cols, rows, els := FacingRowsTemplate(17, func() string { n++; return fmt.Sprintf("e%d", n) })
	AutoNumber("L4-", els, true)
	if errs := ValidateLayout(cols, rows, els, nil); len(errs) != 0 {
		t.Fatalf("template invalid: %v", errs)
	}
	seats := 0
	for _, e := range els {
		if e.Kind == KindSeat {
			seats++
		}
	}
	if seats != 34 {
		t.Fatalf("want 34 seats, got %d", seats)
	}
}

func TestAutoNumberPlainSkipsTaken(t *testing.T) {
	els := []FloorElement{
		{ID: "a", Kind: KindSeat, X: 0, Y: 0}, {ID: "b", Kind: KindSeat, X: 1, Y: 0, Code: "1", CodeLocked: true},
		{ID: "c", Kind: KindSeat, X: 2, Y: 0}, {ID: "d", Kind: KindSeat, X: 0, Y: 2},
	}
	AutoNumber("", els, true)
	got := []string{els[0].Code, els[1].Code, els[2].Code, els[3].Code}
	if fmt.Sprint(got) != "[2 1 3 4]" {
		t.Fatalf("plain numbers: %v", got)
	}
}
