// Package handlers is the HTTP API (/api/v1): routing, request decoding,
// response envelopes and error mapping.
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"itdesk/backend/internal/db"
	"itdesk/backend/internal/domain"
	mw "itdesk/backend/internal/http/middleware"
)

type envelope struct {
	Data any `json:"data"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func ok(w http.ResponseWriter, status int, data any) { writeJSON(w, status, envelope{Data: data}) }

type apiError struct {
	Code      string            `json:"code"`
	Message   string            `json:"message"`
	Fields    map[string]string `json:"fields,omitempty"`
	RequestID string            `json:"requestId"`
}

// fail maps any error to the JSON error envelope. Unknown errors become a 500
// with a generic message (details only go to the log).
func fail(w http.ResponseWriter, r *http.Request, log *slog.Logger, err error) {
	rid := mw.RequestIDFrom(r.Context())
	var de *domain.Error
	switch {
	case errors.As(err, &de):
	case errors.Is(err, domain.ErrUnavailable), db.IsUnavailable(err) && !db.IsTimeout(err):
		de = domain.ErrUnavailable
	case db.IsTimeout(err):
		de = &domain.Error{Status: http.StatusGatewayTimeout, Code: "timeout", Message: "The database took too long to respond. Please try again."}
	case db.IsSeatConflict(err):
		de = domain.Conflict("conflict", "That change conflicts with another one. Refresh and try again.")
	default:
		log.Error("unhandled error", "request_id", rid, "path", r.URL.Path, "err", err)
		de = &domain.Error{Status: http.StatusInternalServerError, Code: "internal", Message: "Something went wrong on our side. Please try again."}
	}
	if de.Status == http.StatusServiceUnavailable {
		mw.RetryAfter(w, 2)
	}
	writeJSON(w, de.Status, map[string]apiError{"error": {Code: de.Code, Message: de.Message, Fields: de.Fields, RequestID: rid}})
}

// decode reads a single JSON object, rejecting unknown fields and trailing data.
func decode(r *http.Request, dst any) error {
	if !mw.IsJSON(r) {
		return &domain.Error{Status: http.StatusUnsupportedMediaType, Code: "unsupported_media_type", Message: "Send application/json."}
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var mbe *http.MaxBytesError
		switch {
		case errors.As(err, &mbe):
			return &domain.Error{Status: http.StatusRequestEntityTooLarge, Code: "body_too_large", Message: "Request body is too large."}
		case errors.Is(err, io.EOF):
			return domain.BadRequest("Request body is empty.")
		case strings.HasPrefix(err.Error(), "json: unknown field"):
			return domain.BadRequest(fmt.Sprintf("Unexpected field %s.", strings.TrimPrefix(err.Error(), "json: unknown field ")))
		default:
			return domain.BadRequest("Malformed JSON body.")
		}
	}
	if dec.More() {
		return domain.BadRequest("Body must contain a single JSON object.")
	}
	return nil
}
