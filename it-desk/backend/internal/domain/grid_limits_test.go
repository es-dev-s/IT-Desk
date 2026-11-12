package domain

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
)

// TestGridLimitsInSync keeps the one set of grid limits identical in Go, the
// database CHECK constraints and the frontend's GRID constant.
func TestGridLimitsInSync(t *testing.T) {
	want := map[string]int{"minCols": MinCols, "maxCols": MaxCols, "minRows": MinRows, "maxRows": MaxRows}

	sql, err := os.ReadFile(filepath.Join("..", "..", "migrations", "0008_floor_grid_limits.sql"))
	if err != nil {
		t.Fatal(err)
	}
	for col, keys := range map[string][2]string{"cols": {"minCols", "maxCols"}, "rows": {"minRows", "maxRows"}} {
		m := regexp.MustCompile(`\(` + col + ` BETWEEN (\d+) AND (\d+)\)`).FindSubmatch(sql)
		if m == nil {
			t.Fatalf("migration has no CHECK for %s", col)
		}
		lo, _ := strconv.Atoi(string(m[1]))
		hi, _ := strconv.Atoi(string(m[2]))
		if lo != want[keys[0]] || hi != want[keys[1]] {
			t.Errorf("DB %s CHECK %d..%d, Go %d..%d", col, lo, hi, want[keys[0]], want[keys[1]])
		}
	}
	// Element sizes may span the whole grid.
	for col, max := range map[string]int{"w": MaxCols, "h": MaxRows} {
		m := regexp.MustCompile(`\(` + col + ` BETWEEN 1 AND (\d+)\)`).FindSubmatch(sql)
		if m == nil {
			t.Fatalf("migration has no CHECK for %s", col)
		}
		if n, _ := strconv.Atoi(string(m[1])); n != max {
			t.Errorf("DB %s CHECK max %d, want %d", col, n, max)
		}
	}

	ts, err := os.ReadFile(filepath.Join("..", "..", "..", "Frontend", "lib", "floors.ts"))
	if os.IsNotExist(err) {
		t.Skip("frontend not checked out next to the backend")
	} else if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)export const GRID = \{(.*?)\}`).FindSubmatch(ts)
	if block == nil {
		t.Fatal("Frontend/lib/floors.ts has no `export const GRID = {...}`")
	}
	for k, v := range want {
		m := regexp.MustCompile(k + `:\s*(\d+)`).FindSubmatch(block[1])
		if m == nil {
			t.Errorf("frontend GRID is missing %s", k)
			continue
		}
		if n, _ := strconv.Atoi(string(m[1])); n != v {
			t.Errorf("frontend GRID.%s = %d, Go has %d", k, n, v)
		}
	}
}

func TestGridLimitsValidate(t *testing.T) {
	ok := FloorInput{Name: ptrS("Big"), Cols: ptrI(200), Rows: ptrI(150)}
	if errs := ok.Validate(true); len(errs) != 0 {
		t.Fatalf("200x150 rejected: %v", errs)
	}
	for _, c := range []struct{ cols, rows int }{{1, 10}, {201, 10}, {10, 1}, {10, 201}} {
		in := FloorInput{Name: ptrS("Bad"), Cols: ptrI(c.cols), Rows: ptrI(c.rows)}
		if errs := in.Validate(true); len(errs) == 0 {
			t.Errorf("%dx%d accepted", c.cols, c.rows)
		}
	}
	// A seat in the far corner of a 200x200 grid is fine; one past it is not.
	els := []FloorElement{{ID: "a", Kind: KindSeat, X: 199, Y: 199, W: 1, H: 1, Code: "Z1"}}
	if errs := ValidateLayout(200, 200, els, func(string) bool { return true }); len(errs) != 0 {
		t.Errorf("corner seat flagged: %v", errs)
	}
	if errs := ValidateLayout(150, 150, els, func(string) bool { return true }); errs["a"] == "" {
		t.Errorf("seat outside a shrunk grid not flagged: %v", errs)
	}
}

func ptrS(s string) *string { return &s }
func ptrI(i int) *int       { return &i }
