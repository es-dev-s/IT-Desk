package handlers

import (
	"context"
	"fmt"
	"math"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/config"
	"itdesk/backend/internal/domain"
	mw "itdesk/backend/internal/http/middleware"
	"itdesk/backend/internal/store"
)

const (
	cookieName       = "itdesk_session"
	secureCookieName = "__Host-itdesk_session" // __Host- requires Secure, Path=/ and no Domain
	csrfHeader       = "X-CSRF-Token"
)

func (s *Server) cookieName() string {
	if s.cfg.CookieSecure {
		return secureCookieName
	}
	return cookieName
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: s.cookieName(), Value: token, Path: "/", Expires: expires, MaxAge: int(time.Until(expires).Seconds()),
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: s.cookieName(), Value: "", Path: "/", MaxAge: -1,
		Expires: time.Unix(0, 0), HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteLaxMode})
}

func (s *Server) sessionToken(r *http.Request) string {
	c, err := r.Cookie(s.cookieName())
	if err != nil || !auth.PlausibleToken(c.Value) {
		return ""
	}
	return c.Value
}

// clientIP is the address rate limiting and lockout key on. It is the TCP
// peer, unless that peer is a trusted proxy (TRUSTED_PROXIES, default
// loopback — the web server's /api proxy, which overwrites X-Forwarded-For
// with the real browser address). Then the right-most X-Forwarded-For entry
// that isn't itself a trusted proxy wins, so a client can't spoof its way out
// of a lockout by sending its own header. TRUST_PROXY=true keeps the old
// "left-most entry from any peer" behaviour for setups that need it.
func (s *Server) clientIP(r *http.Request) string {
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peer = r.RemoteAddr
	}
	xff := r.Header.Values("X-Forwarded-For")
	if len(xff) == 0 {
		return peer
	}
	hops := strings.Split(strings.Join(xff, ","), ",")
	if s.cfg.TrustProxy {
		if ip := strings.TrimSpace(hops[0]); net.ParseIP(ip) != nil {
			return ip
		}
		return peer
	}
	if !config.Trusted(s.cfg.TrustedProxies, peer) {
		return peer
	}
	for i := len(hops) - 1; i >= 0; i-- {
		ip := strings.TrimSpace(hops[i])
		if net.ParseIP(ip) == nil {
			break
		}
		if !config.Trusted(s.cfg.TrustedProxies, ip) || i == 0 {
			return ip
		}
	}
	return peer
}

var (
	errInvalidCredentials = &domain.Error{Status: http.StatusUnauthorized, Code: "invalid_credentials", Message: "Email or password is incorrect."}
	errForbidden          = domain.Forbidden("forbidden", "You don't have permission to do that.")
	errCSRF               = domain.Forbidden("csrf_failed", "Your security token is missing or out of date. Refresh the page and try again.")
	errMustChange         = domain.Forbidden("password_change_required", "Set a new password to continue.")
)

func tooMany(w http.ResponseWriter, wait time.Duration) *domain.Error {
	secs := int(math.Ceil(wait.Seconds()))
	if secs < 1 {
		secs = 1
	}
	mw.RetryAfter(w, secs)
	when := "in a minute"
	if mins := int(math.Ceil(float64(secs) / 60)); mins > 1 {
		when = fmt.Sprintf("in %d minutes", mins)
	} else if secs < 60 {
		when = fmt.Sprintf("in %d seconds", secs)
	}
	return &domain.Error{Status: http.StatusTooManyRequests, Code: "too_many_attempts",
		Message: "Too many sign-in attempts. Try again " + when + "."}
}

type routeOpts struct {
	idempotent bool
	// allowed while the account still has to replace a temporary password
	duringPasswordChange bool
}

type actorHandler func(http.ResponseWriter, *http.Request, store.Actor)

// guard is the authorization gate every /api/v1 route goes through:
// database ready → valid session → CSRF token (writes) → forced password
// change → role policy. Anything not explicitly allowed is refused.
func (s *Server) guard(perm auth.Permission, opts routeOpts, h actorHandler) http.HandlerFunc {
	if perm == "" {
		panic("route registered without a permission")
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.db.Ready() {
			fail(w, r, s.log, domain.ErrUnavailable)
			return
		}
		p, err := s.principal(r)
		if err != nil {
			if de, ok := domain.AsError(err); ok && de.Status == http.StatusUnauthorized {
				s.clearSessionCookie(w)
			}
			fail(w, r, s.log, err)
			return
		}
		actor := store.Actor{User: p.User, RequestID: mw.RequestIDFrom(r.Context()), IP: s.clientIP(r)}
		if unsafeMethod(r.Method) && !auth.TokenMatches(r.Header.Get(csrfHeader), auth.HashToken(p.CSRFToken)) {
			s.log.Warn("csrf token rejected", "user", p.User.ID, "path", r.URL.Path, "request_id", actor.RequestID)
			fail(w, r, s.log, errCSRF)
			return
		}
		if p.MustChangePassword && !opts.duringPasswordChange {
			fail(w, r, s.log, errMustChange)
			return
		}
		if !auth.Can(auth.Role(p.User.Role), perm) {
			s.log.Warn("forbidden", "user", p.User.ID, "role", p.User.Role, "perm", perm, "method", r.Method,
				"path", r.URL.Path, "request_id", actor.RequestID)
			fail(w, r, s.log, errForbidden)
			return
		}
		ctx := context.WithValue(r.Context(), principalKey{}, p)
		r = r.WithContext(ctx)
		inner := func(w http.ResponseWriter, r *http.Request) { h(w, r, actor) }
		if opts.idempotent {
			s.idempotent(p.User.ID, inner)(w, r)
			return
		}
		inner(w, r)
	}
}

