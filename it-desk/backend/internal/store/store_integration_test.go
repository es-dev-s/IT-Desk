package store

// Integration tests against a real PostgreSQL. They run only when
// DATABASE_URL is set (backend/.env is picked up automatically) and use a
// throwaway schema itdesk_test_<pid> that is dropped afterwards.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"itdesk/backend/internal/config"
	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
)

// Test accounts: a lead for each team, an admin and an IT user.
var (
	leadT1 = domain.User{ID: "lead_test", Name: "Lead One", Email: "lead@example.com", Title: "Lead", Role: "team_lead", TeamID: "t1"}
	leadT2 = domain.User{ID: "lead_two", Name: "Lead Two", Email: "lead2@example.com", Title: "Lead", Role: "team_lead", TeamID: "t2"}
	adminU = domain.User{ID: "usr_admin", Name: "Ada Admin", Email: "admin@example.com", Title: "Admin", Role: "admin"}
	itU    = domain.User{ID: "usr_it", Name: "Ivan Tech", Email: "it@example.com", Title: "IT", Role: "it"}
)

func as(u domain.User) Actor { return Actor{User: u, RequestID: "test", IP: "127.0.0.1"} }

func setup(t *testing.T) (*Store, Actor) {
	t.Helper()
	config.LoadDotenv()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DBSchema = fmt.Sprintf("itdesk_test_%d_%d", os.Getpid(), time.Now().UnixNano()%1e6)
	cfg.DBMaxConns = 8
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	d, err := db.New(cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := d.Connect(ctx, 3); err != nil {
		t.Skipf("database unreachable: %v", err)
	}
	if err := db.Migrate(ctx, d.Pool, cfg.DBSchema, log); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.DropSchema(context.Background(), d.Pool, cfg.DBSchema); err != nil {
			t.Errorf("cleanup: %v", err)
		}
		d.Close()
	})
	d.MarkReady()
	for _, q := range []string{
		`INSERT INTO teams (id, name, code, lead_name, location, sort_order) VALUES
			('t1','Platform','PLT','Lead One','Floor 1',0), ('t2','Payments','PAY','Lead Two','Floor 2',1)`,
		`INSERT INTO users (id, email, name, title, role, team_id, password_hash, must_change_password) VALUES
			('lead_test','lead@example.com','Lead One','Lead','team_lead','t1','x',false),
			('lead_two','lead2@example.com','Lead Two','Lead','team_lead','t2','x',false),
			('usr_admin','admin@example.com','Ada Admin','Admin','admin',NULL,'x',false),
			('usr_it','it@example.com','Ivan Tech','IT','it',NULL,'x',false)`,
	} {
		if _, err := d.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	// One published floor, 5 rows x 8 seats (ids = codes A-1 .. E-8):
	// rows A, C, D are t1's zone, row B is t2's, row E has no team.
	zones := map[byte]string{'A': "t1", 'B': "t2", 'C': "t1", 'D': "t1"}
	var els []domain.FloorElement
	for r, row := range "ABCDE" {
		for n := 1; n <= 8; n++ {
			id := fmt.Sprintf("%c-%d", row, n)
			e := domain.FloorElement{ID: id, Kind: domain.KindSeat, X: n, Y: r * 2, W: 1, H: 1, Code: id, CodeLocked: true}
			if z, ok := zones[byte(row)]; ok {
				e.TeamID = &z
			}
			els = append(els, e)
		}
	}
	els = append(els, domain.FloorElement{ID: "door1", Kind: domain.KindDoor, X: 0, Y: 0, W: 1, H: 1})
	seedFloor(t, ctx, d, "flr_t", "Test Floor", 10, 10, els)
	for _, q := range []string{
		`INSERT INTO members (id, name, email, role, sub_group, team_id, seat_id, status, joined_at, hue) VALUES
			('m1','Ann Lee','ann@example.com','Eng','Core','t1','A-1','active','2024-01-01',10),
			('m2','Bo Chen','bo@example.com','Eng','Core','t1','A-2','active','2024-01-01',20),
			('m3','Cy Diaz','cy@example.com','Eng','Core','t1','A-3','active','2024-01-01',30),
			('m4','Di Eze','di@example.com','Eng','Core','t2','B-4','active','2024-01-01',40)`,
		`INSERT INTO devices (id, member_id, kind, model, asset_tag) VALUES ('d1','m1','laptop','MBP','IT-LP-0001')`,
	} {
		if _, err := d.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	return New(d, log, 10*time.Minute), as(leadT1)
}

// seedFloor inserts a published floor whose draft matches its cells.
func seedFloor(t *testing.T, ctx context.Context, d *db.DB, id, name string, cols, rows int, els []domain.FloorElement) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"cols": cols, "rows": rows, "elements": els})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO floors (id, name, level, cols, rows, status, draft, published_at)
		VALUES ($1,$2,1,$3,$4,'published',$5,now())`, id, name, cols, rows, raw); err != nil {
		t.Fatal(err)
	}
	for _, e := range els {
		var c *string
		if e.Kind == domain.KindSeat {
			c = &e.Code
		}
		if _, err := d.Pool.Exec(ctx, `INSERT INTO floor_cells (id, floor_id, kind, x, y, w, h, code, label, team_id, lead_seat)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, e.ID, id, e.Kind, e.X, e.Y, e.W, e.H, c, e.Label, e.TeamID, e.LeadSeat); err != nil {
			t.Fatal(err)
		}
	}
}

