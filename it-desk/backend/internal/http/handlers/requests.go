package handlers

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"

	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/store"
)

// IT requests (equipment asks and reported issues, separate from transfers).
//
//	GET    /api/v1/it-requests                 list (scoped) + per-status counts; ?type=equipment|issue
//	POST   /api/v1/it-requests                 raise a request or report an issue (admin, team lead)
//	GET    /api/v1/it-requests/assignees       IT accounts to assign to (IT)
//	GET    /api/v1/it-requests/{id}            one request with its timeline
//	POST   /api/v1/it-requests/{id}/cancel     requester withdraws while open
//	POST   /api/v1/it-requests/{id}/assign     IT: claim / assign / unassign
//	POST   /api/v1/it-requests/{id}/staff      IT, admin: route to an IT staff directory entry ("" clears)
//	POST   /api/v1/it-requests/{id}/status     IT: start, hand back, resolve, reopen
//	POST   /api/v1/it-requests/{id}/reject     IT: reject with a reason
//	POST   /api/v1/it-requests/{id}/comments   comment (anyone who can see it)

var requestSorts = map[string]bool{"": true, "newest": true, "priority": true}

func (s *Server) getITRequests(w http.ResponseWriter, r *http.Request, a store.Actor) {
	q := r.URL.Query()
	f := store.RequestFilter{Status: q.Get("status"), Type: q.Get("type"), Query: q.Get("q"), TeamID: q.Get("teamId"),
		Assignee: q.Get("assignee"), Mine: q.Get("mine") == "true", Sort: q.Get("sort")}
	fields := map[string]string{}
	if f.Status != "" && f.Status != "active" && f.Status != "closed" && !domain.IsRequestStatus(f.Status) {
		fields["status"] = "Use active, closed, open, in_progress, resolved, cancelled or rejected"
	}
	if f.Type != "" && !domain.IsRequestType(f.Type) {
		fields["type"] = "Use equipment or issue"
	}
	if !requestSorts[f.Sort] {
		fields["sort"] = "Use newest or priority"
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			fields["limit"] = "Use 1–200"
		}
		f.Limit = n
	}
	if v := q.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			fields["offset"] = "Use a non-negative number"
		}
		f.Offset = n
	}
	if len(fields) > 0 {
		fail(w, r, s.log, domain.Invalid("Invalid filter.", fields))
		return
	}
	list, err := s.store.ITRequests(r.Context(), a, f)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

