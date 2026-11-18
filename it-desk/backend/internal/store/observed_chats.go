package store

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
)

// Super admins can read every direct chat they are not part of themselves
// (team lead <-> IT, and chats involving another admin). Such a chat is
// addressed by its own id, since it has no single peer from the admin's point
// of view. It is read-only: the admin never posts, has no unread count, and
// looking in never moves anyone's read marker.
//
// Each row names the requester side (lead_id: a team lead, or an admin writing
// to IT) and the other side (an IT staff entry, or the admin writing to a lead).
const observedChats = `SELECT c.id AS chat_id,
		rq.id AS requester_id, rq.name AS requester_name, rq.role AS requester_role,
		COALESCE(rt.name, CASE WHEN rq.role = 'admin' THEN 'Super admin' ELSE 'Team lead' END) AS requester_title,
		COALESCE(s.id, oa.id) AS other_id, COALESCE(s.name, oa.name) AS other_name,
		CASE WHEN s.id IS NOT NULL THEN 'it' ELSE 'admin' END AS other_role,
		COALESCE(NULLIF(s.title, ''), CASE WHEN s.id IS NOT NULL THEN 'IT' ELSE 'Super admin' END) AS other_title,
		c.lead_read_at
	FROM it_direct_chats c
	JOIN users rq ON rq.id = c.lead_id
	LEFT JOIN teams rt ON rt.id = rq.team_id
	LEFT JOIN it_staff s ON s.id = c.staff_id
	LEFT JOIN users oa ON oa.id = c.admin_id
	WHERE $1 = 'admin' AND c.lead_id <> $2 AND c.admin_id IS DISTINCT FROM $2
		AND EXISTS (SELECT 1 FROM it_request_messages m WHERE m.direct_chat_id = c.id)`

var errObservedChatNotFound = domain.NotFound("Conversation not found.")

func observedThreads(ctx context.Context, q querier, actor Actor, chatID, search string) ([]domain.DirectChatThread, error) {
	rows, err := q.Query(ctx, `SELECT o.chat_id, o.requester_id, o.requester_name, o.requester_role, o.requester_title,
			o.other_id, o.other_name, o.other_role, o.other_title, o.lead_read_at,
			stats.total, last.id, last.created_at
		FROM (`+observedChats+`) o
		CROSS JOIN LATERAL (SELECT count(*) AS total FROM it_request_messages m WHERE m.direct_chat_id = o.chat_id) stats
		CROSS JOIN LATERAL (
			SELECT id, created_at FROM it_request_messages WHERE direct_chat_id = o.chat_id
			ORDER BY created_at DESC, id DESC LIMIT 1
		) last
		WHERE ($3 = '' OR o.chat_id = $3) AND ($4 = '' OR strpos(lower(o.requester_name), lower($4)) > 0
			OR strpos(lower(o.other_name), lower($4)) > 0
			OR EXISTS (SELECT 1 FROM it_request_messages m WHERE m.direct_chat_id = o.chat_id AND strpos(lower(m.body), lower($4)) > 0))
		ORDER BY last.created_at DESC, o.chat_id`,
		actor.User.Role, actor.User.ID, chatID, search)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	threads := []domain.DirectChatThread{}
	var messageIDs []string
	byMessage := map[string]int{}
	for rows.Next() {
		var t domain.DirectChatThread
		var req, other domain.DirectChatContact
		var readAt *time.Time
		var lastID string
		var lastAt time.Time
		if err := rows.Scan(&t.Contact.ID, &req.ID, &req.Name, &req.Role, &req.Title,
			&other.ID, &other.Name, &other.Role, &other.Title, &readAt,
			&t.MessageCount, &lastID, &lastAt); err != nil {
			return nil, err
		}
		// Laid out the way IT sees it: the requester on the left, IT (or the
		// admin writing to a lead) on the right, "Seen" when the requester read it.
		t.Side = domain.ChatSideIT
		t.CanPostAs = []string{}
		t.Contact.Name = req.Name + " & " + other.Name
		t.Contact.Role = req.Role
		t.Participants = &domain.DirectChatParticipants{Requester: req, IT: other}
		at := domain.NewTime(lastAt)
		t.LastActivityAt = &at
		if readAt != nil {
			r := domain.NewTime(*readAt)
			t.OtherReadAt = &r
		}
		messageIDs = append(messageIDs, lastID)
		byMessage[lastID] = len(threads)
		threads = append(threads, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(messageIDs) == 0 {
		return threads, err
	}
	mrows, err := q.Query(ctx, directMessageSelect+" WHERE m.direct_chat_id IS NOT NULL AND m.id = ANY($1)", messageIDs)
	if err != nil {
		return nil, err
	}
	messages, err := scanMessages(mrows, actor)
	if err != nil {
		return nil, err
	}
	if messages, err = loadAttachments(ctx, q, messages); err != nil {
		return nil, err
	}
	for _, m := range messages {
		threads[byMessage[m.ID]].LastMessage = &m
	}
	return threads, nil
}

// ObservedChats lists every direct chat between other people (admins only).
func (s *Store) ObservedChats(ctx context.Context, actor Actor, search string) (domain.DirectChatList, error) {
	out := domain.DirectChatList{Items: []domain.DirectChatThread{}}
	if actor.User.Role != "admin" {
		return out, domain.Forbidden("forbidden", "Only the super admin can read other people’s chats.")
	}
	if err := s.purgeExpiredChat(ctx); err != nil {
		return out, err
	}
	pool, err := s.pool()
	if err != nil {
		return out, err
	}
	out.Items, err = observedThreads(ctx, pool, actor, "", strings.TrimSpace(search))
	return out, err
}

// ObservedChatMessages is one observed chat's latest page, or what came after a cursor.
func (s *Store) ObservedChatMessages(ctx context.Context, actor Actor, chatID, after string) (domain.DirectChatMessages, error) {
	out := domain.DirectChatMessages{Messages: []domain.RequestMessage{}}
	if actor.User.Role != "admin" {
		return out, errObservedChatNotFound
	}
	if err := s.purgeExpiredChat(ctx); err != nil {
		return out, err
	}
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		threads, err := observedThreads(ctx, tx, actor, chatID, "")
		if err != nil {
			return err
		}
		if len(threads) == 0 {
			return errObservedChatNotFound
		}
		out.Thread = threads[0]

		var cursorAt time.Time
		if after != "" {
			err := tx.QueryRow(ctx, `SELECT created_at FROM it_request_messages WHERE direct_chat_id = $1 AND id = $2`, chatID, after).Scan(&cursorAt)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		var rows pgx.Rows
		if cursorAt.IsZero() {
			rows, err = tx.Query(ctx, directMessageSelect+` WHERE m.direct_chat_id = $1
				ORDER BY m.created_at DESC, m.id DESC LIMIT $2`, chatID, domain.MaxThreadMessages+1)
		} else {
			rows, err = tx.Query(ctx, directMessageSelect+` WHERE m.direct_chat_id = $1 AND (m.created_at, m.id) > ($2, $3)
				ORDER BY m.created_at, m.id LIMIT $4`, chatID, cursorAt, after, domain.MaxThreadMessages)
		}
		if err != nil {
			return err
		}
		messages, err := scanMessages(rows, actor)
		if err != nil {
			return err
		}
		if cursorAt.IsZero() {
			out.HasMore = len(messages) > domain.MaxThreadMessages
			if out.HasMore {
				messages = messages[:domain.MaxThreadMessages]
			}
			slices.Reverse(messages)
		}
		out.Messages, err = loadAttachments(ctx, tx, messages)
		return err
	})
	return out, err
}
