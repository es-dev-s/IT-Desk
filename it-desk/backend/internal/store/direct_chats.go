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

var errDirectChatNotFound = domain.NotFound("Conversation not found.")

// Leads address an IT directory entry, including entries that have no login
// yet. IT accounts see only conversations with their own linked entry.
// A team lead's team membership never gives them access to another lead's chat.
const directContacts = `SELECT s.id AS peer_id, s.name, s.title, s.active AS can_post,
		(s.active AND COALESCE(u.role = 'it' AND u.status = 'active' AND u.password_hash IS NOT NULL, false)) AS available,
		$1 AS lead_id, s.id AS staff_id, c.id AS chat_id, 'requester' AS side,
		c.lead_read_at AS read_at, c.it_read_at AS other_read_at
	FROM it_staff s
	LEFT JOIN users u ON u.id = s.user_id
	LEFT JOIN it_direct_chats c ON c.staff_id = s.id AND c.lead_id = $1
	WHERE $2 = 'team_lead' AND (s.active OR c.id IS NOT NULL)
	UNION ALL
	SELECT u.id, u.name, COALESCE(t.name, 'Team lead'), u.status = 'active',
		(u.status = 'active' AND u.password_hash IS NOT NULL),
		u.id, s.id, c.id, 'it', c.it_read_at, c.lead_read_at
	FROM it_staff s
	JOIN it_direct_chats c ON c.staff_id = s.id
	JOIN users u ON u.id = c.lead_id AND u.role = 'team_lead'
	LEFT JOIN teams t ON t.id = u.team_id
	WHERE $2 = 'it' AND s.user_id = $1 AND s.active`

const directMessageSelect = `SELECT m.id, '', m.side, m.staff_id, m.staff_name, m.author_id, m.author_name, m.author_role,
	false, m.body, m.created_at, '' FROM it_request_messages m`

const directUnreadCondition = `m.side <> p.side AND m.created_at > COALESCE(p.read_at, '-infinity')`

type directContact struct {
	canPost               bool
	leadID, staffID, side string
	chatID                *string
}

func findDirectContact(ctx context.Context, q querier, actor Actor, peerID string) (directContact, error) {
	var p directContact
	err := q.QueryRow(ctx, `SELECT p.can_post, p.lead_id, p.staff_id, p.side, p.chat_id FROM (`+directContacts+`) p WHERE p.peer_id = $3`,
		actor.User.ID, actor.User.Role, peerID).
		Scan(&p.canPost, &p.leadID, &p.staffID, &p.side, &p.chatID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errDirectChatNotFound
	}
	return p, err
}

