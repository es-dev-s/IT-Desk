// Package seed loads the demo workspace (teams, people, kit, transfer history,
// exits) into PostgreSQL. The dataset lives in data/workspace.json and is
// anchored to a fixed reference time; every timestamp is shifted so the data
// is "fresh" relative to the moment you seed (KPIs like "moves this week"
// stay meaningful).
package seed

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed data/workspace.json
var workspaceJSON []byte

// ReferenceNow is the instant the dataset was authored against.
var ReferenceNow = time.Date(2026, 10, 23, 4, 30, 0, 0, time.UTC)

const DefaultLeadID = "lead_pawan"

type device struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Model    string `json:"model"`
	AssetTag string `json:"assetTag"`
}

type member struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Email    string   `json:"email"`
	Role     string   `json:"role"`
	SubGroup string   `json:"subGroup"`
	Seat     *string  `json:"seat"`
	TeamID   string   `json:"teamId"`
	Status   string   `json:"status"`
	JoinedAt string   `json:"joinedAt"`
	Hue      int      `json:"hue"`
	Devices  []device `json:"devices"`
}

type move struct {
	MemberID   string   `json:"memberId"`
	MemberName string   `json:"memberName"`
	FromSeat   *string  `json:"fromSeat"`
	ToSeat     *string  `json:"toSeat"`
	Devices    []device `json:"devices"`
}

type transfer struct {
	ID            string `json:"id"`
	Ticket        string `json:"ticket"`
	Direction     string `json:"direction"`
	FromTeamID    string `json:"fromTeamId"`
	ToTeamID      string `json:"toTeamId"`
	Moves         []move `json:"moves"`
	EffectiveDate string `json:"effectiveDate"`
	CreatedAt     string `json:"createdAt"`
	InitiatedBy   string `json:"initiatedBy"`
	Note          string `json:"note"`
	ItStatus      string `json:"itStatus"`
	History       []struct {
		Status string `json:"status"`
		At     string `json:"at"`
	} `json:"history"`
}

type exit struct {
	ID            string  `json:"id"`
	MemberID      string  `json:"memberId"`
	MemberName    string  `json:"memberName"`
	Status        string  `json:"status"`
	Seat          *string `json:"seat"`
	EffectiveDate string  `json:"effectiveDate"`
	CreatedAt     string  `json:"createdAt"`
	InitiatedBy   string  `json:"initiatedBy"`
	Reason        string  `json:"reason"`
}

type Dataset struct {
	CurrentTeamID string `json:"currentTeamId"`
	Lead          struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
		Title string `json:"title"`
	} `json:"lead"`
	Teams []struct {
		ID       string `json:"id"`
		Slug     string `json:"slug"`
		Name     string `json:"name"`
		Code     string `json:"code"`
		LeadName string `json:"leadName"`
		Location string `json:"location"`
	} `json:"teams"`
	Members   []member   `json:"members"`
	Transfers []transfer `json:"transfers"`
	Exits     []exit     `json:"exits"`
	// ReservedSeats is legacy demo data (40-seat banks); ignored since floor plans.
	ReservedSeats map[string][]string `json:"reservedSeats"`
}

func Load() (Dataset, error) {
	var d Dataset
	if err := json.Unmarshal(workspaceJSON, &d); err != nil {
		return d, fmt.Errorf("parse seed data: %w", err)
	}
	if d.CurrentTeamID == "" || len(d.Teams) == 0 || len(d.Members) == 0 {
		return d, errors.New("seed data is incomplete")
	}
	return d, nil
}

type Summary struct {
	Teams, Members, Devices, Transfers, Exits int
	// LegacyTeams counts teams in the database that are not in the catalogue
	// (left over from an older demo dataset; --reset removes them).
	LegacyTeams int
	Skipped     bool
	NextTicket  string
	Shift       time.Duration
}

type shifter struct {
	d    time.Duration
	days int
}

