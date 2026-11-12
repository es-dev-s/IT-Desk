package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
)

var errSeatRace = domain.Conflict("seat_taken", "That seat was just taken by someone else. Pick another seat.")

// lockTeam serialises membership changes of one team (who is on it). Seats
// themselves are serialised by locking their floor_cells rows (loadSeats).
func lockTeam(ctx context.Context, tx pgx.Tx, teamID string) (bool, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM teams WHERE id = $1 FOR UPDATE`, teamID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// CreateTransfer moves one or more people (seat move or team transfer) and
// opens an IT ticket, all-or-nothing.
func (s *Store) CreateTransfer(ctx context.Context, actor Actor, in domain.TransferInput) (domain.TransferResult, error) {
	now := s.Now()
	var res domain.TransferResult
	if errs := in.Validate(now); len(errs) > 0 {
		return res, domain.Invalid("Check the highlighted fields.", errs)
	}
	effective, _ := domain.ValidEffectiveDate(in.EffectiveDate, now)
	current := actor.TeamScope()
	if current == "" {
		return res, domain.ErrNoTeam
	}
	dest, direction := current, "internal"
	if in.Mode == "team" {
		dest, direction = in.ToTeamID, "out"
		if dest == current {
			return res, domain.Invalid("Check the highlighted fields.", map[string]string{"toTeamId": "Choose a different team"})
		}
	}
	ids := in.MemberIDs()

	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		ok, err := lockTeam(ctx, tx, dest)
		if err != nil {
			return err
		}
		if !ok {
			return domain.Invalid("Check the highlighted fields.", map[string]string{"toTeamId": "Choose a destination team"})
		}
		members, err := membersByID(ctx, tx, ids, true)
		if err != nil {
			return err
		}
		fields := map[string]string{}
		for i, a := range in.Assignments {
			m, found := members[a.MemberID]
			if !found || m.TeamID != current || m.Status != "active" {
				name := "This member"
				if found {
					name = m.Name
				}
				fields[fmt.Sprintf("assignments.%d.memberId", i)] = name + " is no longer active on your team"
				continue
			}
			if a.ExpectedVersion != nil && *a.ExpectedVersion != m.Version {
				return domain.Conflict("stale_member", m.Name+" was changed by someone else. Refresh and try again.")
			}
		}
		var exclude []string
		if in.Mode == "internal" {
			exclude = ids
		}
		seatIDs := make([]string, 0, len(in.Assignments))
		for _, a := range in.Assignments {
			seatIDs = append(seatIDs, a.ToSeatID)
		}
		seats, err := loadSeats(ctx, tx, seatIDs, true)
		if err != nil {
			return err
		}
		taken, err := seatHolders(ctx, tx, seatIDs, exclude)
		if err != nil {
			return err
		}
		for i, a := range in.Assignments {
			m, found := members[a.MemberID]
			if !found {
				continue
			}
			// A lead's flag travels with them, so moving a lead would let a
			// non-admin mint a lead on another team: admin only.
			if m.IsLead && dest != m.TeamID && actor.User.Role != "admin" {
				return domain.Forbidden("lead_admin_only", "Only an admin can transfer a team lead.")
			}
			key := fmt.Sprintf("assignments.%d.toSeat", i)
			if in.Mode == "internal" && m.SeatID != nil && *m.SeatID == a.ToSeatID {
				fields[key] = "Already sits here"
			} else {
				msg, err := checkSeatFor(actor, seats, taken, a.ToSeatID, dest)
				if err != nil {
					return err
				}
				if msg != "" {
					fields[key] = msg
				}
			}
			if keep, ok := in.DevicesByMember[a.MemberID]; ok {
				owned := map[string]bool{}
				for _, d := range m.Devices {
					owned[d.ID] = true
				}
				for _, id := range keep {
					if !owned[id] {
						fields["devicesByMember."+a.MemberID] = "A selected device does not belong to " + m.Name
					}
				}
			}
		}
		if len(fields) > 0 {
			return domain.Invalid("Check the highlighted fields.", fields)
		}

		var seq int64
		if err := tx.QueryRow(ctx, `SELECT nextval('ticket_seq')`).Scan(&seq); err != nil {
			return err
		}
		id := NewID("trf")
		ticket := fmt.Sprintf("IT-%04d", seq)
		if _, err := tx.Exec(ctx, `INSERT INTO transfers (id, ticket, direction, from_team_id, to_team_id, effective_date,
			created_at, initiated_by, initiated_by_user, note, it_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested')`,
			id, ticket, direction, current, dest, effective, now, actor.User.Name, actor.User.ID, in.Note); err != nil {
			return err
		}
		devicesMoved := 0
		var floorsTouched []string
		for i, a := range in.Assignments {
			m := members[a.MemberID]
			var version int
			if err := tx.QueryRow(ctx, `UPDATE members SET team_id = $2, seat_id = $3, version = version + 1, updated_at = $4
				WHERE id = $1 RETURNING version`, m.ID, dest, a.ToSeatID, now).Scan(&version); err != nil {
				return err
			}
			toCode := seats[a.ToSeatID].Code
			if _, err := tx.Exec(ctx, `INSERT INTO transfer_moves (transfer_id, member_id, position, member_name,
				from_team_id, from_seat, to_seat, from_seat_id, to_seat_id, version_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				id, m.ID, i, m.Name, m.TeamID, m.Seat, toCode, m.SeatID, a.ToSeatID, version); err != nil {
				return err
			}
			floorsTouched = addFloor(floorsTouched, m.FloorID, strp(seats[a.ToSeatID].FloorID))
			keep, filtered := in.DevicesByMember[m.ID]
			keepSet := map[string]bool{}
			for _, d := range keep {
				keepSet[d] = true
			}
			pos := 0
			for _, d := range m.Devices {
				if filtered && !keepSet[d.ID] {
					continue
				}
				if _, err := tx.Exec(ctx, `INSERT INTO transfer_move_devices (transfer_id, member_id, device_id, kind, model,
					asset_tag, position) VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, m.ID, d.ID, d.Kind, d.Model, d.AssetTag, pos); err != nil {
					return err
				}
				pos++
				devicesMoved++
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO transfer_history (transfer_id, status, at) VALUES ($1, 'requested', $2)`, id, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "transfer.created", "transfer", id, map[string]any{
			"ticket": ticket, "direction": direction, "toTeamId": dest, "members": len(ids), "devices": devicesMoved,
		}); err != nil {
			return err
		}
		if res.Transfer, err = loadTransfer(ctx, tx, id); err != nil {
			return err
		}
		if err := s.fanOutTransferCreated(ctx, tx, actor, res.Transfer); err != nil {
			return err
		}
		if err := s.publishFloors(ctx, tx, actor, "occupancy", floorsTouched...); err != nil {
			return err
		}
		updated, err := loadMembers(ctx, tx, "id = ANY($1)", []any{ids}, false)
		res.Members = updated
		res.UndoExpiresAt = domain.NewTime(s.undoDeadline(now))
		return err
	})
	if db.IsSeatConflict(err) {
		return res, errSeatRace
	}
	return res, err
}

// CancelTransfer undoes a transfer that IT has not picked up yet, restoring
// everyone to their previous team and desk if those desks are still free.
func (s *Store) CancelTransfer(ctx context.Context, actor Actor, id string) (domain.UndoResult, error) {
	now := s.Now()
	var res domain.UndoResult
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var status, fromTeam, toTeam string
		var owner *string
		var created time.Time
		var cancelled *time.Time
		err := tx.QueryRow(ctx, `SELECT it_status, created_at, cancelled_at, from_team_id, to_team_id, initiated_by_user
			FROM transfers WHERE id = $1 FOR UPDATE`, id).Scan(&status, &created, &cancelled, &fromTeam, &toTeam, &owner)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NotFound("Transfer request not found.")
		} else if err != nil {
			return err
		}
		if scope := actor.TeamScope(); scope == "" || (scope != fromTeam && scope != toTeam) {
			return domain.NotFound("Transfer request not found.")
		}
		if owner == nil || *owner != actor.User.ID {
			return domain.Forbidden("not_owner", "You can only undo changes you made.")
		}
		switch {
		case cancelled != nil:
			return domain.Conflict("already_undone", "This change was already undone.")
		case status != "requested":
			return domain.Conflict("not_undoable", "IT has started on this request, so it can no longer be undone.")
		case now.After(s.undoDeadline(created)):
			return domain.Conflict("undo_expired", "The undo window has passed.")
		}
		type mv struct {
			memberID, fromTeam string
			fromSeat           *string
			versionAfter       int
		}
		rows, err := tx.Query(ctx, `SELECT member_id, from_team_id, from_seat_id, version_after FROM transfer_moves
			WHERE transfer_id = $1 ORDER BY position`, id)
		if err != nil {
			return err
		}
		var moves []mv
		var ids []string
		for rows.Next() {
			var m mv
			if err := rows.Scan(&m.memberID, &m.fromTeam, &m.fromSeat, &m.versionAfter); err != nil {
				rows.Close()
				return err
			}
			moves = append(moves, m)
			ids = append(ids, m.memberID)
		}
		rows.Close()
		if _, err := lockTeam(ctx, tx, fromTeam); err != nil {
			return err
		}
		members, err := membersByID(ctx, tx, ids, true)
		if err != nil {
			return err
		}
		for _, m := range moves {
			if members[m.memberID].Version != m.versionAfter {
				return domain.Conflict("changed_since", "Can’t undo: someone was changed again since.")
			}
		}
		var floorsTouched []string
		for _, m := range members {
			floorsTouched = addFloor(floorsTouched, m.FloorID)
		}
		var prev []string
		for _, m := range moves {
			if m.fromSeat != nil {
				prev = append(prev, *m.fromSeat)
			}
		}
		seats, err := loadSeats(ctx, tx, prev, true)
		if err != nil {
			return err
		}
		taken, err := seatHolders(ctx, tx, prev, ids)
		if err != nil {
			return err
		}
		for _, m := range moves {
			if m.fromSeat == nil {
				continue
			}
			if _, ok := seats[*m.fromSeat]; !ok {
				m.fromSeat = nil // the seat was removed from its floor since
				continue
			}
			if _, busy := taken[*m.fromSeat]; busy {
				return domain.Conflict("seat_taken", fmt.Sprintf("Can’t undo: Seat %s is now taken.", seats[*m.fromSeat].Code))
			}
		}
		for _, m := range moves {
			seat := m.fromSeat
			if seat != nil {
				if r, ok := seats[*seat]; ok {
					floorsTouched = addFloor(floorsTouched, &r.FloorID)
				} else {
					seat = nil
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE members SET team_id = $2, seat_id = $3, status = 'active', version = version + 1,
				updated_at = $4 WHERE id = $1`, m.memberID, m.fromTeam, seat, now); err != nil {
				return err
			}
		}
		if err := s.publishFloors(ctx, tx, actor, "occupancy", floorsTouched...); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE transfers SET cancelled_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`, id, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "transfer.undone", "transfer", id, map[string]any{"members": len(ids)}); err != nil {
			return err
		}
		var ticket string
		if err := tx.QueryRow(ctx, `SELECT ticket FROM transfers WHERE id = $1`, id).Scan(&ticket); err != nil {
			return err
		}
		if err := s.publishEntity(ctx, tx, actor, domain.EntityChange{Entity: domain.EntityTransfer, ID: id, Ticket: ticket,
			Change: "withdrawn"}, &fromTeam, &toTeam); err != nil {
			return err
		}
		res.Members, err = loadMembers(ctx, tx, "id = ANY($1)", []any{ids}, false)
		return err
	})
	if db.IsSeatConflict(err) {
		return res, domain.Conflict("seat_taken", "Can’t undo: a desk was just taken.")
	}
	return res, err
}

// AdvanceTransfer moves a request to the next IT stage. If expectFrom is set
// and the request is no longer in that stage, it fails with 409 instead of
// skipping a stage (protects against double clicks and concurrent agents).
func (s *Store) AdvanceTransfer(ctx context.Context, actor Actor, id, expectFrom string) (domain.Transfer, error) {
	now := s.Now()
	var t domain.Transfer
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var status string
		var cancelled *time.Time
		err := tx.QueryRow(ctx, `SELECT it_status, cancelled_at FROM transfers WHERE id = $1 FOR UPDATE`, id).Scan(&status, &cancelled)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NotFound("Transfer request not found.")
		} else if err != nil {
			return err
		}
		if cancelled != nil {
			return domain.Conflict("cancelled", "This request was cancelled.")
		}
		if expectFrom != "" && expectFrom != status {
			return domain.Conflict("stale_status", "This request was already updated to “"+status+"”. Refreshing.")
		}
		next := domain.NextItStatus(status)
		if next == "" {
			return domain.Conflict("already_completed", "This request is already completed.")
		}
		// Advancing is also an acknowledgement if nobody in IT had one yet.
		if _, err := tx.Exec(ctx, `UPDATE transfers SET it_status = $2, version = version + 1, updated_at = $3,
			acknowledged_by = CASE WHEN acknowledged_at IS NULL AND $6 THEN $4 ELSE acknowledged_by END,
			acknowledged_by_name = CASE WHEN acknowledged_at IS NULL AND $6 THEN $5 ELSE acknowledged_by_name END,
			acknowledged_at = CASE WHEN acknowledged_at IS NULL AND $6 THEN $3 ELSE acknowledged_at END
			WHERE id = $1`, id, next, now, actor.User.ID, actor.User.Name, actor.User.Role == "it"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO transfer_history (transfer_id, status, at) VALUES ($1, $2, $3)
			ON CONFLICT (transfer_id, status) DO NOTHING`, id, next, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "transfer.advanced", "transfer", id, map[string]any{"from": status, "to": next}); err != nil {
			return err
		}
		if t, err = loadTransfer(ctx, tx, id); err != nil {
			return err
		}
		return s.fanOutTransfer(ctx, tx, actor, t, domain.NotifyTransferAdvanced, "advanced",
			fmt.Sprintf("%s is now %s", t.Ticket, stageLabel(next)), actor.User.Name+" moved it to "+stageLabel(next))
	})
	return t, err
}

