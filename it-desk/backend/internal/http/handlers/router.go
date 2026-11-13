package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"itdesk/backend/internal/analytics"
	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/config"
	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
	mw "itdesk/backend/internal/http/middleware"
	"itdesk/backend/internal/realtime"
	"itdesk/backend/internal/store"
)

type Server struct {
	cfg   config.Config
	log   *slog.Logger
	db    *db.DB
	store *store.Store
	hub   *realtime.Hub
	// Login throttling (in-memory, per process) on top of the DB lockout.
	ipLimiter   *auth.Limiter // all attempts from one IP
	pairLimiter *auth.Limiter // failures for one IP+email (also covers unknown emails)
}

func New(cfg config.Config, log *slog.Logger, d *db.DB, st *store.Store) *Server {
	return &Server{cfg: cfg, log: log, db: d, store: st, hub: realtime.New(d, log),
		ipLimiter:   auth.NewLimiter(60, 15*time.Minute),
		pairLimiter: auth.NewLimiter(10, 15*time.Minute)}
}

// Handler builds the full middleware chain and routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)

	// Every API route names the permission it needs (deny by default) and
	// goes through s.guard. There is deliberately no sign-up endpoint:
	// accounts are created by an admin.
	read := func(pattern string, perm auth.Permission, h actorHandler) {
		mux.HandleFunc(pattern, s.guard(perm, routeOpts{}, h))
	}
	write := func(pattern string, perm auth.Permission, h actorHandler) {
		mux.HandleFunc(pattern, s.guard(perm, routeOpts{idempotent: true}, h))
	}
	secret := func(pattern string, perm auth.Permission, h actorHandler) { // response carries a one-time password: never cached
		mux.HandleFunc(pattern, s.guard(perm, routeOpts{}, h))
	}
	self := func(pattern string, h actorHandler) {
		mux.HandleFunc(pattern, s.guard(auth.PermSelf, routeOpts{duringPasswordChange: true}, h))
	}

	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	self("GET /api/v1/auth/me", s.me)
	self("POST /api/v1/auth/logout", s.logout)
	self("POST /api/v1/auth/change-password", s.changePassword)

	read("GET /api/v1/workspace", auth.PermViewWorkspace, s.getWorkspace)
	read("GET /api/v1/me", auth.PermSelf, s.getMe)
	write("PUT /api/v1/me/profile", auth.PermSelf, s.putProfile)
	read("GET /api/v1/settings", auth.PermSelf, s.getSettings)
	write("PUT /api/v1/settings", auth.PermSelf, s.putSettings)
	read("GET /api/v1/teams", auth.PermViewTeams, s.getTeams)
	s.floorRoutes(read, write)
	read("GET /api/v1/members", auth.PermViewMembers, s.getMembers)
	read("GET /api/v1/members/{id}", auth.PermViewMembers, s.getMember)
	read("GET /api/v1/members/{id}/detail", auth.PermViewMembers, s.getMemberDetail)
	write("POST /api/v1/members", auth.PermManageMembers, s.postMember)
	write("PATCH /api/v1/members/{id}", auth.PermManageMembers, s.patchMember)
	read("GET /api/v1/transfers", auth.PermViewTransfers, s.getTransfers)
	read("GET /api/v1/transfers/{id}", auth.PermViewTransfers, s.getTransfer)
	write("POST /api/v1/transfers", auth.PermCreateTransfer, s.postTransfer)
	write("POST /api/v1/transfers/{id}/advance", auth.PermAdvanceTransfer, s.advanceTransfer)
	write("DELETE /api/v1/transfers/{id}", auth.PermUndoTransfer, s.cancelTransfer)
	read("GET /api/v1/exits", auth.PermViewExits, s.getExits)
	write("POST /api/v1/exits", auth.PermMarkExit, s.postExits)
	write("DELETE /api/v1/exits/batches/{batchId}", auth.PermUndoExit, s.undoExits)
	read("GET /api/v1/overview", auth.PermViewOverview, s.getOverview)
	read("GET /api/v1/activity", auth.PermViewActivity, s.getActivity)

	read("GET "+EventsPath, auth.PermSelf, s.events)
	read("GET /api/v1/notifications", auth.PermSelf, s.getNotifications)
	write("POST /api/v1/notifications/read-all", auth.PermSelf, s.readAllNotifications)
	write("POST /api/v1/notifications/{id}/read", auth.PermSelf, s.readNotification)
	write("POST /api/v1/transfers/{id}/acknowledge", auth.PermAdvanceTransfer, s.acknowledgeTransfer)
	write("POST /api/v1/it-requests/{id}/acknowledge", auth.PermFulfilRequest, s.requestAction(s.acknowledgeITRequest))

	read("GET /api/v1/it-requests", auth.PermViewRequests, s.getITRequests)
	write("POST /api/v1/it-requests", auth.PermCreateRequest, s.postITRequest)
	read("GET /api/v1/it-requests/assignees", auth.PermFulfilRequest, s.getRequestAssignees)
	read("GET /api/v1/it-requests/{id}", auth.PermViewRequests, s.getITRequest)
	write("POST /api/v1/it-requests/{id}/cancel", auth.PermCancelRequest, s.requestAction(s.cancelITRequest))
	write("POST /api/v1/it-requests/{id}/assign", auth.PermFulfilRequest, s.requestAction(s.assignITRequest))
	write("POST /api/v1/it-requests/{id}/status", auth.PermFulfilRequest, s.requestAction(s.moveITRequest))
	write("POST /api/v1/it-requests/{id}/reject", auth.PermFulfilRequest, s.requestAction(s.rejectITRequest))
	write("POST /api/v1/it-requests/{id}/comments", auth.PermCommentRequest, s.commentITRequest)
	// Routing to the IT staff directory: IT and admins (role checked in the store).
	write("POST /api/v1/it-requests/{id}/staff", auth.PermViewRequests, s.requestAction(s.routeITRequest))
	read("GET /api/v1/it-staff", auth.PermViewRequests, s.getITStaff)
	read("GET /api/v1/chats", auth.PermCommentRequest, s.getChats)
	read("GET /api/v1/chats/unread", auth.PermCommentRequest, s.getChatUnread)
	read("GET /api/v1/it-requests/{id}/messages", auth.PermCommentRequest, s.getChatMessages)
	read("GET /api/v1/it-requests/{id}/messages/{messageId}/files/{fileId}", auth.PermCommentRequest, s.getChatFile)
	write("POST /api/v1/it-requests/{id}/messages", auth.PermCommentRequest, s.postChatMessage)
	write("POST /api/v1/it-requests/{id}/messages/read", auth.PermCommentRequest, s.postChatRead)
	write("POST /api/v1/admin/it-staff", auth.PermManageUsers, s.postITStaff)
	write("PATCH /api/v1/admin/it-staff/{id}", auth.PermManageUsers, s.patchITStaff)

	read("GET /api/v1/admin/users", auth.PermManageUsers, s.listUsers)
	read("GET /api/v1/admin/users/{id}", auth.PermManageUsers, s.getUser)
	secret("POST /api/v1/admin/users", auth.PermManageUsers, s.createUser)
	write("PATCH /api/v1/admin/users/{id}", auth.PermManageUsers, s.updateUser)
	write("DELETE /api/v1/admin/users/{id}", auth.PermManageUsers, s.deleteUser)
	secret("POST /api/v1/admin/users/{id}/reset-password", auth.PermManageUsers, s.resetPassword)
	write("POST /api/v1/admin/users/{id}/disable", auth.PermManageUsers, s.setStatus(false))
	write("POST /api/v1/admin/users/{id}/enable", auth.PermManageUsers, s.setStatus(true))
	write("POST /api/v1/admin/users/{id}/revoke-sessions", auth.PermManageUsers, s.revokeSessions)

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, r, s.log, &domain.Error{Status: http.StatusNotFound, Code: "route_not_found", Message: "No such endpoint."})
	})

	return mw.Chain(mux,
		mw.RequestID,
		mw.Recover(s.log),
		mw.Logger(s.log),
		mw.SecureHeaders(s.cfg.CookieSecure),
		mw.CORS(s.cfg.AllowedOrigins),
		mw.OriginGuard(s.cfg.AllowedOrigins),
		mw.BodyLimit(12<<20), // chat screenshots travel as base64 inside the JSON body
		mw.Timeout(s.cfg.RequestTimeout, EventsPath), // the event stream is long-lived
	)
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "time": domain.NewTime(time.Now())})
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{"status": "ready", "database": "up", "schema": s.db.Schema}
	if !s.db.Ready() {
		body["status"], body["database"] = "starting", "connecting"
		if e := s.db.LastError(); e != "" {
			body["lastError"] = "database not reachable yet"
		}
		mw.RetryAfter(w, 2)
		writeJSON(w, http.StatusServiceUnavailable, body)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	start := time.Now()
	if err := s.store.Ping(ctx); err != nil {
		body["status"], body["database"] = "degraded", "down"
		mw.RetryAfter(w, 2)
		writeJSON(w, http.StatusServiceUnavailable, body)
		return
	}
	body["latencyMs"] = time.Since(start).Milliseconds()
	body["pool"] = s.store.PoolStats()
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) getWorkspace(w http.ResponseWriter, r *http.Request, a store.Actor) {
	ws, err := s.store.Workspace(r.Context(), a, r.URL.Query().Get("teamId"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ws.FloorLayoutLocked = s.cfg.FloorLayoutLocked
	ok(w, http.StatusOK, ws)
}

func (s *Server) getMe(w http.ResponseWriter, r *http.Request, a store.Actor) {
	ok(w, http.StatusOK, a.User)
}

func (s *Server) putProfile(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.ProfileInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	u, err := s.store.UpdateProfile(r.Context(), a, in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, u)
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request, a store.Actor) {
	st, err := s.store.Settings(r.Context(), a)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, st)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.Settings
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	st, err := s.store.UpdateSettings(r.Context(), a, in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, st)
}

func (s *Server) getTeams(w http.ResponseWriter, r *http.Request, _ store.Actor) {
	teams, err := s.store.Teams(r.Context())
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, teams)
}

