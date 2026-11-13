package handlers

// Floor plan API. See docs/floors.md for payloads.
//
//	GET    /api/v1/floors                     list (admins also see drafts)        floor.view
//	GET    /api/v1/floors/{id}                published layout + occupants + stats floor.view
//	POST   /api/v1/floors                     create (template / elements / publish) floors.manage
//	PATCH  /api/v1/floors/{id}                name, level, order, prefix, notes      floors.manage
//	DELETE /api/v1/floors/{id}                only when nobody sits there            floors.manage
//	POST   /api/v1/floors/{id}/duplicate      {name, keepZones}                      floors.manage
//	GET    /api/v1/floors/{id}/draft          working copy + issues                  floors.manage
//	PUT    /api/v1/floors/{id}/draft          replace (bulk upsert)                  floors.manage
//	PATCH  /api/v1/floors/{id}/draft          {upsert, delete}                       floors.manage
//	DELETE /api/v1/floors/{id}/draft          discard unpublished changes            floors.manage
//	POST   /api/v1/floors/{id}/publish        {onConflict, dryRun}                   floors.manage
//	POST   /api/v1/floors/{id}/zones          paint seats with a team, live          floors.manage
//	PUT    /api/v1/floors/{id}/seat-codes     real seat numbers (bulk, swaps ok)     floors.manage
//	POST   /api/v1/zones/move                 move a team's zone (any floor)         floors.manage
//	POST   /api/v1/zone-changes/{id}/undo     undo a zone change in the window       floors.manage
//	PUT    /api/v1/members/{id}/seat          seat a person                          seats.assign
//
// While FLOOR_LAYOUT_LOCKED is on (the default), the layout writes — create, duplicate,
// draft PUT/PATCH/DELETE and publish — answer 403 layout_locked.

import (
	"net/http"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/store"
)

type route func(pattern string, perm auth.Permission, h actorHandler)

func (s *Server) floorRoutes(read, write route) {
	read("GET /api/v1/floors", auth.PermViewFloor, s.getFloors)
	read("GET /api/v1/floors/{id}", auth.PermViewFloor, s.getFloor)
	// Layout writes are refused while FLOOR_LAYOUT_LOCKED is on (the default).
	layout := func(h actorHandler) actorHandler {
		return func(w http.ResponseWriter, r *http.Request, a store.Actor) {
			if s.cfg.FloorLayoutLocked {
				fail(w, r, s.log, domain.Forbidden("layout_locked", "Floor layouts are locked and can’t be edited."))
				return
			}
			h(w, r, a)
		}
	}
	write("POST /api/v1/floors", auth.PermManageFloors, layout(s.postFloor))
	write("PATCH /api/v1/floors/{id}", auth.PermManageFloors, s.patchFloor)
	write("DELETE /api/v1/floors/{id}", auth.PermManageFloors, s.deleteFloor)
	write("POST /api/v1/floors/{id}/duplicate", auth.PermManageFloors, layout(s.duplicateFloor))
	read("GET /api/v1/floors/{id}/draft", auth.PermManageFloors, s.getDraft)
	write("PUT /api/v1/floors/{id}/draft", auth.PermManageFloors, layout(s.saveDraft(false)))
	write("PATCH /api/v1/floors/{id}/draft", auth.PermManageFloors, layout(s.saveDraft(true)))
	write("DELETE /api/v1/floors/{id}/draft", auth.PermManageFloors, layout(s.discardDraft))
	write("POST /api/v1/floors/{id}/publish", auth.PermManageFloors, layout(s.publishFloor))
	write("POST /api/v1/floors/{id}/zones", auth.PermManageFloors, s.assignZone)
	write("PUT /api/v1/floors/{id}/seat-codes", auth.PermManageFloors, s.putSeatCodes)
	write("POST /api/v1/zones/move", auth.PermManageFloors, s.moveZone)
	write("POST /api/v1/zone-changes/{id}/undo", auth.PermManageFloors, s.undoZoneChange)
	write("PUT /api/v1/members/{id}/seat", auth.PermAssignSeat, s.putSeat)
}