func today() string { return time.Now().UTC().Format(domain.DateLayout) }

func code(err error) string {
	var de *domain.Error
	if errors.As(err, &de) {
		return de.Code
	}
	if err != nil {
		return "raw:" + err.Error()
	}
	return ""
}

func TestConcurrentDoubleBookingAllowsExactlyOne(t *testing.T) {
	st, actor := setup(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make([]error, 2)
	for i, id := range []string{"m1", "m2"} {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			_, results[i] = st.CreateTransfer(ctx, actor, domain.TransferInput{Mode: "internal", EffectiveDate: today(),
				Assignments: []domain.Assignment{{MemberID: id, ToSeatID: "C-5"}}})
		}(i, id)
	}
	wg.Wait()
	ok, conflicts := 0, 0
	for _, err := range results {
		switch c := code(err); c {
		case "":
			ok++
		case "validation_failed", "seat_taken":
			conflicts++
		default:
			t.Errorf("unexpected error: %s", c)
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatalf("want exactly one winner, got ok=%d conflicts=%d (%v)", ok, conflicts, results)
	}
	var n int
	_ = st.db.Pool.QueryRow(ctx, `SELECT count(*) FROM members WHERE seat_id='C-5'`).Scan(&n)
	if n != 1 {
		t.Fatalf("seat C-5 held by %d people", n)
	}
}

func TestSwapAndUndo(t *testing.T) {
	st, actor := setup(t)
	ctx := context.Background()
	res, err := st.CreateTransfer(ctx, actor, domain.TransferInput{Mode: "internal", EffectiveDate: today(), Note: "swap",
		Assignments: []domain.Assignment{{MemberID: "m1", ToSeatID: "A-2"}, {MemberID: "m2", ToSeatID: "A-1"}}})
	if err != nil {
		t.Fatalf("swap rejected: %v", err)
	}
	if res.Transfer.Ticket != "IT-4300" || len(res.Transfer.Moves) != 2 || len(res.Transfer.Moves[0].Devices) != 1 {
		t.Errorf("unexpected transfer: %+v", res.Transfer)
	}
	if _, err := st.CreateTransfer(ctx, actor, domain.TransferInput{Mode: "internal", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m3", ToSeatID: "E-8"}}}); code(err) != "zone_scope" {
		t.Errorf("seat outside the lead's zone accepted: %v", err)
	}
	if _, err := st.CreateTransfer(ctx, actor, domain.TransferInput{Mode: "internal", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m3", ToSeatID: "B-1"}}}); code(err) != "zone_scope" {
		t.Errorf("seat in another team's zone accepted: %v", err)
	}
	stale := 0
	if _, err := st.CreateTransfer(ctx, actor, domain.TransferInput{Mode: "internal", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m1", ToSeatID: "D-1", ExpectedVersion: &stale}}}); code(err) != "stale_member" {
		t.Errorf("stale version accepted: %v", err)
	}
	if _, err := st.CancelTransfer(ctx, actor, res.Transfer.ID); err != nil {
		t.Fatalf("undo failed: %v", err)
	}
	m1, _ := st.Member(ctx, actor, "m1")
	if m1.Seat == nil || *m1.Seat != "A-1" {
		t.Errorf("m1 not restored: %v", m1.Seat)
	}
	if _, err := st.CancelTransfer(ctx, actor, res.Transfer.ID); code(err) != "already_undone" {
		t.Errorf("double undo: %v", err)
	}
}

func TestTeamTransferAdvanceAndExitUndo(t *testing.T) {
	st, actor := setup(t)
	ctx := context.Background()
	if _, err := st.CreateTransfer(ctx, actor, domain.TransferInput{Mode: "team", ToTeamID: "t2", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m3", ToSeatID: "B-4"}}}); code(err) != "validation_failed" {
		t.Errorf("occupied destination seat accepted: %v", err)
	}
	if _, err := st.CreateTransfer(ctx, actor, domain.TransferInput{Mode: "team", ToTeamID: "t2", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m3", ToSeatID: "C-8"}}}); code(err) != "zone_scope" {
		t.Errorf("team transfer onto the source team's zone accepted: %v", err)
	}
	res, err := st.CreateTransfer(ctx, actor, domain.TransferInput{Mode: "team", ToTeamID: "t2", EffectiveDate: today(),
		Assignments: []domain.Assignment{{MemberID: "m3", ToSeatID: "B-1"}}})
	if err != nil || res.Members[0].TeamID != "t2" || res.Transfer.Direction != "out" {
		t.Fatalf("team transfer: %v %+v", err, res)
	}
	it := as(itU)
	tr, err := st.AdvanceTransfer(ctx, it, res.Transfer.ID, "requested")
	if err != nil || tr.ItStatus != "scheduled" || len(tr.History) != 2 {
		t.Fatalf("advance: %v %+v", err, tr)
	}
	if _, err := st.AdvanceTransfer(ctx, it, res.Transfer.ID, "requested"); code(err) != "stale_status" {
		t.Errorf("double advance: %v", err)
	}
	if _, err := st.CancelTransfer(ctx, actor, res.Transfer.ID); code(err) != "not_undoable" {
		t.Errorf("undo after IT started: %v", err)
	}

	ex, err := st.MarkExit(ctx, actor, domain.ExitInput{MemberIDs: []string{"m1", "m4"}, Status: "resigned", Reason: "Left company", EffectiveDate: today()})
	if err != nil || len(ex.Exits) != 1 || ex.Members[0].Seat != nil {
		t.Fatalf("exit: %v %+v", err, ex)
	}
	if _, err := st.UndoExitBatch(ctx, actor, ex.BatchID); err != nil {
		t.Fatalf("exit undo: %v", err)
	}
	m1, _ := st.Member(ctx, actor, "m1")
	if m1.Status != "active" || m1.Seat == nil || *m1.Seat != "A-1" {
		t.Errorf("m1 not restored: %+v", m1)
	}
	ws, err := st.Workspace(ctx, actor, "")
	if err != nil || len(ws.Transfers) != 1 || len(ws.Exits) != 0 {
		t.Errorf("workspace: %v transfers=%d exits=%d", err, len(ws.Transfers), len(ws.Exits))
	}
}

func TestIdempotencyAndSettings(t *testing.T) {
	st, actor := setup(t)
	ctx := context.Background()
	_, started, err := st.IdemBegin(ctx, "k1", "POST /x", "h1")
	if err != nil || !started {
		t.Fatalf("begin: %v %v", started, err)
	}
	rec, started, _ := st.IdemBegin(ctx, "k1", "POST /x", "h1")
	if started || rec.Status != nil {
		t.Errorf("in-progress key not detected: %+v", rec)
	}
	if err := st.IdemComplete(ctx, "k1", "POST /x", 201, []byte(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	rec, _, _ = st.IdemBegin(ctx, "k1", "POST /x", "h1")
	if rec.Status == nil || *rec.Status != 201 || string(rec.Body) != `{"data":1}` {
		t.Errorf("replay: %+v", rec)
	}
	s, err := st.UpdateSettings(ctx, actor, domain.Settings{Notifications: map[string]bool{"digest": true}})
	if err != nil || !s.Notifications["digest"] || !s.Notifications["moved"] {
		t.Errorf("settings: %v %+v", err, s)
	}
	l, err := st.UpdateProfile(ctx, actor, domain.ProfileInput{Name: "Lead Prime", Email: "lead@example.com", Title: "Director"})
	if err != nil || l.Name != "Lead Prime" {
		t.Errorf("profile: %v %+v", err, l)
	}
	teams, _ := st.Teams(ctx)
	if teams[0].LeadName != "Lead Prime" {
		t.Errorf("team lead name not synced: %+v", teams[0])
	}
	if _, err := st.UpdateProfile(ctx, actor, domain.ProfileInput{Name: "Lead Prime", Email: "new@example.com", Title: "Director"}); code(err) != "validation_failed" {
		t.Errorf("self email change accepted: %v", err)
	}
	f, err := st.Floor(ctx, actor, "flr_t")
	if err != nil || f.Stats.Seats != 40 || f.Stats.Occupied != 4 || f.Stats.ByTeam["t1"] != 24 || f.Stats.ByTeam["t2"] != 8 {
		t.Errorf("floor: %v %+v", err, f.Stats)
	}
	teams, _ = st.Teams(ctx)
	if teams[0].SeatsTotal != 24 || teams[0].SeatsOccupied != 3 {
		t.Errorf("team seats: %+v", teams[0])
	}
}