// MarkExit marks people as resigned/unknown and releases their desks.
// Members that are not eligible are skipped (same rule as the UI).
func (s *Store) MarkExit(ctx context.Context, actor Actor, in domain.ExitInput) (domain.ExitResult, error) {
	now := s.Now()
	var res domain.ExitResult
	if errs := in.Validate(now); len(errs) > 0 {
		return res, domain.Invalid("Check the highlighted fields.", errs)
	}
	effective, _ := domain.ValidEffectiveDate(in.EffectiveDate, now)
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		members, err := loadMembers(ctx, tx, "id = ANY($1)", []any{in.MemberIDs}, true)
		if err != nil {
			return err
		}
		batch := NewID("xb")
		var ids, exitFloors []string
		for _, m := range members {
			eligible := actor.TeamScope() != "" && m.TeamID == actor.TeamScope() &&
				(m.Status == "active" || (in.Status == "resigned" && m.Status == "unknown"))
			if !eligible {
				continue
			}
			var version int
			if err := tx.QueryRow(ctx, `UPDATE members SET status = $2, seat_id = NULL, version = version + 1, updated_at = $3
				WHERE id = $1 RETURNING version`, m.ID, in.Status, now).Scan(&version); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO exits (id, batch_id, member_id, member_name, status, seat, seat_id, prev_status,
				version_after, effective_date, created_at, initiated_by, initiated_by_user, reason)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
				NewID("exit"), batch, m.ID, m.Name, in.Status, m.Seat, m.SeatID, m.Status, version, effective, now, actor.User.Name, actor.User.ID, in.Reason); err != nil {
				return err
			}
			exitFloors = addFloor(exitFloors, m.FloorID)
			ids = append(ids, m.ID)
		}
		if len(ids) == 0 {
			return domain.Invalid("None of the selected members can be updated.", map[string]string{"memberIds": "None of the selected members can be updated."})
		}
		if err := audit(ctx, tx, actor, "member.exited", "exit_batch", batch, map[string]any{"status": in.Status, "members": len(ids)}); err != nil {
			return err
		}
		team := actor.TeamScope()
		if err := s.publishMembers(ctx, tx, actor, batch, "exited", 0, &team); err != nil {
			return err
		}
		if err := s.publishFloors(ctx, tx, actor, "occupancy", exitFloors...); err != nil {
			return err
		}
		res.BatchID = batch
		if res.Exits, err = loadExits(ctx, tx, "batch_id = $1", batch); err != nil {
			return err
		}
		res.Members, err = loadMembers(ctx, tx, "id = ANY($1)", []any{ids}, false)
		res.UndoExpiresAt = domain.NewTime(s.undoDeadline(now))
		return err
	})
	return res, err
}

