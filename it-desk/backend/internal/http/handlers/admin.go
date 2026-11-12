package handlers

import (
	"net/http"

	"itdesk/backend/internal/auth"
	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/store"
)

// Admin user management. Responses that carry a one-time password are never
// cached by the idempotency layer (it would persist the secret).

type createdUser struct {
	User              domain.ManagedUser `json:"user"`
	TemporaryPassword string             `json:"temporaryPassword"`
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request, _ store.Actor) {
	list, err := s.store.ListUsers(r.Context())
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

func (s *Server) getUser(w http.ResponseWriter, r *http.Request, _ store.Actor) {
	u, err := s.store.GetUser(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, u)
}

func tempPassword() (string, string, error) {
	pw, err := auth.GeneratePassword(16)
	if err != nil {
		return "", "", err
	}
	h, err := auth.HashPassword(pw)
	return pw, h, err
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.UserInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	pw, hash, err := tempPassword()
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	u, err := s.store.CreateUser(r.Context(), a, in, hash)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusCreated, createdUser{User: u, TemporaryPassword: pw})
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request, a store.Actor) {
	var in domain.UserInput
	if err := decode(r, &in); err != nil {
		fail(w, r, s.log, err)
		return
	}
	u, err := s.store.UpdateUser(r.Context(), a, r.PathValue("id"), in)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, u)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request, a store.Actor) {
	if err := s.store.DeleteUser(r.Context(), a, r.PathValue("id")); err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) resetPassword(w http.ResponseWriter, r *http.Request, a store.Actor) {
	pw, hash, err := tempPassword()
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	u, err := s.store.ResetPassword(r.Context(), a, r.PathValue("id"), hash)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, createdUser{User: u, TemporaryPassword: pw})
}

func (s *Server) setStatus(enable bool) actorHandler {
	return func(w http.ResponseWriter, r *http.Request, a store.Actor) {
		u, err := s.store.SetUserStatus(r.Context(), a, r.PathValue("id"), enable)
		if err != nil {
			fail(w, r, s.log, err)
			return
		}
		ok(w, http.StatusOK, u)
	}
}

func (s *Server) revokeSessions(w http.ResponseWriter, r *http.Request, a store.Actor) {
	u, err := s.store.RevokeSessions(r.Context(), a, r.PathValue("id"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, u)
}
