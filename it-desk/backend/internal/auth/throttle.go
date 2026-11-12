package auth

import (
	"math"
	"sync"
	"time"
)

// Lockout policy: after FreeAttempts consecutive failures the account is
// locked for 1 minute, doubling with each further failure, capped at MaxLock.
const (
	FreeAttempts = 5
	BaseLock     = time.Minute
	MaxLock      = time.Hour
)

// LockDuration returns how long to lock an account that has now failed
// `failures` times in a row (0 = no lock).
func LockDuration(failures int) time.Duration {
	if failures < FreeAttempts {
		return 0
	}
	exp := failures - FreeAttempts
	if exp > 10 {
		exp = 10
	}
	d := time.Duration(float64(BaseLock) * math.Pow(2, float64(exp)))
	if d > MaxLock {
		d = MaxLock
	}
	return d
}

// Limiter is a fixed-window in-memory counter used to throttle login attempts
// per IP+email and per IP (defence in depth on top of the DB lockout, and it
// also covers unknown emails). Safe for concurrent use; stale entries are
// pruned opportunistically.
type Limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string]*window
	now    func() time.Time
	ops    int
}

type window struct {
	start time.Time
	count int
}

func NewLimiter(max int, per time.Duration) *Limiter {
	return &Limiter{max: max, window: per, hits: map[string]*window{}, now: time.Now}
}

// Blocked reports whether key is over the limit, and for how long.
func (l *Limiter) Blocked(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	w := l.hits[key]
	if w == nil || now.Sub(w.start) >= l.window {
		return false, 0
	}
	if w.count >= l.max {
		return true, w.start.Add(l.window).Sub(now)
	}
	return false, 0
}

// Hit records one attempt for key.
func (l *Limiter) Hit(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.ops++
	if l.ops%256 == 0 {
		for k, w := range l.hits {
			if now.Sub(w.start) >= l.window {
				delete(l.hits, k)
			}
		}
	}
	w := l.hits[key]
	if w == nil || now.Sub(w.start) >= l.window {
		l.hits[key] = &window{start: now, count: 1}
		return
	}
	w.count++
}

// Reset clears key (after a successful login).
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}

// SetClock is for tests.
func (l *Limiter) SetClock(now func() time.Time) { l.now = now }

// SessionState says whether a session is usable at `now`.
func SessionValid(lastSeen, expires time.Time, revoked bool, idle time.Duration, now time.Time) bool {
	if revoked || !now.Before(expires) {
		return false
	}
	return idle <= 0 || now.Sub(lastSeen) < idle
}