// UndoExitBatch restores everyone in an exit batch to their previous status
// and desk, provided nobody changed since and the desks are still free.
func (s *Store) UndoExitBatch(ctx context.Context, actor Actor, batchID string) (domain.UndoResult, error) {
	now := s.Now()
	var res domain.UndoResult
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		type ex struct {
			memberID, prevStatus string
			seat                 *string
			versionAfter         int
			created              time.Time
			cancelled            *time.Time
			owner                *string
		}
		rows, err := tx.Query(ctx, `SELECT member_id, prev_status, seat_id, version_after, created_at, cancelled_at, initiated_by_user
			FROM exits WHERE batch_id = $1 ORDER BY id FOR UPDATE`, batchID)
		if err != nil {
			return err
		}
		var list []ex
		var ids []string
		for rows.Next() {
			var e ex
			if err := rows.Scan(&e.memberID, &e.prevStatus, &e.seat, &e.versionAfter, &e.created, &e.cancelled, &e.owner); err != nil {
				rows.Close()
				return err
			}
			list = append(list, e)
			ids = append(ids, e.memberID)
		}
		rows.Close()
		if len(list) == 0 || actor.TeamScope() == "" {
			return domain.NotFound("Nothing to undo.")
		}
		if list[0].owner == nil || *list[0].owner != actor.User.ID {
			return domain.Forbidden("not_owner", "You can only undo changes you made.")
		}
		if list[0].cancelled != nil {
			return domain.Conflict("already_undone", "This change was already undone.")
		}
		if now.After(s.undoDeadline(list[0].created)) {
			return domain.Conflict("undo_expired", "The undo window has passed.")
		}
		if _, err := lockTeam(ctx, tx, actor.TeamScope()); err != nil {
			return err
		}
		members, err := membersByID(ctx, tx, ids, true)
		if err != nil {
			return err
		}
		for _, e := range list {
			if members[e.memberID].Version != e.versionAfter {
				return domain.Conflict("changed_since", "Can’t undo: someone was changed again since.")
			}
		}
		var prev []string
		for _, e := range list {
			if e.prevStatus == "active" && e.seat != nil {
				prev = append(prev, *e.seat)
			}
		}
		seats, err := loadSeats(ctx, tx, prev, true)
		if err != nil {
			return err
		}
		taken, err := seatHolders(ctx, tx, prev, ids)
		if err != nil {
			return err
		}
		for _, e := range list {
			if e.prevStatus != "active" || e.seat == nil {
				continue
			}
			if _, busy := taken[*e.seat]; busy {
				return domain.Conflict("seat_taken", fmt.Sprintf("Can’t undo: Seat %s is now taken.", seats[*e.seat].Code))
			}
		}
		var undoFloors []string
		for _, e := range list {
			seat := e.seat
			if e.prevStatus != "active" {
				seat = nil
			}
			if seat != nil {
				if r, ok := seats[*seat]; ok {
					undoFloors = addFloor(undoFloors, &r.FloorID)
				} else {
					seat = nil // removed from its floor since
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE members SET status = $2, seat_id = $3, version = version + 1, updated_at = $4
				WHERE id = $1`, e.memberID, e.prevStatus, seat, now); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE exits SET cancelled_at = $2 WHERE batch_id = $1`, batchID, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "member.exit_undone", "exit_batch", batchID, map[string]any{"members": len(ids)}); err != nil {
			return err
		}
		team := actor.TeamScope()
		if err := s.publishMembers(ctx, tx, actor, batchID, "restored", 0, &team); err != nil {
			return err
		}
		if err := s.publishFloors(ctx, tx, actor, "occupancy", undoFloors...); err != nil {
			return err
		}
		res.Members, err = loadMembers(ctx, tx, "id = ANY($1)", []any{ids}, false)
		return err
	})
	if db.IsSeatConflict(err) {
		return res, domain.Conflict("seat_taken", "Can’t undo: a desk was just taken.")
	}
	return res, err
}