func newShifter(now time.Time) shifter {
	d := now.Sub(ReferenceNow)
	return shifter{d: d, days: int(math.Round(d.Hours() / 24))}
}

func (s shifter) ts(v string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return t, fmt.Errorf("bad timestamp %q: %w", v, err)
	}
	return t.Add(s.d).UTC(), nil
}

func (s shifter) date(v string) (time.Time, error) {
	t, err := time.Parse("2006-01-02", v)
	if err != nil {
		return t, fmt.Errorf("bad date %q: %w", v, err)
	}
	return t.AddDate(0, 0, s.days), nil
}

// Run upserts the team catalogue and, on an empty workspace, loads the demo
// people, kit, transfers and exits. It is idempotent: teams are upserted by id
// every time (names, codes, slugs and floors follow the catalogue; lead names
// are left to the accounts), and the rest is skipped once members exist (use
// --reset to start over). Sign-in accounts are handled by SeedUsers.
func Run(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, now time.Time) (Summary, error) {
	var sum Summary
	data, err := Load()
	if err != nil {
		return sum, err
	}
	leadID := data.Lead.ID
	if leadID == "" {
		leadID = DefaultLeadID
	}
	sh := newShifter(now)
	sum.Shift = sh.d

	err = pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.Serializable}, func(tx pgx.Tx) error {
		n, legacy, err := upsertTeams(ctx, tx, data)
		if err != nil {
			return err
		}
		sum.Teams, sum.LegacyTeams = n, legacy
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM members)`).Scan(&exists); err != nil {
			return err
		}
		if exists {
			sum.Skipped = true
			return nil
		}
		_ = leadID // accounts are created by SeedUsers

		members := map[string]bool{}
		for _, m := range data.Members {
			joined, err := sh.date(m.JoinedAt)
			if err != nil {
				return err
			}
			// Demo people start without a seat: seats live on floor plans,
			// which an admin builds (or cmd/floors-import loads).
			if _, err := tx.Exec(ctx, `INSERT INTO members (id, name, email, role, sub_group, team_id, status, joined_at, hue)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				m.ID, m.Name, m.Email, m.Role, m.SubGroup, m.TeamID, m.Status, joined, m.Hue); err != nil {
				return fmt.Errorf("member %s: %w", m.ID, err)
			}
			members[m.ID] = true
			for i, d := range m.Devices {
				if _, err := tx.Exec(ctx, `INSERT INTO devices (id, member_id, kind, model, asset_tag, position) VALUES ($1,$2,$3,$4,$5,$6)`,
					d.ID, m.ID, d.Kind, d.Model, d.AssetTag, i); err != nil {
					return fmt.Errorf("device %s: %w", d.ID, err)
				}
				sum.Devices++
			}
		}
		sum.Members = len(data.Members)

		maxTicket := 0
		for _, t := range data.Transfers {
			created, err := sh.ts(t.CreatedAt)
			if err != nil {
				return err
			}
			eff, err := sh.date(t.EffectiveDate)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO transfers (id, ticket, direction, from_team_id, to_team_id, effective_date,
				created_at, initiated_by, note, it_status, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$7)`,
				t.ID, t.Ticket, t.Direction, t.FromTeamID, t.ToTeamID, eff, created, t.InitiatedBy, t.Note, t.ItStatus); err != nil {
				return fmt.Errorf("transfer %s: %w", t.ID, err)
			}
			var n int
			if _, err := fmt.Sscanf(t.Ticket, "IT-%d", &n); err == nil && n > maxTicket {
				maxTicket = n
			}
			for i, mv := range t.Moves {
				if !members[mv.MemberID] {
					return fmt.Errorf("transfer %s references unknown member %s", t.ID, mv.MemberID)
				}
				if _, err := tx.Exec(ctx, `INSERT INTO transfer_moves (transfer_id, member_id, position, member_name, from_team_id,
					from_seat, to_seat) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
					t.ID, mv.MemberID, i, mv.MemberName, t.FromTeamID, mv.FromSeat, mv.ToSeat); err != nil {
					return fmt.Errorf("move %s/%s: %w", t.ID, mv.MemberID, err)
				}
				for j, d := range mv.Devices {
					if _, err := tx.Exec(ctx, `INSERT INTO transfer_move_devices (transfer_id, member_id, device_id, kind, model,
						asset_tag, position) VALUES ($1,$2,$3,$4,$5,$6,$7)`, t.ID, mv.MemberID, d.ID, d.Kind, d.Model, d.AssetTag, j); err != nil {
						return fmt.Errorf("move device %s/%s: %w", t.ID, d.ID, err)
					}
				}
			}
			for _, h := range t.History {
				at, err := sh.ts(h.At)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO transfer_history (transfer_id, status, at) VALUES ($1,$2,$3)
					ON CONFLICT DO NOTHING`, t.ID, h.Status, at); err != nil {
					return fmt.Errorf("history %s: %w", t.ID, err)
				}
			}
		}
		sum.Transfers = len(data.Transfers)

		for _, e := range data.Exits {
			created, err := sh.ts(e.CreatedAt)
			if err != nil {
				return err
			}
			eff, err := sh.date(e.EffectiveDate)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO exits (id, batch_id, member_id, member_name, status, seat, prev_status,
				effective_date, created_at, initiated_by, reason) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10)`,
				e.ID, "seed_"+e.ID, e.MemberID, e.MemberName, e.Status, e.Seat, eff, created, e.InitiatedBy, e.Reason); err != nil {
				return fmt.Errorf("exit %s: %w", e.ID, err)
			}
		}
		sum.Exits = len(data.Exits)

		// Next ticket continues the demo numbering (highest seeded + 7).
		if maxTicket > 0 {
			if _, err := tx.Exec(ctx, `SELECT setval('ticket_seq', $1)`, maxTicket+6); err != nil {
				return err
			}
		}
		var next int64
		if err := tx.QueryRow(ctx, `SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM ticket_seq`).Scan(&next); err != nil {
			return err
		}
		sum.NextTicket = fmt.Sprintf("IT-%04d", next)

		_, err = tx.Exec(ctx, `INSERT INTO audit_log (actor, action, entity, entity_id, data) VALUES ('seed', 'seed.loaded', 'workspace', $1, $2)`,
			data.CurrentTeamID, map[string]any{"members": sum.Members, "transfers": sum.Transfers, "exits": sum.Exits})
		return err
	})
	if err != nil {
		return sum, err
	}
	if sum.LegacyTeams > 0 {
		log.Warn("teams outside the catalogue are still in the database; run the seed with --reset to remove them", "count", sum.LegacyTeams)
	}
	if !sum.Skipped {
		log.Info("seeded workspace", "teams", sum.Teams, "members", sum.Members, "devices", sum.Devices,
			"transfers", sum.Transfers, "exits", sum.Exits,
			"next_ticket", sum.NextTicket, "time_shift", strings.TrimSuffix(sum.Shift.Round(time.Minute).String(), "0s"))
	}
	return sum, nil
}

// upsertTeams writes the team catalogue (insert or update by id) and reports
// how many teams in the database are not part of it.
func upsertTeams(ctx context.Context, tx pgx.Tx, data Dataset) (n, legacy int, err error) {
	ids := make([]string, 0, len(data.Teams))
	for i, t := range data.Teams {
		if _, err := tx.Exec(ctx, `INSERT INTO teams (id, slug, name, code, lead_name, location, sort_order)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, code = EXCLUDED.code,
				location = EXCLUDED.location, sort_order = EXCLUDED.sort_order`,
			t.ID, t.Slug, t.Name, t.Code, t.LeadName, t.Location, i); err != nil {
			return 0, 0, fmt.Errorf("team %s: %w", t.ID, err)
		}
		ids = append(ids, t.ID)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM teams WHERE NOT (id = ANY($1))`, ids).Scan(&legacy); err != nil {
		return 0, 0, err
	}
	return len(ids), legacy, nil
}
