package store

// IT staff directory (migration 0011): people in IT a request can be routed
// to. Everyone who can see requests can read the active list; admins manage it.

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"itdesk/backend/internal/domain"
)

var (
	errStaffNotFound = domain.NotFound("IT staff member not found.")
	errStaleStaff    = domain.Conflict("stale_staff", "This person was updated by someone else. Refresh and try again.")
)

const staffSelect = `SELECT s.id, s.name, s.title, s.active, s.sort_order, s.created_at, s.updated_at, s.version,
	(SELECT count(*) FROM it_requests r WHERE r.staff_id = s.id AND r.status IN ('open','in_progress')),
	s.user_id, u.email, u.name, u.status
	FROM it_staff s LEFT JOIN users u ON u.id = s.user_id`

func scanStaff(rows pgx.Rows) ([]domain.ITStaff, error) {
	defer rows.Close()
	out := []domain.ITStaff{}
	for rows.Next() {
		var st domain.ITStaff
		var created, updated time.Time
		var uid, email, name, status *string
		if err := rows.Scan(&st.ID, &st.Name, &st.Title, &st.Active, &st.SortOrder, &created, &updated, &st.Version, &st.Open,
			&uid, &email, &name, &status); err != nil {
			return nil, err
		}
		if uid != nil {
			st.HasLogin = true
			st.Login = &domain.StaffLogin{UserID: *uid, Email: deref(email), Name: deref(name), Status: deref(status)}
		}
		st.CreatedAt, st.UpdatedAt = domain.NewTime(created), domain.NewTime(updated)
		out = append(out, st)
	}
	return out, rows.Err()
}

func loadStaff(ctx context.Context, q querier, id string) (domain.ITStaff, error) {
	rows, err := q.Query(ctx, staffSelect+" WHERE s.id = $1", id)
	if err != nil {
		return domain.ITStaff{}, err
	}
	list, err := scanStaff(rows)
	if err != nil {
		return domain.ITStaff{}, err
	}
	if len(list) == 0 {
		return domain.ITStaff{}, errStaffNotFound
	}
	return list[0], nil
}

// ITStaffList returns the directory in display order. Inactive entries are
// included only for admins who ask for them.
func (s *Store) ITStaffList(ctx context.Context, actor Actor, includeInactive bool) ([]domain.ITStaff, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	where := " WHERE s.active"
	if includeInactive && actor.User.Role == "admin" {
		where = ""
	}
	rows, err := pool.Query(ctx, staffSelect+where+" ORDER BY s.active DESC, s.sort_order, lower(s.name), s.id")
	if err != nil {
		return nil, err
	}
	list, err := scanStaff(rows)
	if err != nil {
		return nil, err
	}
	// Which account an entry is linked to is for admins only.
	if actor.User.Role != "admin" {
		for i := range list {
			list[i].Login = nil
		}
	}
	return list, nil
}

// MyStaffEntry is the directory entry linked to the caller's account, if any.
func myStaffEntry(ctx context.Context, q querier, actor Actor) (*string, error) {
	var id string
	err := q.QueryRow(ctx, `SELECT id FROM it_staff WHERE user_id = $1`, actor.User.ID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) || actor.User.ID == "" {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func staffWriteErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == "it_staff_user_id_key" {
		return domain.Invalid("Check the highlighted fields.", map[string]string{"userId": "That account is already linked to someone else in the list"})
	}
	if errors.As(err, &pg) && pg.Code == "23505" {
		return domain.Invalid("Check the highlighted fields.", map[string]string{"name": "Someone with this name is already in the list"})
	}
	return err
}

// CreateITStaff adds a person to the directory (admin).
func (s *Store) CreateITStaff(ctx context.Context, actor Actor, in domain.ITStaffInput) (domain.ITStaff, error) {
	var out domain.ITStaff
	if actor.User.Role != "admin" {
		return out, domain.Forbidden("forbidden", "Only admins can manage the IT staff list.")
	}
	if errs := in.Validate(true); len(errs) > 0 {
		return out, domain.Invalid("Check the highlighted fields.", errs)
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		title, active := "", true
		if in.Title != nil {
			title = *in.Title
		}
		if in.Active != nil {
			active = *in.Active
		}
		var order int
		if in.SortOrder != nil {
			order = *in.SortOrder
		} else if err := tx.QueryRow(ctx, `SELECT COALESCE(max(sort_order) + 1, 0) FROM it_staff`).Scan(&order); err != nil {
			return err
		}
		id, now := NewID("its"), s.Now()
		if _, err := tx.Exec(ctx, `INSERT INTO it_staff (id, name, title, active, sort_order, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$6)`, id, *in.Name, title, active, order, now); err != nil {
			return staffWriteErr(err)
		}
		if err := audit(ctx, tx, actor, "it_staff.created", "it_staff", id, map[string]any{"name": *in.Name, "title": title, "active": active}); err != nil {
			return err
		}
		var err error
		out, err = loadStaff(ctx, tx, id)
		return err
	})
	return out, err
}

