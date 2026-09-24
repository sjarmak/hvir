package sqlite

import (
	"database/sql"
	_ "embed"
)

func Open() *sql.DB { return nil }
