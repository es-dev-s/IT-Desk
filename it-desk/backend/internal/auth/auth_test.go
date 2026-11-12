package auth

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHashAndVerify(t *testing.T) {
	h, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("unexpected format %q", h)
	}
	h2, _ := HashPassword("correct horse battery staple")
	if h == h2 {
		t.Error("salt not random")
	}
	if ok, rehash, err := VerifyPassword("correct horse battery staple", h); !ok || rehash || err != nil {
		t.Errorf("verify: %v %v %v", ok, rehash, err)
	}
	if ok, _, _ := VerifyPassword("Correct horse battery staple", h); ok {
		t.Error("wrong password accepted")
	}
	weak, _ := hashWith("pw-weak-params-123", Params{Memory: 8 * 1024, Time: 1, Threads: 1, SaltLen: 16, KeyLen: 32})
	if ok, rehash, _ := VerifyPassword("pw-weak-params-123", weak); !ok || !rehash {
		t.Error("weaker params should verify and ask for rehash")
	}
	for _, bad := range []string{"", "plain", "$argon2i$v=19$m=1,t=1,p=1$a$b", "$argon2id$v=19$m=0,t=1,p=1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5a2V5", h[:len(h)-4] + "!!!!"} {
		if ok, _, err := VerifyPassword("x", bad); ok || err == nil {
			t.Errorf("malformed hash %q accepted", bad)
		}
	}
	BurnTime("anything") // must not panic
}

func TestPasswordPolicy(t *testing.T) {
	cases := map[string]bool{ // password -> acceptable
		"short1!":                  false,
		"aaaaaaaaaaaaaaaa":         false,
		"password12345!":           false,
		"pawan.ojha-2026x":         false, // contains email local part
		"OjhaRocks-2026!":          false, // contains name
		"Velvet-Harbor-71":         true,
		"blue river tiny lamp":     true,
		strings.Repeat("x9", 70):   false,
		"Ab3$Ab3$Ab3$":             false, // too few distinct chars
		"correct horse battery st": true,
	}
	for pw, want := range cases {
		got := ValidateNewPassword(pw, "pawan.ojha@itdesk.io", "Pawan Ojha") == ""
		if got != want {
			t.Errorf("%q: acceptable=%v want %v (%s)", pw, got, want, ValidateNewPassword(pw, "pawan.ojha@itdesk.io", "Pawan Ojha"))
		}
	}
	for i := 0; i < 50; i++ {
		p, err := GeneratePassword(16)
		if err != nil || len(p) != 16 || ValidateNewPassword(p, "", "") != "" {
			t.Fatalf("generated %q: %v", p, err)
		}
	}
}

func TestTokens(t *testing.T) {
	tok, hash, err := NewToken()
	if err != nil || !PlausibleToken(tok) || len(hash) != 64 {
		t.Fatalf("token: %q %q %v", tok, hash, err)
	}
	if !TokenMatches(tok, hash) || TokenMatches(tok+"x", hash) || TokenMatches("", hash) || TokenMatches(tok, "") {
		t.Error("TokenMatches wrong")
	}
	if PlausibleToken("short") || PlausibleToken(strings.Repeat("*", 43)) {
		t.Error("implausible token accepted")
	}
}

// The permission matrix, spelled out: if anyone edits Matrix this test must be
// updated deliberately.
func TestPolicyMatrix(t *testing.T) {
	want := map[Permission][3]bool{ // admin, team_lead, it
		PermSelf:            {true, true, true},
		PermViewWorkspace:   {true, true, true},
		PermViewTeams:       {true, true, true},
		PermViewMembers:     {true, true, true},
		PermViewFloor:       {true, true, true},
		PermManageFloors:    {true, false, false},
		PermAssignSeat:      {true, true, false},
		PermViewTransfers:   {true, true, true},
		PermCreateTransfer:  {false, true, false},
		PermUndoTransfer:    {false, true, false},
		PermAdvanceTransfer: {false, false, true},
		PermViewExits:       {true, true, false},
		PermMarkExit:        {false, true, false},
		PermUndoExit:        {false, true, false},
		PermViewOverview:    {true, true, false},
		PermViewActivity:    {true, false, false},
		PermManageUsers:     {true, false, false},
		PermViewRequests:    {true, true, true},
		PermCreateRequest:   {true, true, false},
		PermCancelRequest:   {true, true, false},
		PermCommentRequest:  {true, true, true},
		PermFulfilRequest:   {false, false, true},
		PermManageMembers:   {true, true, false},
	}
	if len(want) != len(AllPermissions) {
		t.Fatalf("matrix test covers %d of %d permissions", len(want), len(AllPermissions))
	}
	for p, row := range want {
		for i, r := range []Role{RoleAdmin, RoleTeamLead, RoleIT} {
			if Can(r, p) != row[i] {
				t.Errorf("%s/%s = %v, want %v", r, p, Can(r, p), row[i])
			}
		}
		if Can(Role("root"), p) || Can("", p) {
			t.Errorf("unknown role granted %s", p)
		}
	}
	if Can(RoleAdmin, Permission("nope")) {
		t.Error("unknown permission granted")
	}
}

func TestLockDuration(t *testing.T) {
	for n, want := range map[int]time.Duration{0: 0, 4: 0, 5: time.Minute, 6: 2 * time.Minute, 8: 8 * time.Minute, 11: time.Hour, 50: time.Hour} {
		if got := LockDuration(n); got != want {
			t.Errorf("LockDuration(%d) = %v, want %v", n, got, want)
		}
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := NewLimiter(3, time.Minute)
	l.SetClock(func() time.Time { return now })
	for i := 0; i < 3; i++ {
		if b, _ := l.Blocked("k"); b {
			t.Fatalf("blocked after %d", i)
		}
		l.Hit("k")
	}
	if b, wait := l.Blocked("k"); !b || wait != time.Minute {
		t.Errorf("want blocked 1m, got %v %v", b, wait)
	}
	if b, _ := l.Blocked("other"); b {
		t.Error("keys must be independent")
	}
	now = now.Add(61 * time.Second)
	if b, _ := l.Blocked("k"); b {
		t.Error("window should have expired")
	}
	l.Hit("k")
	l.Reset("k")
	if b, _ := l.Blocked("k"); b {
		t.Error("reset failed")
	}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); l.Hit("c"); l.Blocked("c") }()
	}
	wg.Wait()
}

func TestSessionValid(t *testing.T) {
	now := time.Now()
	exp := now.Add(time.Hour)
	if !SessionValid(now.Add(-time.Minute), exp, false, 30*time.Minute, now) {
		t.Error("fresh session rejected")
	}
	if SessionValid(now.Add(-31*time.Minute), exp, false, 30*time.Minute, now) {
		t.Error("idle session accepted")
	}
	if SessionValid(now, now, false, time.Hour, now) {
		t.Error("expired session accepted")
	}
	if SessionValid(now, exp, true, time.Hour, now) {
		t.Error("revoked session accepted")
	}
}
