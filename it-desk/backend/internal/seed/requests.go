package seed

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type seedItem struct {
	kind        string
	qty         int
	description string
}

type seedComment struct {
	by   string // user id
	at   time.Duration
	body string
}

type seedRequest struct {
	requester string // user id
	team      string // "" = org-wide (admin)
	member    string
	items     []seedItem
	notes     string
	priority  string
	status    string
	assignee  string
	age       time.Duration // how long ago it was raised
	started   time.Duration // after creation
	closed    time.Duration // after creation
	outcome   string        // resolution note / rejection or cancellation reason
	comments  []seedComment
}

var demoRequests = []seedRequest{
	{requester: "lead_pawan", team: "elite-closers", member: "mem_025", items: []seedItem{{"laptop", 1, "MacBook Pro 14\" (M-series), 32 GB"}, {"headphone", 1, ""}, {"mouse", 1, ""}},
		notes:    "Zara joins the platform team on Monday as a backend engineer. Needs a dev-spec laptop and the standard peripherals ready at her desk.",
		priority: "high", status: "in_progress", assignee: "usr_it_bikash", age: 26 * time.Hour, started: 3 * time.Hour,
		comments: []seedComment{{"usr_it_bikash", 3*time.Hour + 5*time.Minute, "Laptop allocated from stock (asset LT-2291). Imaging now, will drop it off tomorrow morning."},
			{"lead_pawan", 4 * time.Hour, "Thanks! Desk is P-14, next to Olivia."}}},
	{requester: "lead_pawan", team: "elite-closers", member: "mem_012", items: []seedItem{{"headphone", 1, "Noise-cancelling, for on-call"}},
		notes:    "Ishaan's headset mic stopped working; he is on call this week and needs a replacement urgently.",
		priority: "urgent", status: "open", age: 50 * time.Minute},
	{requester: "lead_pawan", team: "elite-closers", items: []seedItem{{"other", 2, "27\" 4K monitors"}},
		notes:    "Two extra monitors for the pairing station near the window. Any 27\" 4K with USB-C is fine.",
		priority: "normal", status: "open", age: 5 * time.Hour},
	{requester: "lead_pawan", team: "elite-closers", member: "mem_003", items: []seedItem{{"mouse", 1, "Ergonomic vertical mouse"}},
		notes:    "Caleb has been getting wrist pain; occupational health recommended a vertical mouse.",
		priority: "normal", status: "resolved", assignee: "usr_it_grace", age: 4 * 24 * time.Hour, started: 2 * time.Hour, closed: 20 * time.Hour,
		outcome: "Logitech Lift delivered to desk P-03 and paired."},
	{requester: "lead_pawan", team: "elite-closers", items: []seedItem{{"cpu", 1, "Build server for CI runners"}},
		notes:    "Requesting a spare tower to run self-hosted CI runners for the monorepo.",
		priority: "low", status: "rejected", assignee: "usr_it_grace", age: 6 * 24 * time.Hour, closed: 26 * time.Hour,
		outcome: "CI capacity is provided centrally — please raise this with Cloud Infrastructure instead of using desk hardware."},
	{requester: "lead_pawan", team: "elite-closers", member: "mem_016", items: []seedItem{{"laptop", 1, "Loaner while hers is repaired"}},
		notes:    "Riya's laptop is going in for a keyboard repair, she needs a loaner for a few days.",
		priority: "normal", status: "cancelled", age: 3 * 24 * time.Hour, closed: 40 * time.Minute,
		outcome: "Repair was done same-day, loaner no longer needed."},
	{requester: "lead_trend-setters", team: "trend-setters", member: "mem_036", items: []seedItem{{"other", 3, "Test devices: Pixel 9, iPhone 16, Galaxy S25"}},
		notes:    "Maya needs current-generation test devices for the release regression pass next sprint.",
		priority: "high", status: "open", age: 9 * time.Hour,
		comments: []seedComment{{"usr_it_grace", 2 * time.Hour, "We have the Pixel and iPhone in stock; checking lead time on the Galaxy."}}},
	{requester: "lead_trend-setters", team: "trend-setters", member: "mem_043", items: []seedItem{{"laptop", 1, ""}, {"mouse", 1, ""}},
		notes:    "Wen's laptop battery is swelling — please swap it out as soon as possible.",
		priority: "urgent", status: "in_progress", assignee: "usr_it_grace", age: 7 * time.Hour, started: 30 * time.Minute},
	{requester: "lead_compliance-crew", team: "compliance-crew", member: "mem_041", items: []seedItem{{"other", 1, "YubiKey 5C NFC"}},
		notes:    "Hardware security key for Liam ahead of the production access review.",
		priority: "normal", status: "resolved", assignee: "usr_it_bikash", age: 2 * 24 * time.Hour, started: time.Hour, closed: 5 * time.Hour,
		outcome: "Key issued and enrolled. Liam signed the asset form."},
	{requester: "lead_success-sharks", team: "success-sharks", member: "mem_042", items: []seedItem{{"headphone", 2, "USB headsets for calls"}},
		notes:    "Isha and the new support hire need headsets for customer calls.",
		priority: "normal", status: "open", age: 30 * time.Hour},
	{requester: "lead_kpi-krushers", team: "kpi-krushers", member: "mem_038", items: []seedItem{{"cpu", 1, "GPU workstation"}, {"other", 1, "64 GB RAM upgrade"}},
		notes:    "Zoe is training models locally and the current machine runs out of memory. Workstation or a RAM upgrade, whichever is faster.",
		priority: "high", status: "in_progress", assignee: "usr_it_bikash", age: 3 * 24 * time.Hour, started: 26 * time.Hour,
		comments: []seedComment{{"usr_it_bikash", 27 * time.Hour, "RAM upgrade ordered, ETA two days. Workstation request is with procurement."}}},
	{requester: "usr_admin", items: []seedItem{{"other", 10, "Conference-room HDMI/USB-C adapters"}},
		notes:    "Restock adapters for all meeting rooms on floors 1–3; several have gone missing.",
		priority: "low", status: "open", age: 2 * 24 * time.Hour},
}

