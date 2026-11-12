package seed

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPruneCredentialsKeepsAdminsOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "creds.txt")
	in := "# demo accounts\nROLE NAME EMAIL TEAM PASSWORD\nadmin Admin a@x.io - fake-admin\n\nteam_lead Lead l@x.io t1 fake-lead\nit Tech i@x.io - fake-it\n"
	if err := os.WriteFile(path, []byte(in), 0o644); err != nil {
		t.Fatal(err)
	}
	n, err := PruneCredentials(path, time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC))
	if err != nil || n != 2 {
		t.Fatalf("removed %d, err %v", n, err)
	}
	raw, _ := os.ReadFile(path)
	got := string(raw)
	if strings.Contains(got, "fake-lead") || strings.Contains(got, "fake-it") || !strings.Contains(got, "fake-admin") ||
		!strings.Contains(got, "ROLE NAME") || !strings.Contains(got, "# demo accounts") || !strings.Contains(got, "db-clean") {
		t.Fatal("unexpected pruned content")
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	if n, err := PruneCredentials(filepath.Join(t.TempDir(), "missing"), time.Now()); n != 0 || err != nil {
		t.Fatal("missing file should be a no-op")
	}
}