func directThreads(ctx context.Context, q querier, actor Actor, peerID, search string) ([]domain.DirectChatThread, error) {
	rows, err := q.Query(ctx, `SELECT p.peer_id, p.name, p.title, p.can_post, p.available, p.side, p.other_read_at,
			stats.total, stats.unread, last.id, last.created_at
		FROM (`+directContacts+`) p
		CROSS JOIN LATERAL (
			SELECT count(*) AS total, count(*) FILTER (WHERE `+directUnreadCondition+`) AS unread
			FROM it_request_messages m WHERE m.direct_chat_id = p.chat_id
		) stats
		LEFT JOIN LATERAL (
			SELECT id, created_at FROM it_request_messages WHERE direct_chat_id = p.chat_id
			ORDER BY created_at DESC, id DESC LIMIT 1
		) last ON true
		WHERE ($3 = '' OR p.peer_id = $3) AND ($4 = '' OR strpos(lower(p.name), lower($4)) > 0
			OR EXISTS (SELECT 1 FROM it_request_messages m WHERE m.direct_chat_id = p.chat_id AND strpos(lower(m.body), lower($4)) > 0))
		ORDER BY last.created_at DESC NULLS LAST, lower(p.name), p.peer_id`,
		actor.User.ID, actor.User.Role, peerID, search)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	threads := []domain.DirectChatThread{}
	var messageIDs []string
	byMessage := map[string]int{}
	for rows.Next() {
		var t domain.DirectChatThread
		var canPost bool
		var lastID *string
		var lastAt, otherRead *time.Time
		if err := rows.Scan(&t.Contact.ID, &t.Contact.Name, &t.Contact.Title, &canPost, &t.Contact.Available,
			&t.Side, &otherRead, &t.MessageCount, &t.Unread, &lastID, &lastAt); err != nil {
			return nil, err
		}
		t.CanPostAs = []string{}
		if canPost {
			t.CanPostAs = append(t.CanPostAs, t.Side)
		}
		if lastAt != nil {
			at := domain.NewTime(*lastAt)
			t.LastActivityAt = &at
		}
		if otherRead != nil {
			at := domain.NewTime(*otherRead)
			t.OtherReadAt = &at
		}
		if lastID != nil {
			messageIDs = append(messageIDs, *lastID)
			byMessage[*lastID] = len(threads)
		}
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
	messages, err = loadAttachments(ctx, q, messages)
	if err != nil {
		return nil, err
	}
	for _, m := range messages {
		threads[byMessage[m.ID]].LastMessage = &m
	}
	return threads, nil
}

func directChatUnread(ctx context.Context, q querier, actor Actor) (domain.ChatUnread, error) {
	var out domain.ChatUnread
	err := q.QueryRow(ctx, `SELECT COALESCE(sum(u), 0), count(*) FILTER (WHERE u > 0)
		FROM (`+directContacts+`) p
		CROSS JOIN LATERAL (
			SELECT count(*) AS u FROM it_request_messages m
			WHERE m.direct_chat_id = p.chat_id AND `+directUnreadCondition+`
		) unread`, actor.User.ID, actor.User.Role).Scan(&out.Unread, &out.UnreadChats)
	return out, err
}

func (s *Store) DirectChatUnread(ctx context.Context, actor Actor) (domain.ChatUnread, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.ChatUnread{}, err
	}
	return directChatUnread(ctx, pool, actor)
}

func (s *Store) DirectChats(ctx context.Context, actor Actor, search string) (domain.DirectChatList, error) {
	var out domain.DirectChatList
	if err := s.purgeExpiredChat(ctx); err != nil {
		return out, err
	}
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		var err error
		out.Items, err = directThreads(ctx, tx, actor, "", strings.TrimSpace(search))
		if err != nil {
			return err
		}
		out.ChatUnread, err = directChatUnread(ctx, tx, actor)
		return err
	})
	return out, err
}