type principalKey struct{}

func principalFrom(r *http.Request) store.Principal {
	p, _ := r.Context().Value(principalKey{}).(store.Principal)
	return p
}

func unsafeMethod(m string) bool {
	return m != http.MethodGet && m != http.MethodHead && m != http.MethodOptions
}

func (s *Server) principal(r *http.Request) (store.Principal, error) {
	tok := s.sessionToken(r)
	if tok == "" {
		return store.Principal{}, domain.Unauthenticated("Please sign in to continue.")
	}
	return s.store.SessionPrincipal(r.Context(), auth.HashToken(tok), s.cfg.SessionIdleTimeout)
}

// ---- /auth endpoints --------------------------------------------------------

type sessionView struct {
	User               domain.User       `json:"user"`
	RoleLabel          string            `json:"roleLabel"`
	Permissions        []auth.Permission `json:"permissions"`
	CSRFToken          string            `json:"csrfToken"`
	MustChangePassword bool              `json:"mustChangePassword"`
	ExpiresAt          domain.Time       `json:"expiresAt"`
	IdleTimeoutSeconds int               `json:"idleTimeoutSeconds"`
}

func (s *Server) view(u domain.User, csrf string, mustChange bool, expires time.Time) sessionView {
	perms := auth.Permissions(auth.Role(u.Role))
	if perms == nil {
		perms = []auth.Permission{}
	}
	return sessionView{User: u, RoleLabel: auth.Role(u.Role).Label(), Permissions: perms, CSRFToken: csrf,
		MustChangePassword: mustChange, ExpiresAt: domain.NewTime(expires), IdleTimeoutSeconds: int(s.cfg.SessionIdleTimeout.Seconds())}
}

type loginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.db.Ready() {
		fail(w, r, s.log, domain.ErrUnavailable)
		return
	}
	var in loginInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	email := domain.NormalizeEmail(in.Email)
	fields := map[string]string{}
	if email == "" || len(email) > 254 || !strings.Contains(email, "@") {
		fields["email"] = "Enter your work email"
	}
	if in.Password == "" {
		fields["password"] = "Enter your password"
	} else if utf8.RuneCountInString(in.Password) > 1024 {
		fields["password"] = "Password is too long"
	}
	if len(fields) > 0 {
		fail(w, r, s.log, domain.Invalid("Check the highlighted fields.", fields))
		return
	}
	ip := s.clientIP(r)
	anon := store.Actor{User: domain.User{Name: email}, RequestID: mw.RequestIDFrom(r.Context()), IP: ip}
	ipKey, pairKey := "ip:"+ip, "pair:"+ip+"|"+email
	if blocked, wait := s.ipLimiter.Blocked(ipKey); blocked {
		_ = s.store.AuthEvent(r.Context(), anon, "auth.throttled", email, map[string]any{"scope": "ip"})
		fail(w, r, s.log, tooMany(w, wait))
		return
	}
	if blocked, wait := s.pairLimiter.Blocked(pairKey); blocked {
		_ = s.store.AuthEvent(r.Context(), anon, "auth.throttled", email, map[string]any{"scope": "ip+email"})
		fail(w, r, s.log, tooMany(w, wait))
		return
	}
	s.ipLimiter.Hit(ipKey)

	acct, found, err := s.store.AccountByEmail(r.Context(), email)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	now := s.store.Now()
	if found && acct.LockedUntil != nil && acct.LockedUntil.After(now) {
		auth.BurnTime(in.Password)
		s.pairLimiter.Hit(pairKey)
		_ = s.store.AuthEvent(r.Context(), anon, "auth.login_blocked", acct.User.ID, map[string]any{"reason": "locked"})
		fail(w, r, s.log, tooMany(w, acct.LockedUntil.Sub(now)))
		return
	}
	valid, rehash := false, false
	if found && acct.PasswordHash != "" {
		valid, rehash, err = auth.VerifyPassword(in.Password, acct.PasswordHash)
		if err != nil {
			s.log.Error("stored password hash is malformed", "user", acct.User.ID)
			valid = false
		}
	} else {
		auth.BurnTime(in.Password) // same cost as a real check: no account enumeration by timing
	}
	if !valid || acct.Status != "active" {
		s.pairLimiter.Hit(pairKey)
		if found && acct.Status == "active" && acct.PasswordHash != "" {
			locked, err := s.store.RecordLoginFailure(r.Context(), anon, acct.User.ID, now)
			if err != nil {
				fail(w, r, s.log, err)
				return
			}
			if locked != nil {
				fail(w, r, s.log, tooMany(w, locked.Sub(now)))
				return
			}
		} else {
			reason := "unknown_email"
			if found {
				reason = "account_" + acct.Status
				if acct.PasswordHash == "" {
					reason = "no_password"
				}
			}
			id := email
			if found {
				id = acct.User.ID
			}
			_ = s.store.AuthEvent(r.Context(), anon, "auth.login_failed", id, map[string]any{"reason": reason})
		}
		fail(w, r, s.log, errInvalidCredentials)
		return
	}

	token, tokenHash, err1 := auth.NewToken()
	csrf, _, err2 := auth.NewToken()
	if err1 != nil || err2 != nil {
		fail(w, r, s.log, fmt.Errorf("token generation failed"))
		return
	}
	newHash := ""
	if rehash {
		newHash, _ = auth.HashPassword(in.Password)
	}
	prev := ""
	if old := s.sessionToken(r); old != "" {
		prev = auth.HashToken(old)
	}
	expires := now.Add(s.cfg.SessionTTL)
	actor := store.Actor{User: acct.User, RequestID: anon.RequestID, IP: ip}
	if err := s.store.CompleteLogin(r.Context(), actor, store.NewSession{TokenHash: tokenHash, CSRFToken: csrf, IP: ip,
		UserAgent: r.UserAgent(), ExpiresAt: expires}, newHash, prev); err != nil {
		fail(w, r, s.log, err)
		return
	}
	s.pairLimiter.Reset(pairKey)
	s.setSessionCookie(w, token, expires)
	ok(w, http.StatusOK, s.view(acct.User, csrf, acct.MustChangePassword, expires))
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, a store.Actor) {
	p := principalFrom(r)
	ok(w, http.StatusOK, s.view(a.User, p.CSRFToken, p.MustChangePassword, p.ExpiresAt))
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, a store.Actor) {
	p := principalFrom(r)
	if err := s.store.Logout(r.Context(), a, p.SessionID); err != nil {
		fail(w, r, s.log, err)
		return
	}
	s.clearSessionCookie(w)
	ok(w, http.StatusOK, map[string]bool{"signedOut": true})
}

type changePasswordInput struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in changePasswordInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	key := "pw:" + a.User.ID
	if blocked, wait := s.pairLimiter.Blocked(key); blocked {
		fail(w, r, s.log, tooMany(w, wait))
		return
	}
	if in.CurrentPassword == "" || utf8.RuneCountInString(in.CurrentPassword) > 1024 {
		fail(w, r, s.log, domain.Invalid("Check the highlighted fields.", map[string]string{"currentPassword": "Enter your current password"}))
		return
	}
	hash, err := s.store.PasswordHash(r.Context(), a.User.ID)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	valid := false
	if hash != "" {
		valid, _, _ = auth.VerifyPassword(in.CurrentPassword, hash)
	} else {
		auth.BurnTime(in.CurrentPassword)
	}
	if !valid {
		s.pairLimiter.Hit(key)
		_ = s.store.AuthEvent(r.Context(), a, "auth.password_change_failed", a.User.ID, map[string]any{})
		fail(w, r, s.log, domain.Invalid("Check the highlighted fields.", map[string]string{"currentPassword": "Current password is incorrect"}))
		return
	}
	if msg := auth.ValidateNewPassword(in.NewPassword, a.User.Email, a.User.Name); msg != "" {
		fail(w, r, s.log, domain.Invalid("Check the highlighted fields.", map[string]string{"newPassword": msg}))
		return
	}
	if in.NewPassword == in.CurrentPassword {
		fail(w, r, s.log, domain.Invalid("Check the highlighted fields.", map[string]string{"newPassword": "Choose a password you haven't just used"}))
		return
	}
	newHash, err := auth.HashPassword(in.NewPassword)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	token, tokenHash, err1 := auth.NewToken()
	csrf, _, err2 := auth.NewToken()
	if err1 != nil || err2 != nil {
		fail(w, r, s.log, fmt.Errorf("token generation failed"))
		return
	}
	expires := s.store.Now().Add(s.cfg.SessionTTL)
	if err := s.store.ChangePassword(r.Context(), a, newHash, store.NewSession{TokenHash: tokenHash, CSRFToken: csrf,
		IP: a.IP, UserAgent: r.UserAgent(), ExpiresAt: expires}); err != nil {
		fail(w, r, s.log, err)
		return
	}
	s.pairLimiter.Reset(key)
	s.setSessionCookie(w, token, expires)
	ok(w, http.StatusOK, s.view(a.User, csrf, false, expires))
}
