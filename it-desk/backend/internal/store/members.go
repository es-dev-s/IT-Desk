package store

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
)

var errStaleMember = domain.Conflict("stale_member", "Someone else just changed this person. Reload and try again.")

// mapMemberWriteErr turns unique / exclusion violations into field errors the
// form can show next to the right input.
func mapMemberWriteErr(err error) error {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return err
	}
	switch {
	case pg.Code == "23505" && strings.Contains(pg.ConstraintName, "email"):
		return domain.Invalid("Check the highlighted fields.", map[string]string{"email": "Someone on the roster already uses this email"})
	case pg.Code == "23505" && strings.Contains(pg.ConstraintName, "employee_id"):
		return domain.Invalid("Check the highlighted fields.", map[string]string{"employeeId": "This employee ID is already on the roster"})
	case pg.Code == "23505" && strings.Contains(pg.ConstraintName, "asset_tag"):
		return domain.Invalid("Check the highlighted fields.", map[string]string{"devices": "One of these asset tags was just registered to someone else"})
	case db.IsSeatConflict(err):
		return errSeatRace
	}
	return err
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// checkMemberWrite verifies a newly chosen seat (published, free, and in the
// team's zone for a team lead) and that no asset tag belongs to another
// person. curSeat is the person's current seat: keeping it is always allowed.
func (s *Store) checkMemberWrite(ctx context.Context, tx pgx.Tx, actor Actor, in domain.MemberInput, selfID string, curSeat *string) error {
	errs := map[string]string{}
	if in.SeatID != nil && (curSeat == nil || *curSeat != *in.SeatID) {
		pre, err := loadSeats(ctx, tx, []string{*in.SeatID}, false)
		if err != nil {
			return err
		}
		seats, err := loadSeats(ctx, tx, []string{*in.SeatID}, true)
		if err != nil {
			return err
		}
		taken, err := seatHolders(ctx, tx, []string{*in.SeatID}, []string{selfID})
		if err != nil {
			return err
		}
		msg, claim, err := checkSeatOrClaim(actor, pre, seats, taken, *in.SeatID, in.TeamID)
		if err != nil {
			return err
		}
		if msg != "" {
			errs["seat"] = msg
		} else if claim {
			if err := s.claimSeat(ctx, tx, actor, seats[*in.SeatID], in.TeamID); err != nil {
				return err
			}
		}
	}
	if len(in.Devices) > 0 {
		tags := make([]string, 0, len(in.Devices))
		for _, d := range in.Devices {
			tags = append(tags, d.AssetTag)
		}
		rows, err := tx.Query(ctx, `SELECT d.asset_tag, m.name FROM devices d JOIN members m ON m.id = d.member_id
			WHERE d.asset_tag = ANY($1) AND d.member_id <> $2`, tags, selfID)
		if err != nil {
			return err
		}
		holders := map[string]string{}
		for rows.Next() {
			var tag, name string
			if err := rows.Scan(&tag, &name); err != nil {
				rows.Close()
				return err
			}
			holders[tag] = name
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for i, d := range in.Devices {
			if who, ok := holders[d.AssetTag]; ok {
				errs[deviceKey(i)] = d.AssetTag + " is registered to " + who
			}
		}
	}
	if len(errs) > 0 {
		return domain.Invalid("Check the highlighted fields.", errs)
	}
	return nil
}

func deviceKey(i int) string {
	return "devices." + strconv.Itoa(i) + ".assetTag"
}

func (s *Store) prepareMember(actor Actor, in *domain.MemberInput) error {
	in.Normalize()
	if scope := actor.TeamScope(); scope != "" {
		if in.TeamID == "" {
			in.TeamID = scope
		}
		if in.TeamID != scope {
			return domain.Forbidden("team_scope", "You can only manage people on your own team.")
		}
	}
	if errs := in.Validate(); len(errs) > 0 {
		return domain.Invalid("Check the highlighted fields.", errs)
	}
	return nil
}

// errLeadAdminOnly: lead status is admin-only, so a team lead can never mint
// another lead (for their own team or any other).
var errLeadAdminOnly = domain.Forbidden("lead_admin_only", "Only an admin can mark or unmark someone as team lead.")

// resolveLead returns the is_lead value to store: the stored flag when the
// request omits it, else the requested one. A non-admin may only echo the
// stored value; any change is refused (never silently dropped).
func resolveLead(actor Actor, requested *bool, stored bool) (bool, error) {
	if requested == nil {
		return stored, nil
	}
	if *requested != stored && actor.User.Role != "admin" {
		return false, errLeadAdminOnly
	}
	return *requested, nil
}

// ensureSingleMemberLead refuses a second active person flagged as team lead.
// The team row is already locked by lockMemberTeam.
func ensureSingleMemberLead(ctx context.Context, tx pgx.Tx, teamID, exceptMemberID string) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM members WHERE team_id = $1 AND is_lead AND status = 'active' AND id <> $2`, teamID, exceptMemberID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return domain.Invalid("This team already has a Team Lead assigned.", map[string]string{"isLead": "This team already has a Team Lead assigned."})
	}
	return nil
}

func lockMemberTeam(ctx context.Context, tx pgx.Tx, teamID string) error {
	found, err := lockTeam(ctx, tx, teamID)
	if err != nil {
		return err
	}
	if !found {
		return domain.Invalid("Check the highlighted fields.", map[string]string{"teamId": "That team no longer exists"})
	}
	return nil
}

func insertDevice(ctx context.Context, tx pgx.Tx, memberID string, pos int, d domain.DeviceInput) error {
	_, err := tx.Exec(ctx, `INSERT INTO devices (id, member_id, kind, model, asset_tag, position) VALUES ($1,$2,$3,$4,$5,$6)`,
		NewID("dev"), memberID, d.Kind, d.Model, d.AssetTag, pos)
	return err
}

// CreateMember adds a person to a team's roster (optionally on a desk, with
// their kit). Admins pick any team; a team lead only adds to their own.
func (s *Store) CreateMember(ctx context.Context, actor Actor, in domain.MemberInput) (domain.Member, error) {
	if err := s.prepareMember(actor, &in); err != nil {
		return domain.Member{}, err
	}
	isLead, err := resolveLead(actor, in.IsLead, false)
	if err != nil {
		return domain.Member{}, err
	}
	var out domain.Member
	err = s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if err := lockMemberTeam(ctx, tx, in.TeamID); err != nil {
			return err
		}
		id := NewID("mem")
		if err := s.checkMemberWrite(ctx, tx, actor, in, id, nil); err != nil {
			return err
		}
		if isLead {
			if err := ensureSingleMemberLead(ctx, tx, in.TeamID, id); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO members (id, name, email, employee_id, role, sub_group, team_id, seat_id, is_lead, status, joined_at, hue)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11)`,
			id, in.Name, nullable(in.Email), nullable(in.EmployeeID), in.Designation, in.SubGroup, in.TeamID, in.SeatID, isLead,
			s.Now().Format("2006-01-02"), domain.HueFor(in.Name)); err != nil {
			return mapMemberWriteErr(err)
		}
		for i, d := range in.Devices {
			if err := insertDevice(ctx, tx, id, i, d); err != nil {
				return mapMemberWriteErr(err)
			}
		}
		if err := audit(ctx, tx, actor, "member.created", "member", id, map[string]any{
			"name": in.Name, "teamId": in.TeamID, "seatId": in.SeatID, "isLead": isLead, "devices": len(in.Devices)}); err != nil {
			return err
		}
		m, err := membersByID(ctx, tx, []string{id}, false)
		if err != nil {
			return err
		}
		out = m[id]
		if err := s.publishFloors(ctx, tx, actor, "occupancy", addFloor(nil, out.FloorID)...); err != nil {
			return err
		}
		return s.publishMembers(ctx, tx, actor, id, "created", out.Version, &in.TeamID)
	})
	return out, mapMemberWriteErr(err)
}

