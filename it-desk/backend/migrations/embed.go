// Package migrations embeds the ordered SQL migrations (NNNN_name.sql).
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