// SeedRequests loads demo IT requests in a mix of states. It is idempotent
// (skips if any request exists) and skips entries whose accounts or members
// are missing.
func SeedRequests(ctx context.Context, pool *pgxpool.Pool, now time.Time) (int, error) {
	n := 0
	err := pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.Serializable}, func(tx pgx.Tx) error {
		n = 0
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM it_requests)`).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
		type acct struct{ name, role string }
		users := map[string]acct{}
		rows, err := tx.Query(ctx, `SELECT id, name, role FROM users`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			var a acct
			if err := rows.Scan(&id, &a.name, &a.role); err != nil {
				rows.Close()
				return err
			}
			users[id] = a
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for i, r := range demoRequests {
			req, ok := users[r.requester]
			if !ok {
				continue
			}
			var team, member, memberName any
			if r.team != "" {
				team = r.team
			}
			if r.member != "" {
				var name string
				if err := tx.QueryRow(ctx, `SELECT name FROM members WHERE id=$1 AND team_id=$2`, r.member, r.team).Scan(&name); err != nil {
					if err == pgx.ErrNoRows {
						continue
					}
					return err
				}
				member, memberName = r.member, name
			}
			var assignee, assigneeName any
			if a, ok := users[r.assignee]; ok {
				assignee, assigneeName = r.assignee, a.name
			}
			created := now.Add(-r.age).UTC()
			var started, closed any
			if r.started > 0 {
				started = created.Add(r.started)
			}
			if r.closed > 0 {
				closed = created.Add(r.closed)
			}
			var seq int64
			if err := tx.QueryRow(ctx, `SELECT nextval('request_seq')`).Scan(&seq); err != nil {
				return err
			}
			id := fmt.Sprintf("req_seed%02d", i+1)
			updated := created
			for _, t := range []any{started, closed} {
				if v, ok := t.(time.Time); ok && v.After(updated) {
					updated = v
				}
			}
			for _, c := range r.comments {
				if v := created.Add(c.at); v.After(updated) {
					updated = v
				}
			}
			version := 0
			if _, err := tx.Exec(ctx, `INSERT INTO it_requests (id, ticket, requester_id, requester_name, requester_role, team_id,
				for_member_id, for_member_name, notes, priority, status, assignee_id, assignee_name, resolution, created_at, updated_at,
				started_at, closed_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
				id, fmt.Sprintf("REQ-%04d", seq), r.requester, req.name, req.role, team, member, memberName, r.notes, r.priority, r.status,
				assignee, assigneeName, r.outcome, created, updated, started, closed, version); err != nil {
				return fmt.Errorf("request %s: %w", id, err)
			}
			for j, it := range r.items {
				if _, err := tx.Exec(ctx, `INSERT INTO it_request_items (request_id, kind, quantity, description, position) VALUES ($1,$2,$3,$4,$5)`,
					id, it.kind, it.qty, it.description, j); err != nil {
					return fmt.Errorf("request %s item: %w", id, err)
				}
			}
			ev := func(kind, actor, body string, from, to any, at time.Time) error {
				a := users[actor]
				_, err := tx.Exec(ctx, `INSERT INTO it_request_events (request_id, kind, actor_id, actor_name, actor_role, body, from_status, to_status, at)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, kind, actor, a.name, a.role, body, from, to, at)
				return err
			}
			if err := ev("created", r.requester, "", nil, "open", created); err != nil {
				return err
			}
			if assignee != nil {
				at := created.Add(r.started - 5*time.Minute)
				if r.started == 0 {
					at = created.Add(r.closed / 2)
				}
				if err := ev("assigned", r.assignee, "Claimed by "+users[r.assignee].name, nil, nil, at); err != nil {
					return err
				}
			}
			if r.started > 0 {
				if err := ev("status", r.assignee, "", "open", "in_progress", created.Add(r.started)); err != nil {
					return err
				}
			}
			for _, c := range r.comments {
				if _, ok := users[c.by]; !ok {
					continue
				}
				if err := ev("comment", c.by, c.body, nil, nil, created.Add(c.at)); err != nil {
					return err
				}
			}
			switch r.status {
			case "resolved":
				err = ev("status", r.assignee, r.outcome, "in_progress", "resolved", created.Add(r.closed))
			case "rejected":
				err = ev("rejected", r.assignee, r.outcome, "open", "rejected", created.Add(r.closed))
			case "cancelled":
				err = ev("cancelled", r.requester, r.outcome, "open", "cancelled", created.Add(r.closed))
			}
			if err != nil {
				return err
			}
			n++
		}
		if n > 0 {
			_, err = tx.Exec(ctx, `INSERT INTO audit_log (actor, action, entity, entity_id, data) VALUES ('seed','seed.it_requests','it_request','',$1)`,
				map[string]any{"requests": n})
		}
		return err
	})
	return n, err
}