// UpdateProfile edits the caller's own display name and title. The sign-in
// email is an identity attribute that only an admin can change.
func (s *Store) UpdateProfile(ctx context.Context, actor Actor, in domain.ProfileInput) (domain.User, error) {
	errs := in.Validate()
	if _, bad := errs["email"]; !bad && in.Email != actor.User.Email {
		errs["email"] = "Ask an admin to change your sign-in email"
	}
	if len(errs) > 0 {
		return domain.User{}, domain.Invalid("Check the highlighted fields.", errs)
	}
	var u domain.User
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var team *string
		err := tx.QueryRow(ctx, `UPDATE users SET name = $2, title = $3, version = version + 1, updated_at = now()
			WHERE id = $1 RETURNING id, name, email, title, role, team_id`, actor.User.ID, in.Name, in.Title).
			Scan(&u.ID, &u.Name, &u.Email, &u.Title, &u.Role, &team)
		if err != nil {
			return err
		}
		if team != nil {
			u.TeamID = *team
			if _, err := tx.Exec(ctx, `UPDATE teams SET lead_name = $2 WHERE id = $1`, u.TeamID, u.Name); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, actor, "user.profile_updated", "user", u.ID, map[string]any{"name": u.Name, "title": u.Title}); err != nil {
			return err
		}
		return s.publishUser(ctx, tx, actor, u.ID, "updated", 0, team)
	})
	return u, err
}

func (s *Store) UpdateSettings(ctx context.Context, actor Actor, in domain.Settings) (domain.Settings, error) {
	if errs := domain.ValidateSettings(in); len(errs) > 0 {
		return domain.Settings{}, domain.Invalid("Unknown setting.", errs)
	}
	var out domain.Settings
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE users SET preferences = jsonb_set(preferences, '{notifications}',
			COALESCE(preferences->'notifications', '{}'::jsonb) || $2::jsonb), updated_at = now() WHERE id = $1`,
			actor.User.ID, in.Notifications); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "user.settings_updated", "user", actor.User.ID, in); err != nil {
			return err
		}
		var err error
		out, err = loadSettings(ctx, tx, actor.User.ID)
		return err
	})
	return out, err
}