var memberStatuses = map[string]bool{"": true, "active": true, "resigned": true, "unknown": true}

func (s *Server) getMembers(w http.ResponseWriter, r *http.Request, a store.Actor) {
	q := r.URL.Query()
	f := store.MemberFilter{TeamID: q.Get("teamId"), Status: q.Get("status"), Query: q.Get("q")}
	if !memberStatuses[f.Status] {
		fail(w, r, s.log, domain.Invalid("Invalid filter.", map[string]string{"status": "Use active, resigned or unknown"}))
		return
	}
	if f.TeamID == "all" {
		f.TeamID = ""
	}
	// Team leads are pinned to their own team inside the store, whatever
	// teamId the client asks for.
	list, err := s.store.Members(r.Context(), a, f)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

func (s *Server) getMember(w http.ResponseWriter, r *http.Request, a store.Actor) {
	m, err := s.store.Member(r.Context(), a, r.PathValue("id"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, m)
}

// getMemberDetail: the member plus timestamps and history (transfers, desk
// moves, exits, IT requests). Team leads get 404 outside their own team.
func (s *Server) getMemberDetail(w http.ResponseWriter, r *http.Request, a store.Actor) {
	d, err := s.store.MemberDetail(r.Context(), a, r.PathValue("id"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, d)
}

var directions = map[string]bool{"": true, "in": true, "out": true, "internal": true}
var itStatuses = map[string]bool{"": true, "requested": true, "scheduled": true, "moved": true, "completed": true}

func (s *Server) getTransfers(w http.ResponseWriter, r *http.Request, a store.Actor) {
	q := r.URL.Query()
	f := store.TransferFilter{Direction: q.Get("direction"), Status: q.Get("status"), Query: q.Get("q"), TeamID: q.Get("teamId"), Limit: 50}
	fields := map[string]string{}
	if !directions[f.Direction] {
		fields["direction"] = "Use in, out or internal"
	}
	if !itStatuses[f.Status] {
		fields["status"] = "Use requested, scheduled, moved or completed"
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
	page, err := s.store.Transfers(r.Context(), a, f)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, page)
}

func (s *Server) getTransfer(w http.ResponseWriter, r *http.Request, a store.Actor) {
	t, err := s.store.Transfer(r.Context(), a, r.PathValue("id"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, t)
}

func (s *Server) postTransfer(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.TransferInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	res, err := s.store.CreateTransfer(r.Context(), a, in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusCreated, res)
}

func (s *Server) advanceTransfer(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in struct {
		From string `json:"from"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &in); err != nil {
			fail(w, r, s.log, err)
			return
		}
	}
	t, err := s.store.AdvanceTransfer(r.Context(), a, r.PathValue("id"), in.From)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, t)
}

func (s *Server) cancelTransfer(w http.ResponseWriter, r *http.Request, a store.Actor) {
	res, err := s.store.CancelTransfer(r.Context(), a, r.PathValue("id"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, res)
}

func (s *Server) getExits(w http.ResponseWriter, r *http.Request, a store.Actor) {
	list, err := s.store.Exits(r.Context(), a)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

func (s *Server) postExits(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.ExitInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	res, err := s.store.MarkExit(r.Context(), a, in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusCreated, res)
}

func (s *Server) undoExits(w http.ResponseWriter, r *http.Request, a store.Actor) {
	res, err := s.store.UndoExitBatch(r.Context(), a, r.PathValue("batchId"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, res)
}

func (s *Server) getOverview(w http.ResponseWriter, r *http.Request, a store.Actor) {
	ws, err := s.store.Workspace(r.Context(), a, r.URL.Query().Get("teamId"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, analytics.Compute(ws, s.store.Now()))
}

func (s *Server) getActivity(w http.ResponseWriter, r *http.Request, _ store.Actor) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			fail(w, r, s.log, domain.Invalid("Invalid filter.", map[string]string{"limit": "Use 1–200"}))
			return
		}
		limit = n
	}
	list, err := s.store.Activity(r.Context(), limit)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

func (s *Server) postMember(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.MemberInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	m, err := s.store.CreateMember(r.Context(), a, in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusCreated, m)
}

func (s *Server) patchMember(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.MemberInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	m, err := s.store.UpdateMember(r.Context(), a, r.PathValue("id"), in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, m)
}
