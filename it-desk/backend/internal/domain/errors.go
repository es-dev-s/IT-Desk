package domain

import (
	"errors"
	"net/http"
)

// Error is an expected, user-facing failure. It maps 1:1 to the JSON error
// envelope: {"error":{"code","message","fields","requestId"}}.
type Error struct {
	Status  int               `json:"-"`
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func Invalid(message string, fields map[string]string) *Error {
	return &Error{Status: http.StatusUnprocessableEntity, Code: "validation_failed", Message: message, Fields: fields}
}

func BadRequest(message string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "bad_request", Message: message}
}

func NotFound(message string) *Error {
	return &Error{Status: http.StatusNotFound, Code: "not_found", Message: message}
}

func Conflict(code, message string) *Error {
	return &Error{Status: http.StatusConflict, Code: code, Message: message}
}

func Forbidden(code, message string) *Error {
	return &Error{Status: http.StatusForbidden, Code: code, Message: message}
}

func Unauthenticated(message string) *Error {
	return &Error{Status: http.StatusUnauthorized, Code: "unauthenticated", Message: message}
}

// ErrNoTeam is returned when a team write is attempted by an account without
// a team (defence in depth: the route policy should already stop it).
var ErrNoTeam = Forbidden("forbidden", "Only a team lead can make changes to a team.")

// ErrUnavailable means the database has not been reached yet (or is down).
var ErrUnavailable = &Error{
	Status:  http.StatusServiceUnavailable,
	Code:    "database_unavailable",
	Message: "The database is not reachable right now. Please retry in a moment.",
}

func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}
