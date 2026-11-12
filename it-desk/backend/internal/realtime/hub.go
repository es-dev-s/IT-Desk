// Package realtime fans server events out to connected browsers.
//
// Writers (the store) queue an Envelope with pg_notify inside the same
// transaction as the change, so Postgres delivers it only on commit and every
// API process sees it. Each process runs one Hub that LISTENs on a dedicated
// connection and routes envelopes to its in-memory subscribers (one per open
// SSE stream), filtered per recipient and by team scope.
package realtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/db"
)

// Envelope types.
const (
	TypeNotification = "notification" // one user's new notification (has ID)
	TypeEntity       = "entity"       // something changed; refresh it if you can see it
	TypeRead         = "read"         // a user's notifications were marked read (sync other tabs)
	TypeResync       = "resync"       // events may have been missed: refetch everything
	// TypeSession tells one user's open streams to re-check their session
	// now (account disabled, signed out everywhere, role changed, deleted).
	TypeSession = "session_check"
)

// Envelope travels over pg_notify (keep it well under 8000 bytes).
type Envelope struct {
	Type      string `json:"t"`
	Recipient string `json:"r,omitempty"` // notification / read
	ID        int64  `json:"id,omitempty"`
	// Teams scopes entity events for team leads: a lead receives the event
	// only if their team is listed. Admins and IT receive every entity event.
	Teams []string `json:"teams,omitempty"`
	// Roles, when set, limits an entity event to these roles (e.g. account
	// changes go to admins only). Applied before the team scope.
	Roles []string `json:"roles,omitempty"`
	// Broadcast delivers an entity event to every role, team leads included
	// (published floor plans and their occupancy are visible to everyone).
	Broadcast bool            `json:"b,omitempty"`
	Data      json.RawMessage `json:"d"`
}

// Event is what a subscriber receives.
type Event struct {
	ID   int64
	Type string
	Data json.RawMessage
}

// Subscriber is one open stream.
type Subscriber struct {
	UserID string
	Role   string
	TeamID string
	C      chan Event

	created time.Time
	done    chan struct{}
	once    sync.Once
	reason  atomic.Value // string
}

// Done is closed when the hub drops the subscriber (slow consumer, eviction
// or shutdown). The stream should end; the client reconnects and resumes.
func (s *Subscriber) Done() <-chan struct{} { return s.done }

// Reason says why the subscriber was dropped.
func (s *Subscriber) Reason() string {
	v, _ := s.reason.Load().(string)
	return v
}

func (s *Subscriber) drop(reason string) {
	s.once.Do(func() {
		s.reason.Store(reason)
		close(s.done)
	})
}

func (s *Subscriber) sees(env Envelope) bool {
	switch env.Type {
	case TypeNotification, TypeRead, TypeSession:
		return env.Recipient == s.UserID
	case TypeEntity:
		if len(env.Roles) > 0 && !slices.Contains(env.Roles, s.Role) {
			return false
		}
		if s.Role != "team_lead" || env.Broadcast {
			return true
		}
		return s.TeamID != "" && slices.Contains(env.Teams, s.TeamID)
	case TypeResync:
		return true
	}
	return false
}

// Hub routes envelopes to subscribers.
type Hub struct {
	db         *db.DB
	channel    string
	log        *slog.Logger
	buffer     int
	maxPerUser int

	mu        sync.Mutex
	subs      map[string]map[*Subscriber]struct{}
	closed    bool
	listening atomic.Bool
	done      chan struct{}
	closeOnce sync.Once
}

// New creates a hub for the database's event channel. Call Run to start it.
func New(d *db.DB, log *slog.Logger) *Hub {
	return &Hub{db: d, channel: d.EventChannel(), log: log, buffer: 64, maxPerUser: 8,
		subs: map[string]map[*Subscriber]struct{}{}, done: make(chan struct{})}
}

// Listening reports whether the LISTEN connection is up.
func (h *Hub) Listening() bool { return h.listening.Load() }

// Done is closed when the hub shuts down.
func (h *Hub) Done() <-chan struct{} { return h.done }