func respond(w http.ResponseWriter, r *http.Request, s *Server, status int, v any, err error) {
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, status, v)
}

func (s *Server) getFloors(w http.ResponseWriter, r *http.Request, a store.Actor) {
	list, err := s.store.Floors(r.Context(), a)
	respond(w, r, s, http.StatusOK, list, err)
}

func (s *Server) getFloor(w http.ResponseWriter, r *http.Request, a store.Actor) {
	f, err := s.store.Floor(r.Context(), a, r.PathValue("id"))
	respond(w, r, s, http.StatusOK, f, err)
}

func (s *Server) postFloor(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.FloorInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	f, err := s.store.CreateFloor(r.Context(), a, in)
	respond(w, r, s, http.StatusCreated, f, err)
}

func (s *Server) patchFloor(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.FloorInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	if in.Template != "" || in.Elements != nil || in.Publish || in.Cols != nil || in.Rows != nil {
		fail(w, r, s.log, domain.BadRequest("Edit the layout through the draft and publish it."))
		return
	}
	f, err := s.store.UpdateFloor(r.Context(), a, r.PathValue("id"), in)
	respond(w, r, s, http.StatusOK, f, err)
}

func (s *Server) deleteFloor(w http.ResponseWriter, r *http.Request, a store.Actor) {
	err := s.store.DeleteFloor(r.Context(), a, r.PathValue("id"))
	respond(w, r, s, http.StatusOK, map[string]bool{"deleted": true}, err)
}

func (s *Server) duplicateFloor(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in struct {
		Name      string `json:"name"`
		KeepZones bool   `json:"keepZones"`
	}
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	f, err := s.store.DuplicateFloor(r.Context(), a, r.PathValue("id"), in.Name, in.KeepZones)
	respond(w, r, s, http.StatusCreated, f, err)
}

func (s *Server) getDraft(w http.ResponseWriter, r *http.Request, a store.Actor) {
	d, err := s.store.Draft(r.Context(), a, r.PathValue("id"))
	respond(w, r, s, http.StatusOK, d, err)
}

func (s *Server) saveDraft(patch bool) actorHandler {
	return func(w http.ResponseWriter, r *http.Request, a store.Actor) {
		var in domain.DraftInput
		if err := decode(r, &in); err != nil {
			fail(w, r, s.log, err)
			return
		}
		d, err := s.store.SaveDraft(r.Context(), a, r.PathValue("id"), in, patch)
		respond(w, r, s, http.StatusOK, d, err)
	}
}

func (s *Server) discardDraft(w http.ResponseWriter, r *http.Request, a store.Actor) {
	d, err := s.store.DiscardDraft(r.Context(), a, r.PathValue("id"))
	respond(w, r, s, http.StatusOK, d, err)
}

func (s *Server) publishFloor(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.PublishInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	res, err := s.store.PublishFloor(r.Context(), a, r.PathValue("id"), in)
	respond(w, r, s, http.StatusOK, res, err)
}

func (s *Server) assignZone(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.ZoneInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	res, err := s.store.AssignZone(r.Context(), a, r.PathValue("id"), in)
	respond(w, r, s, http.StatusOK, res, err)
}

func (s *Server) moveZone(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.ZoneMoveInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	res, err := s.store.MoveZone(r.Context(), a, in)
	respond(w, r, s, http.StatusOK, res, err)
}

func (s *Server) undoZoneChange(w http.ResponseWriter, r *http.Request, a store.Actor) {
	err := s.store.UndoZoneChange(r.Context(), a, r.PathValue("id"))
	respond(w, r, s, http.StatusOK, map[string]bool{"undone": true}, err)
}

func (s *Server) putSeat(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.SeatAssignInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	m, err := s.store.AssignSeat(r.Context(), a, r.PathValue("id"), in)
	respond(w, r, s, http.StatusOK, m, err)
}

func (s *Server) putSeatCodes(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.SeatCodesInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	res, err := s.store.SetSeatCodes(r.Context(), a, r.PathValue("id"), in)
	respond(w, r, s, http.StatusOK, res, err)
}