func (s *Server) getITRequest(w http.ResponseWriter, r *http.Request, a store.Actor) {
	d, err := s.store.ITRequest(r.Context(), a, r.PathValue("id"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, d)
}

func (s *Server) postITRequest(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.ITRequestInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	d, err := s.store.CreateITRequest(r.Context(), a, in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	s.log.Info("it request created", "ticket", d.Ticket, "user", a.User.ID, "request_id", a.RequestID)
	ok(w, http.StatusCreated, d)
}

func (s *Server) getRequestAssignees(w http.ResponseWriter, r *http.Request, _ store.Actor) {
	list, err := s.store.RequestAssignees(r.Context())
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

// requestActionBody is shared by cancel / status / reject / assign.
type requestActionBody struct {
	ExpectedVersion *int   `json:"expectedVersion"`
	Status          string `json:"status"`
	Note            string `json:"note"`
	Reason          string `json:"reason"`
	AssigneeID      string `json:"assigneeId"`
	StaffID         string `json:"staffId"`
}

func (s *Server) requestAction(fn func(r *http.Request, a store.Actor, id string, in requestActionBody) (domain.ITRequestDetail, error)) actorHandler {
	return func(w http.ResponseWriter, r *http.Request, a store.Actor) {
		var in requestActionBody
		if r.ContentLength != 0 {
			if err := decode(r, &in); err != nil {
				fail(w, r, s.log, err)
				return
			}
		}
		d, err := fn(r, a, r.PathValue("id"), in)
		if err != nil {
			fail(w, r, s.log, err)
			return
		}
		ok(w, http.StatusOK, d)
	}
}

func (s *Server) cancelITRequest(r *http.Request, a store.Actor, id string, in requestActionBody) (domain.ITRequestDetail, error) {
	return s.store.CancelITRequest(r.Context(), a, id, store.RequestAction{ExpectedVersion: in.ExpectedVersion, Note: in.Reason})
}

func (s *Server) assignITRequest(r *http.Request, a store.Actor, id string, in requestActionBody) (domain.ITRequestDetail, error) {
	return s.store.AssignITRequest(r.Context(), a, id, in.AssigneeID, store.RequestAction{ExpectedVersion: in.ExpectedVersion})
}

func (s *Server) routeITRequest(r *http.Request, a store.Actor, id string, in requestActionBody) (domain.ITRequestDetail, error) {
	return s.store.RouteITRequest(r.Context(), a, id, in.StaffID, store.RequestAction{ExpectedVersion: in.ExpectedVersion})
}

func (s *Server) moveITRequest(r *http.Request, a store.Actor, id string, in requestActionBody) (domain.ITRequestDetail, error) {
	return s.store.MoveITRequest(r.Context(), a, id, in.Status, store.RequestAction{ExpectedVersion: in.ExpectedVersion, Note: in.Note})
}

func (s *Server) rejectITRequest(r *http.Request, a store.Actor, id string, in requestActionBody) (domain.ITRequestDetail, error) {
	return s.store.RejectITRequest(r.Context(), a, id, store.RequestAction{ExpectedVersion: in.ExpectedVersion, Note: in.Reason})
}

func (s *Server) commentITRequest(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in struct {
		Body string `json:"body"`
	}
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	d, err := s.store.CommentITRequest(r.Context(), a, r.PathValue("id"), in.Body)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusCreated, d)
}

// IT staff directory.
//
//	GET    /api/v1/it-staff                    active staff (anyone who can see requests); ?all=true for admins
//	POST   /api/v1/admin/it-staff              add someone (admin)
//	PATCH  /api/v1/admin/it-staff/{id}         edit / (de)activate / link a login via userId ("" unlinks) (admin)

func (s *Server) getITStaff(w http.ResponseWriter, r *http.Request, a store.Actor) {
	list, err := s.store.ITStaffList(r.Context(), a, r.URL.Query().Get("all") == "true")
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

func (s *Server) postITStaff(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.ITStaffInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	st, err := s.store.CreateITStaff(r.Context(), a, in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusCreated, st)
}

func (s *Server) patchITStaff(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.ITStaffInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	st, err := s.store.UpdateITStaff(r.Context(), a, r.PathValue("id"), in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, st)
}

// Request chat (one conversation per request).
//
//	GET  /api/v1/chats                          conversations in scope (?status=active|closed&assigned=me|none&q=)
//	GET  /api/v1/chats/unread                   nav badge totals
//	GET  /api/v1/it-requests/{id}/messages      header + messages (?after=<message id> for polling)
//	POST /api/v1/it-requests/{id}/messages      send {body, as?}
//	POST /api/v1/it-requests/{id}/messages/read mark read for the caller's side

func (s *Server) getChats(w http.ResponseWriter, r *http.Request, a store.Actor) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	list, err := s.store.Chats(r.Context(), a, store.ChatFilter{Status: q.Get("status"), Assigned: q.Get("assigned"), Query: q.Get("q"), Limit: limit})
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

func (s *Server) getChatUnread(w http.ResponseWriter, r *http.Request, a store.Actor) {
	u, err := s.store.ChatUnread(r.Context(), a)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, u)
}

func (s *Server) getChatMessages(w http.ResponseWriter, r *http.Request, a store.Actor) {
	m, err := s.store.ChatMessages(r.Context(), a, r.PathValue("id"), r.URL.Query().Get("after"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, m)
}

func (s *Server) postChatMessage(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in struct {
		Body   string `json:"body"`
		As     string `json:"as"`
		Images []struct {
			Name string `json:"name"`
			Data string `json:"data"`
		} `json:"images"`
	}
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	files := make([]domain.ChatFileIn, 0, len(in.Images))
	for _, img := range in.Images {
		raw, err := decodeChatImage(img.Data)
		if err != nil {
			fail(w, r, s.log, err)
			return
		}
		files = append(files, domain.ChatFileIn{Name: img.Name, Data: raw})
	}
	m, err := s.store.PostChatMessage(r.Context(), a, r.PathValue("id"), in.Body, in.As, files)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusCreated, m)
}

func decodeChatImage(data string) ([]byte, *domain.Error) {
	data = strings.TrimSpace(data)
	if i := strings.Index(data, ","); i >= 0 && strings.Contains(data[:i], "base64") {
		data = data[i+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil || len(raw) == 0 {
		return nil, domain.Invalid("Please fix the highlighted fields.", map[string]string{"images": "That image could not be read"})
	}
	return raw, nil
}

func (s *Server) getChatFile(w http.ResponseWriter, r *http.Request, a store.Actor) {
	name, ctype, data, err := s.store.ChatFile(r.Context(), a, r.PathValue("id"), r.PathValue("messageId"), r.PathValue("fileId"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	disp := "inline"
	if r.URL.Query().Get("download") == "1" {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", disp+`; filename="`+strings.ReplaceAll(name, `"`, "")+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) postChatRead(w http.ResponseWriter, r *http.Request, a store.Actor) {
	u, err := s.store.MarkChatRead(r.Context(), a, r.PathValue("id"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, u)
}
