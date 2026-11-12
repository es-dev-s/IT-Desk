package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"itdesk/backend/internal/domain"
)

// Every committed floor file must be a valid layout whose zones name one of
// the seeded teams, with unique seat numbers 1..N in reading order.
func TestFloorFilesAreValid(t *testing.T) {
	raw, err := os.ReadFile("../../internal/seed/data/workspace.json")
	if err != nil {
		t.Fatal(err)
	}
	var ws struct {
		Teams []struct {
			Name string `json:"name"`
		} `json:"teams"`
	}
	if err := json.Unmarshal(raw, &ws); err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, tm := range ws.Teams {
		known[strings.ToLower(tm.Name)] = true
	}
	if len(known) != 24 {
		t.Fatalf("expected 24 seeded teams, got %d", len(known))
	}
	files, _ := filepath.Glob("../../floors/*.json")
	if len(files) != 7 {
		t.Fatalf("expected 7 floor files, got %d", len(files))
	}
	names := map[string]bool{}
	for _, path := range files {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var ff floorFile
		if err := json.Unmarshal(b, &ff); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if names[ff.Name] {
			t.Errorf("%s: duplicate floor name %q", path, ff.Name)
		}
		names[ff.Name] = true
		els := make([]domain.FloorElement, 0, len(ff.Elements))
		var seats []domain.FloorElement
		for _, fe := range ff.Elements {
			e := fe.FloorElement
			if fe.Team != "" {
				if !known[strings.ToLower(fe.Team)] {
					t.Errorf("%s: %s names unknown team %q", path, e.Code, fe.Team)
				}
				id := fe.Team
				e.TeamID = &id
			}
			if e.Kind == domain.KindSeat {
				seats = append(seats, e)
			}
			els = append(els, e)
		}
		// Seats carry plain numbers, 1..N in reading order (top row first, left to right).
		sort.SliceStable(seats, func(a, b int) bool {
			if seats[a].Y != seats[b].Y {
				return seats[a].Y < seats[b].Y
			}
			return seats[a].X < seats[b].X
		})
		for i, e := range seats {
			if e.Code != strconv.Itoa(i+1) {
				t.Errorf("%s: seat at %d,%d is %q, want %d", path, e.X, e.Y, e.Code, i+1)
				break
			}
		}
		domain.NormalizeElements(els)
		if errs := domain.ValidateLayout(ff.Cols, ff.Rows, els, nil); len(errs) > 0 {
			t.Errorf("%s: %v", path, errs)
		}
	}
}

// Tabs show floors by sortOrder (highest first). Every file needs its own
// sortOrder, falling in file order, so floors on the same level never fall
// back to alphabetical order (which would put Level 2 (A) before Level 2 (B)).
func TestFloorFilesTabOrder(t *testing.T) {
	want := []string{"Level 4", "3rd Floor – West Side", "Level 3 (A)", "Level 2 (B)", "Level 2 (A)", "Level 1 (B)", "Level 1 (A)"}
	files, _ := filepath.Glob("../../floors/*.json")
	prev := int(^uint(0) >> 1)
	for i, path := range files {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var ff floorFile
		if err := json.Unmarshal(b, &ff); err != nil {
			t.Fatal(err)
		}
		if i < len(want) && ff.Name != want[i] {
			t.Errorf("tab %d: got %q, want %q", i+1, ff.Name, want[i])
		}
		if ff.SortOrder >= prev {
			t.Errorf("%s: sortOrder %d must be lower than the previous file's %d", path, ff.SortOrder, prev)
		}
		prev = ff.SortOrder
	}
}
