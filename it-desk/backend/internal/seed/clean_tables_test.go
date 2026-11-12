package seed

import (
	"io/fs"
	"regexp"
	"sort"
	"testing"

	"itdesk/backend/migrations"
)

// TestCleanOrderMatchesSchema guards db-clean against tables that were
// renamed or dropped by a later migration (e.g. the old "leads" table).
func TestCleanOrderMatchesSchema(t *testing.T) {
	names, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	create := regexp.MustCompile(`(?i)CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)`)
	drop := regexp.MustCompile(`(?i)DROP TABLE (?:IF EXISTS )?([a-z_]+)`)
	live := map[string]bool{}
	for _, n := range names {
		b, err := fs.ReadFile(migrations.FS, n)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range create.FindAllStringSubmatch(string(b), -1) {
			live[m[1]] = true
		}
		for _, m := range drop.FindAllStringSubmatch(string(b), -1) {
			delete(live, m[1])
		}
	}
	// Kept on purpose: the team catalogue, the IT staff directory, accounts (admins) and floor plans.
	listed := map[string]bool{"users": true, "teams": true, "it_staff": true, "buildings": true, "floors": true, "floor_cells": true}
	for _, tbl := range cleanOrder {
		if !live[tbl] {
			t.Errorf("cleanOrder lists %q, which no migration leaves in place", tbl)
		}
		listed[tbl] = true
	}
	for tbl := range live {
		if !listed[tbl] {
			t.Errorf("table %q is not handled by Clean", tbl)
		}
	}
}
