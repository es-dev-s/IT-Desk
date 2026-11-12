package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/realtime"
	"itdesk/backend/internal/store"
)

// EventsPath is the SSE endpoint (exempt from the request timeout).
const EventsPath = "/api/v1/events"

const (
	sseHeartbeat    = 20 * time.Second
	sseRecheck      = 60 * time.Second
	sseWriteTimeout = 15 * time.Second
	sseReplayLimit  = 200
)

// Hub returns the server's real-time hub (main runs it).
func (s *Server) Hub() *realtime.Hub { return s.hub }

// events is GET /api/v1/events: a Server-Sent Events stream for the
// signed-in user. Authenticated by the session cookie like every other
// route (EventSource sends cookies with withCredentials). Each notification
// is an event whose id is the notification id, so the browser's
// Last-Event-ID (or ?lastEventId= on a manual reconnect) resumes exactly
// where the client left off. "entity" events tell the client to refresh
// something it can see; they carry no id and are reconciled by a refetch
// after any reconnect.
func (s *Server) events(w http.ResponseWriter, r *http.Request, a store.Actor) {
	rc := http.NewResponseController(w)
	// The server's read/write timeouts suit short requests; a stream clears
	// them and sets a write deadline per event instead (a stuck client is
	// dropped after sseWriteTimeout).
	_ = rc.SetReadDeadline(time.Time{})
	last := parseEventID(r.Header.Get("Last-Event-ID"))
	if last == 0 {
		last = parseEventID(r.URL.Query().Get("lastEventId"))
	}
	// Subscribe before replaying so nothing slips between the two; replayed
	// ids are skipped if they also arrive live.
	sub := s.hub.Subscribe(a.User.ID, a.User.Role, a.User.TeamID)
	defer s.hub.Unsubscribe(sub)

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	write := func(id int64, event string, data any) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
		var raw []byte
		switch v := data.(type) {
		case json.RawMessage:
			raw = v
		default:
			b, err := json.Marshal(v)
			if err != nil {
				return false
			}
			raw = b
		}
		var sb strings.Builder
		if id > 0 {
			fmt.Fprintf(&sb, "id: %d\n", id)
		}
		fmt.Fprintf(&sb, "event: %s\ndata: %s\n\n", event, raw)
		if _, err := w.Write([]byte(sb.String())); err != nil {
			return false
		}
		return rc.Flush() == nil
	}

	_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
	if _, err := w.Write([]byte("retry: 3000\n\n")); err != nil {
		return
	}

	// Missed notifications are replayed from the log. Entity changes are not
	// logged, so a resuming client is told to refetch its lists (resync).
	maxSent := last
	resync := last > 0
	if last > 0 {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		missed, _ := s.store.NotificationsSince(ctx, a.User.ID, last, sseReplayLimit)
		cancel()
		for _, n := range missed {
			if !write(n.ID, realtime.TypeNotification, n) {
				return
			}
			maxSent = n.ID
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	unread, _ := s.store.UnreadCount(ctx, a.User.ID)
	cancel()
	if !write(0, "ready", map[string]any{"userId": a.User.ID, "unread": unread, "resumed": last > 0, "resync": resync,
		"lastEventId": maxSent, "serverTime": domain.NewTime(time.Now()), "heartbeatSeconds": int(sseHeartbeat.Seconds())}) {
		return
	}

	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()
	recheck := time.NewTicker(sseRecheck)
	defer recheck.Stop()
	tok := auth.HashToken(s.sessionToken(r))
	// checkSession reports whether the stream may continue.
	checkSession := func() bool {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		p, err := s.store.SessionStillValid(ctx, tok, s.cfg.SessionIdleTimeout)
		cancel()
		if err != nil {
			if de, ok := domain.AsError(err); ok && de.Status == http.StatusUnauthorized {
				write(0, "session", map[string]any{"valid": false})
				return false
			}
			return true // transient DB error: keep the stream
		}
		if p.User.Role != a.User.Role || p.User.TeamID != a.User.TeamID || p.MustChangePassword {
			// Role or team changed: reconnect so filtering matches.
			write(0, "reconnect", map[string]string{"reason": "session_changed"})
			return false
		}
		return true
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.Done():
			// Dropped (slow consumer, too many tabs, shutdown): tell the
			// client why; it reconnects and resumes from its last id.
			write(0, "reconnect", map[string]string{"reason": sub.Reason()})
			return
		case ev := <-sub.C:
			if ev.Type == realtime.TypeSession {
				// An admin changed this account: re-check right away so a
				// disabled or signed-out user's tabs close live.
				if !checkSession() {
					return
				}
				continue
			}
			if ev.ID > 0 {
				if ev.ID <= maxSent {
					continue
				}
				maxSent = ev.ID
			}
			if !write(ev.ID, ev.Type, ev.Data) {
				return
			}
		case <-heartbeat.C:
			if !write(0, "ping", map[string]any{"t": domain.NewTime(time.Now()), "live": s.hub.Listening()}) {
				return
			}
		case <-recheck.C:
			if !checkSession() {
				return
			}
		}
	}
}

func parseEventID(v string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// ---- notifications -----------------------------------------------------------

func (s *Server) getNotifications(w http.ResponseWriter, r *http.Request, a store.Actor) {
	q := r.URL.Query()
	before := parseEventID(q.Get("before"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	page, err := s.store.Notifications(r.Context(), a, before, limit, q.Get("unread") == "true")
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, page)
}

func (s *Server) readNotification(w http.ResponseWriter, r *http.Request, a store.Actor) {
	id := parseEventID(r.PathValue("id"))
	if id == 0 {
		fail(w, r, s.log, domain.NotFound("Notification not found."))
		return
	}
	res, err := s.store.MarkNotificationRead(r.Context(), a, id)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, res)
}

func (s *Server) readAllNotifications(w http.ResponseWriter, r *http.Request, a store.Actor) {
	res, err := s.store.MarkAllNotificationsRead(r.Context(), a)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, res)
}

// ---- acknowledgements ----------------------------------------------------------

func (s *Server) acknowledgeTransfer(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in struct {
		ExpectedVersion *int `json:"expectedVersion"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &in); err != nil {
			fail(w, r, s.log, err)
			return
		}
	}
	t, err := s.store.AcknowledgeTransfer(r.Context(), a, r.PathValue("id"), in.ExpectedVersion)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, t)
}

func (s *Server) acknowledgeITRequest(r *http.Request, a store.Actor, id string, in requestActionBody) (domain.ITRequestDetail, error) {
	return s.store.AcknowledgeITRequest(r.Context(), a, id, store.RequestAction{ExpectedVersion: in.ExpectedVersion})
}