func (s *Store) DirectChatMessages(ctx context.Context, actor Actor, peerID, after string) (domain.DirectChatMessages, error) {
	out := domain.DirectChatMessages{Messages: []domain.RequestMessage{}}
	if err := s.purgeExpiredChat(ctx); err != nil {
		return out, err
	}
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		peer, err := findDirectContact(ctx, tx, actor, peerID)
		if err != nil {
			return err
		}
		threads, err := directThreads(ctx, tx, actor, peerID, "")
		if err != nil {
			return err
		}
		out.Thread = threads[0]
		if peer.chatID == nil {
			return nil
		}

		var cursorAt time.Time
		if after != "" {
			err := tx.QueryRow(ctx, `SELECT created_at FROM it_request_messages WHERE direct_chat_id = $1 AND id = $2`, peer.chatID, after).Scan(&cursorAt)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		var rows pgx.Rows
		if cursorAt.IsZero() {
			rows, err = tx.Query(ctx, directMessageSelect+` WHERE m.direct_chat_id = $1
				ORDER BY m.created_at DESC, m.id DESC LIMIT $2`, peer.chatID, domain.MaxThreadMessages+1)
		} else {
			rows, err = tx.Query(ctx, directMessageSelect+` WHERE m.direct_chat_id = $1 AND (m.created_at, m.id) > ($2, $3)
				ORDER BY m.created_at, m.id LIMIT $4`, peer.chatID, cursorAt, after, domain.MaxThreadMessages)
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

func (s *Store) PostDirectChatMessage(ctx context.Context, actor Actor, peerID, body string, files []domain.ChatFileIn) (domain.RequestMessage, error) {
	var out domain.RequestMessage
	body, err := validateChatMessage(body, files)
	if err != nil {
		return out, err
	}
	err = s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		peer, err := findDirectContact(ctx, tx, actor, peerID)
		if err != nil {
			return err
		}
		if !peer.canPost {
			return domain.Forbidden("chat_view_only", "This contact is inactive.")
		}
		if peer.chatID == nil {
			if _, err := tx.Exec(ctx, `INSERT INTO it_direct_chats (id, lead_id, staff_id) VALUES ($1, $2, $3)
				ON CONFLICT (lead_id, staff_id) DO NOTHING`, NewID("dm"), peer.leadID, peer.staffID); err != nil {
				return err
			}
		}
		var chatID string
		if err := tx.QueryRow(ctx, `SELECT id FROM it_direct_chats WHERE lead_id = $1 AND staff_id = $2 FOR UPDATE`, peer.leadID, peer.staffID).Scan(&chatID); err != nil {
			return err
		}
		var staffID, staffName *string
		if peer.side == domain.ChatSideIT {
			staffID = &peer.staffID
			var name string
			if err := tx.QueryRow(ctx, `SELECT name FROM it_staff WHERE id = $1`, peer.staffID).Scan(&name); err != nil {
				return err
			}
			staffName = &name
		}
		messageID, now := NewID("msg"), s.Now()
		if _, err := tx.Exec(ctx, `INSERT INTO it_request_messages (id, direct_chat_id, side, author_id, author_name, author_role, staff_id, staff_name, body, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			messageID, chatID, peer.side, actor.User.ID, actor.User.Name, actor.User.Role, staffID, staffName, body, now); err != nil {
			return err
		}
		if err := insertChatFiles(ctx, tx, messageID, files); err != nil {
			return err
		}
		if err := markDirectRead(ctx, tx, chatID, peer.side, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "direct_chat.message", "direct_chat", chatID, map[string]any{"messageId": messageID}); err != nil {
			return err
		}
		m, err := scanMessage(tx.QueryRow(ctx, directMessageSelect+" WHERE m.id = $1", messageID), actor)
		if err != nil {
			return err
		}
		messages, err := loadAttachments(ctx, tx, []domain.RequestMessage{m})
		if err == nil {
			out = messages[0]
		}
		return err
	})
	return out, err
}

func markDirectRead(ctx context.Context, q querier, chatID, side string, at time.Time) error {
	column := "lead_read_at"
	if side == domain.ChatSideIT {
		column = "it_read_at"
	}
	_, err := q.Exec(ctx, "UPDATE it_direct_chats SET "+column+" = GREATEST("+column+", $2) WHERE id = $1", chatID, at)
	return err
}

func (s *Store) MarkDirectChatRead(ctx context.Context, actor Actor, peerID string) (domain.ChatUnread, error) {
	var out domain.ChatUnread
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		peer, err := findDirectContact(ctx, tx, actor, peerID)
		if err != nil {
			return err
		}
		if peer.chatID != nil {
			if err := markDirectRead(ctx, tx, *peer.chatID, peer.side, s.Now()); err != nil {
				return err
			}
		}
		out, err = directChatUnread(ctx, tx, actor)
		return err
	})
	return out, err
}

func (s *Store) DirectChatFile(ctx context.Context, actor Actor, messageID, fileID string) (name, contentType string, data []byte, err error) {
	pool, err := s.pool()
	if err != nil {
		return "", "", nil, err
	}
	err = pool.QueryRow(ctx, `SELECT f.name, f.content_type, f.data
		FROM it_request_message_files f
		JOIN it_request_messages m ON m.id = f.message_id
		JOIN (`+directContacts+`) p ON p.chat_id = m.direct_chat_id
		WHERE f.id = $3 AND m.id = $4`, actor.User.ID, actor.User.Role, fileID, messageID).Scan(&name, &contentType, &data)
	if errors.Is(err, pgx.ErrNoRows) {
		err = domain.NotFound("That image is no longer available.")
	}
	return
}
