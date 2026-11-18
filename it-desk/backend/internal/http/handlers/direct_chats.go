package handlers

import (
	"net/http"

	"itdesk/backend/internal/domain"
	"itdesk/backend/internal/store"
)

func (s *Server) getDirectChats(w http.ResponseWriter, r *http.Request, a store.Actor) {
	list, err := s.store.DirectChats(r.Context(), a, r.URL.Query().Get("q"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, list)
}

func (s *Server) getDirectChatUnread(w http.ResponseWriter, r *http.Request, a store.Actor) {
	u, err := s.store.DirectChatUnread(r.Context(), a)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, u)
}

func (s *Server) getDirectChatMessages(w http.ResponseWriter, r *http.Request, a store.Actor) {
	m, err := s.store.DirectChatMessages(r.Context(), a, r.PathValue("peerId"), r.URL.Query().Get("after"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, m)
}

func (s *Server) postDirectChatMessage(w http.ResponseWriter, r *http.Request, a store.Actor) {
	body, side, files, err := chatMessageInput(r)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	if side != "" {
		fail(w, r, s.log, domain.Forbidden("chat_side", "You can only send direct messages as yourself."))
		return
	}
	m, err := s.store.PostDirectChatMessage(r.Context(), a, r.PathValue("peerId"), body, files)
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusCreated, m)
}

func (s *Server) postDirectChatRead(w http.ResponseWriter, r *http.Request, a store.Actor) {
	u, err := s.store.MarkDirectChatRead(r.Context(), a, r.PathValue("peerId"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	ok(w, http.StatusOK, u)
}

func (s *Server) getDirectChatFile(w http.ResponseWriter, r *http.Request, a store.Actor) {
	name, ctype, data, err := s.store.DirectChatFile(r.Context(), a, r.PathValue("messageId"), r.PathValue("fileId"))
	if err != nil {
		fail(w, r, s.log, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeChatFile(w, r, name, ctype, data)
}
