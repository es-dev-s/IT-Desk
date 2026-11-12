// Command floors-import creates or updates the published floor plans in
// backend/floors/*.json (transcribed from the office seating sheets).
//
//	go run ./cmd/floors-import                 # import every floors/*.json
//	go run ./cmd/floors-import --dry-run       # show what would change
//	go run ./cmd/floors-import --on-conflict relocate
//
// It is idempotent: floors are matched by name; a floor whose published
// layout already equals the file is left alone. Seat zones name teams by
// their display name and are resolved to ids here. It writes as the first
// active admin account (audit entries name that admin) and never prints
// secrets. People in the files are reference only: no member records are
// created (see .run/floor-people-import.csv).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"itdesk/backend/internal/config"
	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/store"
)

type fileElement struct {
	domain.FloorElement
	Team string `json:"team,omitempty"`
}

type floorFile struct {
	Name       string        `json:"name"`
	Level      int           `json:"level"`
	SortOrder  int           `json:"sortOrder"`
	SeatPrefix string        `json:"seatPrefix"`
	Cols       int           `json:"cols"`
	Rows       int           `json:"rows"`
	Notes      string        `json:"notes"`
	Elements   []fileElement `json:"elements"`
}

func main() {
	dir := flag.String("dir", "floors", "directory with the floor JSON files")
	dry := flag.Bool("dry-run", false, "report what would change without writing")
	onConflict := flag.String("on-conflict", "", `when a re-import removes or re-zones occupied seats: "" refuse, relocate, unseat or keep`)
	flag.Parse()
	if err := run(*dir, *dry, *onConflict); err != nil {
		fmt.Fprintln(os.Stderr, "floors-import:", err)
		os.Exit(1)
	}
}

func run(dir string, dry bool, onConflict string) error {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no floor files in %s", dir)
	}
	sort.Strings(files)
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := config.NewLogger(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	database, err := db.New(cfg, log)
	if err != nil {
		return err
	}
	if err := database.Connect(ctx, 6); err != nil {
		return err
	}
	defer database.Close()
	// Same as the API and seed: bring the schema up to date (no-op when current).
	if err := db.Migrate(ctx, database.Pool, cfg.DBSchema, log); err != nil {
		return err
	}
	database.MarkReady()
	st := store.New(database, log, cfg.UndoWindow)

	var admin domain.User
	err = database.Pool.QueryRow(ctx, `SELECT id, name, email, role FROM users
		WHERE role = 'admin' AND status = 'active' ORDER BY created_at, id LIMIT 1`).
		Scan(&admin.ID, &admin.Name, &admin.Email, &admin.Role)
	if err != nil {
		return fmt.Errorf("no active admin account: %w", err)
	}
	actor := store.Actor{User: admin, RequestID: "floors-import"}

	teams, err := st.Teams(ctx)
	if err != nil {
		return err
	}
	teamID := map[string]string{}
	for _, t := range teams {
		teamID[strings.ToLower(t.Name)] = t.ID
	}
	existing, err := st.Floors(ctx, actor)
	if err != nil {
		return err
	}
	byName := map[string]domain.FloorSummary{}
	for _, f := range existing {
		byName[f.Name] = f
	}

	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var ff floorFile
		if err := json.Unmarshal(raw, &ff); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		els := make([]domain.FloorElement, 0, len(ff.Elements))
		for _, fe := range ff.Elements {
			e := fe.FloorElement
			e.TeamID = nil
			if fe.Team != "" {
				id, ok := teamID[strings.ToLower(fe.Team)]
				if !ok {
					return fmt.Errorf("%s: unknown team %q on %s", path, fe.Team, e.Code)
				}
				e.TeamID = &id
			}
			els = append(els, e)
		}
		domain.NormalizeElements(els)
		seats := 0
		for _, e := range els {
			if e.Kind == domain.KindSeat {
				seats++
			}
		}
		cur, found := byName[ff.Name]
		if !found {
			if dry {
				fmt.Printf("create   %-24s %d seats\n", ff.Name, seats)
				continue
			}
			in := domain.FloorInput{Name: &ff.Name, Level: &ff.Level, SortOrder: &ff.SortOrder, SeatPrefix: &ff.SeatPrefix,
				Cols: &ff.Cols, Rows: &ff.Rows, Notes: &ff.Notes, Elements: els, Publish: true}
			out, err := st.CreateFloor(ctx, actor, in)
			if err != nil {
				return fmt.Errorf("%s: %s", ff.Name, describe(err))
			}
			fmt.Printf("created  %-24s %d seats (v%d %s)\n", out.Name, out.Stats.Seats, out.Version, out.Status)
			continue
		}
		pub, err := st.Floor(ctx, actor, cur.ID)
		if err != nil {
			return err
		}
		metaSame := cur.Level == ff.Level && cur.SortOrder == ff.SortOrder && cur.Notes == ff.Notes
		layoutSame := pub.Status == "published" && pub.Cols == ff.Cols && pub.Rows == ff.Rows &&
			pub.SeatPrefix == ff.SeatPrefix && sameElements(pub.Elements, els)
		if metaSame && layoutSame {
			fmt.Printf("same     %-24s %d seats (v%d)\n", ff.Name, pub.Stats.Seats, pub.Version)
			continue
		}
		if dry {
			fmt.Printf("update   %-24s meta changed=%v layout changed=%v\n", ff.Name, !metaSame, !layoutSame)
			continue
		}
		if !metaSame {
			if _, err := st.UpdateFloor(ctx, actor, cur.ID, domain.FloorInput{Level: &ff.Level, SortOrder: &ff.SortOrder, Notes: &ff.Notes}); err != nil {
				return fmt.Errorf("%s: %s", ff.Name, describe(err))
			}
		}
		if !layoutSame {
			d, err := st.Draft(ctx, actor, cur.ID)
			if err != nil {
				return err
			}
			v := d.DraftVersion
			d2, err := st.SaveDraft(ctx, actor, cur.ID, domain.DraftInput{Cols: &ff.Cols, Rows: &ff.Rows, SeatPrefix: &ff.SeatPrefix,
				Elements: els, ExpectedDraftVersion: &v}, false)
			if err != nil {
				return fmt.Errorf("%s: %s", ff.Name, describe(err))
			}
			v = d2.DraftVersion
			res, err := st.PublishFloor(ctx, actor, cur.ID, domain.PublishInput{ExpectedDraftVersion: &v, OnConflict: onConflict})
			if err != nil {
				return fmt.Errorf("%s: %s (re-run with --on-conflict relocate|unseat|keep)", ff.Name, describe(err))
			}
			fmt.Printf("updated  %-24s +%d -%d ~%d elements, %d people affected\n", ff.Name, res.Added, res.Removed, res.Changed, len(res.Affected))
		} else {
			fmt.Printf("updated  %-24s meta only\n", ff.Name)
		}
	}
	return nil
}

// sameElements compares layouts ignoring order.
func sameElements(a, b []domain.FloorElement) bool {
	if len(a) != len(b) {
		return false
	}
	norm := func(in []domain.FloorElement) map[string]domain.FloorElement {
		m := make(map[string]domain.FloorElement, len(in))
		for _, e := range in {
			if e.TeamID != nil && *e.TeamID == "" {
				e.TeamID = nil
			}
			e.CodeLocked = false
			m[e.ID] = e
		}
		return m
	}
	return reflect.DeepEqual(norm(a), norm(b))
}

func describe(err error) string {
	var ae *domain.Error
	if errors.As(err, &ae) {
		b, _ := json.Marshal(ae)
		return string(b)
	}
	return err.Error()
}