// UpdateMember edits a person's details, desk and kit. Device rows keep
// their id when the form sends it back; missing ones are removed.
func (s *Store) UpdateMember(ctx context.Context, actor Actor, id string, in domain.MemberInput) (domain.Member, error) {
	if err := s.prepareMember(actor, &in); err != nil {
		return domain.Member{}, err
	}
	var out domain.Member
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		var curTeam string
		var storedLead bool
		err := tx.QueryRow(ctx, `SELECT team_id, is_lead FROM members WHERE id = $1`, id).Scan(&curTeam, &storedLead)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NotFound("That person is no longer on the roster.")
		}
		if err != nil {
			return err
		}
		if scope := actor.TeamScope(); scope != "" && curTeam != scope {
			return domain.NotFound("That person is no longer on the roster.")
		}
		// Lock floors in a stable order so two cross-team edits can't deadlock.
		teams := []string{curTeam}
		if in.TeamID != curTeam {
			teams = append(teams, in.TeamID)
			if teams[1] < teams[0] {
				teams[0], teams[1] = teams[1], teams[0]
			}
		}
		for _, t := range teams {
			if err := lockMemberTeam(ctx, tx, t); err != nil {
				return err
			}
		}
		cur, err := membersByID(ctx, tx, []string{id}, true)
		if err != nil {
			return err
		}
		m, ok := cur[id]
		if !ok {
			return domain.NotFound("That person is no longer on the roster.")
		}
		if in.ExpectedVersion != nil && *in.ExpectedVersion != m.Version {
			return errStaleMember
		}
		if m.Status != "active" && in.SeatID != nil {
			return domain.Invalid("Check the highlighted fields.", map[string]string{"seat": "Only active people can hold a seat"})
		}
		if err := s.checkMemberWrite(ctx, tx, actor, in, id, m.SeatID); err != nil {
			return err
		}
		isLead, err := resolveLead(actor, in.IsLead, storedLead)
		if err != nil {
			return err
		}
		if isLead {
			if err := ensureSingleMemberLead(ctx, tx, in.TeamID, id); err != nil {
				return err
			}
		}
		hue := m.Hue
		if !strings.EqualFold(m.Name, in.Name) {
			hue = domain.HueFor(in.Name)
		}
		if _, err := tx.Exec(ctx, `UPDATE members SET name=$2, email=$3, employee_id=$4, role=$5, sub_group=$6, team_id=$7, seat_id=$8,
			hue=$9, is_lead=$10, version = version + 1, updated_at = now() WHERE id = $1`,
			id, in.Name, nullable(in.Email), nullable(in.EmployeeID), in.Designation, in.SubGroup, in.TeamID, in.SeatID, hue, isLead); err != nil {
			return mapMemberWriteErr(err)
		}
		owned := map[string]bool{}
		for _, d := range m.Devices {
			owned[d.ID] = true
		}
		keep := []string{}
		for _, d := range in.Devices {
			if d.ID != "" && owned[d.ID] {
				keep = append(keep, d.ID)
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM devices WHERE member_id = $1 AND NOT (id = ANY($2))`, id, keep); err != nil {
			return err
		}
		for i, d := range in.Devices {
			if d.ID != "" && owned[d.ID] {
				if _, err := tx.Exec(ctx, `UPDATE devices SET kind=$2, model=$3, asset_tag=$4, position=$5 WHERE id = $1`,
					d.ID, d.Kind, d.Model, d.AssetTag, i); err != nil {
					return mapMemberWriteErr(err)
				}
				continue
			}
			if err := insertDevice(ctx, tx, id, i, d); err != nil {
				return mapMemberWriteErr(err)
			}
		}
		if err := audit(ctx, tx, actor, "member.updated", "member", id, map[string]any{
			"name": in.Name, "teamId": in.TeamID, "previousTeamId": curTeam, "seatId": in.SeatID, "isLead": isLead, "devices": len(in.Devices)}); err != nil {
			return err
		}
		after, err := membersByID(ctx, tx, []string{id}, false)
		if err != nil {
			return err
		}
		out = after[id]
		// Names, devices and lead badges show on the floor plan too.
		if err := s.publishFloors(ctx, tx, actor, "occupancy", addFloor(nil, m.FloorID, out.FloorID)...); err != nil {
			return err
		}
		return s.publishMembers(ctx, tx, actor, id, "updated", out.Version, &curTeam, &in.TeamID)
	})
	return out, mapMemberWriteErr(err)
}