// Subscribe registers a stream. A user may hold maxPerUser streams; opening
// one more evicts their oldest (a forgotten tab must not pin resources).
func (h *Hub) Subscribe(userID, role, teamID string) *Subscriber {
	s := &Subscriber{UserID: userID, Role: role, TeamID: teamID, C: make(chan Event, h.buffer),
		created: time.Now(), done: make(chan struct{})}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		s.drop("shutdown")
		return s
	}
	set := h.subs[userID]
	if set == nil {
		set = map[*Subscriber]struct{}{}
		h.subs[userID] = set
	}
	for len(set) >= h.maxPerUser {
		var oldest *Subscriber
		for o := range set {
			if oldest == nil || o.created.Before(oldest.created) {
				oldest = o
			}
		}
		oldest.drop("evicted")
		delete(set, oldest)
	}
	set[s] = struct{}{}
	return s
}

// Unsubscribe removes a stream.
func (h *Hub) Unsubscribe(s *Subscriber) {
	h.mu.Lock()
	if set := h.subs[s.UserID]; set != nil {
		delete(set, s)
		if len(set) == 0 {
			delete(h.subs, s.UserID)
		}
	}
	h.mu.Unlock()
	s.drop("closed")
}

// Count returns the number of open streams (for tests and metrics).
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, set := range h.subs {
		n += len(set)
	}
	return n
}

// Deliver routes one envelope. It never blocks: a subscriber whose buffer
// is full is dropped (backpressure); its client reconnects with
// Last-Event-ID and replays from the notification log.
func (h *Hub) Deliver(env Envelope) {
	ev := Event{ID: env.ID, Type: env.Type, Data: env.Data}
	h.mu.Lock()
	var targets []*Subscriber
	if env.Type == TypeNotification || env.Type == TypeRead || env.Type == TypeSession {
		for s := range h.subs[env.Recipient] {
			targets = append(targets, s)
		}
	} else {
		for _, set := range h.subs {
			for s := range set {
				if s.sees(env) {
					targets = append(targets, s)
				}
			}
		}
	}
	h.mu.Unlock()
	for _, s := range targets {
		select {
		case <-s.done:
		case s.C <- ev:
		default:
			s.drop("slow_consumer")
			h.Unsubscribe(s)
		}
	}
}

// Close drops every subscriber so open streams end (used on shutdown).
func (h *Hub) Close() {
	h.closeOnce.Do(func() {
		h.mu.Lock()
		h.closed = true
		for _, set := range h.subs {
			for s := range set {
				s.drop("shutdown")
			}
		}
		h.subs = map[string]map[*Subscriber]struct{}{}
		h.mu.Unlock()
		close(h.done)
	})
}

// Run LISTENs until ctx ends, reconnecting with backoff. After a reconnect
// it broadcasts a resync so clients refetch whatever they might have missed.
func (h *Hub) Run(ctx context.Context) {
	defer h.Close()
	backoff := time.Second
	first := true
	for ctx.Err() == nil {
		if !h.db.Ready() {
			if !sleep(ctx, 500*time.Millisecond) {
				return
			}
			continue
		}
		err := h.listen(ctx, func() {
			backoff = time.Second
			if !first {
				h.Deliver(Envelope{Type: TypeResync, Data: json.RawMessage(`{"reason":"reconnected"}`)})
			}
			first = false
		})
		h.listening.Store(false)
		if ctx.Err() != nil {
			return
		}
		h.log.Warn("realtime listener lost; reconnecting", "err", err, "in", backoff.String())
		if !sleep(ctx, backoff) {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (h *Hub) listen(ctx context.Context, onUp func()) error {
	cfg := h.db.Pool.Config().ConnConfig.Copy()
	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, err := pgx.ConnectConfig(connectCtx, cfg)
	cancel()
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{h.channel}.Sanitize()); err != nil {
		return err
	}
	h.listening.Store(true)
	h.log.Info("realtime listener up", "channel", h.channel)
	onUp()
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var env Envelope
		if err := json.Unmarshal([]byte(n.Payload), &env); err != nil {
			h.log.Warn("realtime: bad payload", "err", err)
			continue
		}
		h.Deliver(env)
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