// UpdateITStaff edits or (de)activates a directory entry (admin). Deactivated
// people stay on the tickets already routed to them but can't be picked again.
func (s *Store) UpdateITStaff(ctx context.Context, actor Actor, id string, in domain.ITStaffInput) (domain.ITStaff, error) {
	var out domain.ITStaff
	if actor.User.Role != "admin" {
		return out, domain.Forbidden("forbidden", "Only admins can manage the IT staff list.")
	}
	if errs := in.Validate(false); len(errs) > 0 {
		return out, domain.Invalid("Check the highlighted fields.", errs)
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var version int
		err := tx.QueryRow(ctx, `SELECT version FROM it_staff WHERE id = $1 FOR UPDATE`, id).Scan(&version)
		if errors.Is(err, pgx.ErrNoRows) {
			return errStaffNotFound
		}
		if err != nil {
			return err
		}
		if in.ExpectedVersion != nil && *in.ExpectedVersion != version {
			return errStaleStaff
		}
		var sets []string
		args := []any{id, s.Now()}
		add := func(col string, v any) {
			args = append(args, v)
			sets = append(sets, col+" = $"+strconv.Itoa(len(args)))
		}
		changes := map[string]any{}
		if in.Name != nil {
			add("name", *in.Name)
			changes["name"] = *in.Name
		}
		if in.Title != nil {
			add("title", *in.Title)
			changes["title"] = *in.Title
		}
		if in.Active != nil {
			add("active", *in.Active)
			changes["active"] = *in.Active
		}
		if in.SortOrder != nil {
			add("sort_order", *in.SortOrder)
			changes["sortOrder"] = *in.SortOrder
		}
		if in.UserID != nil {
			if *in.UserID == "" {
				add("user_id", nil)
				changes["userId"] = nil
			} else {
				var role, email string
				err := tx.QueryRow(ctx, `SELECT role, email FROM users WHERE id = $1`, *in.UserID).Scan(&role, &email)
				if errors.Is(err, pgx.ErrNoRows) {
					return domain.Invalid("Check the highlighted fields.", map[string]string{"userId": "No such account"})
				}
				if err != nil {
					return err
				}
				if role != "it" {
					return domain.Invalid("Check the highlighted fields.", map[string]string{"userId": "Link an IT account (this one is not IT)"})
				}
				add("user_id", *in.UserID)
				changes["userId"], changes["email"] = *in.UserID, email
			}
		}
		if len(sets) > 0 {
			if _, err := tx.Exec(ctx, "UPDATE it_staff SET "+strings.Join(sets, ", ")+", updated_at = $2, version = version + 1 WHERE id = $1", args...); err != nil {
				return staffWriteErr(err)
			}
			action := "it_staff.updated"
			if in.Active != nil && len(changes) == 1 {
				action = map[bool]string{true: "it_staff.activated", false: "it_staff.deactivated"}[*in.Active]
			}
			if in.UserID != nil && len(sets) == 1 {
				action = map[bool]string{true: "it_staff.unlinked", false: "it_staff.linked"}[*in.UserID == ""]
			}
			if err := audit(ctx, tx, actor, action, "it_staff", id, changes); err != nil {
				return err
			}
		}
		out, err = loadStaff(ctx, tx, id)
		return err
	})
	return out, err
}

// activeStaff resolves a staff id for routing: it must exist and be active.
func activeStaff(ctx context.Context, q querier, id string) (string, error) {
	var name string
	var active bool
	err := q.QueryRow(ctx, `SELECT name, active FROM it_staff WHERE id = $1`, id).Scan(&name, &active)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !active) {
		return "", domain.Invalid("Please fix the highlighted fields.", map[string]string{"staffId": "Choose someone from the IT staff list"})
	}
	return name, err
}

// RouteITRequest sets (or clears, staffID "") the IT staff member an active
// request is routed to. IT and admins can do this; scoping is the same as
// every other request write.
func (s *Store) RouteITRequest(ctx context.Context, actor Actor, id, staffID string, act RequestAction) (domain.ITRequestDetail, error) {
	var out domain.ITRequestDetail
	if actor.User.Role != "it" && actor.User.Role != "admin" {
		return out, domain.Forbidden("forbidden", "Only IT and admins can change who in IT handles a request.")
	}
	staffID = strings.TrimSpace(staffID)
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		r, err := lockRequest(ctx, tx, actor, id, act.ExpectedVersion)
		if err != nil {
			return err
		}
		if domain.RequestClosed(r.status) {
			return domain.Conflict("request_closed", "This request is closed. Reopen it first.")
		}
		var name *string
		var idArg any
		if staffID != "" {
			n, err := activeStaff(ctx, tx, staffID)
			if err != nil {
				return err
			}
			name, idArg = &n, staffID
		}
		var cur *string
		if err := tx.QueryRow(ctx, `SELECT staff_id FROM it_requests WHERE id = $1`, id).Scan(&cur); err != nil {
			return err
		}
		if (cur == nil && staffID == "") || (cur != nil && *cur == staffID) {
			out, err = loadRequestDetail(ctx, tx, actor, id) // already so: no-op
			return err
		}
		now := s.Now()
		if _, err := tx.Exec(ctx, `UPDATE it_requests SET staff_id=$2, staff_name=$3, updated_at=$4, version=version+1 WHERE id=$1`,
			id, idArg, name, now); err != nil {
			return err
		}
		body := "No longer routed to anyone in IT"
		if name != nil {
			body = "Routed to " + *name + " (IT staff)"
		}
		if err := addRequestEvent(ctx, tx, actor, id, "assigned", body, nil, nil, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "it_request.routed", "it_request", id, map[string]any{"ticket": r.ticket, "staff": idArg, "staffName": name}); err != nil {
			return err
		}
		title := "{ticket} is no longer routed to anyone in IT"
		if name != nil {
			title = "{ticket} is routed to " + *name
		}
		if err := s.fanOutRequest(ctx, tx, actor, id, domain.NotifyRequestAssigned, "assigned", title, body, false); err != nil {
			return err
		}
		out, err = loadRequestDetail(ctx, tx, actor, id)
		return err
	})
	return out, err
}
