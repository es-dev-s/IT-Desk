package store

// Direct messages (migration 0014): one continuous conversation per team lead
// and IT staff member, independent of requests.
//
// Who sees what:
//   - a team lead has a conversation with every active IT staff member (and
//     any former one they already talked to) and writes as themselves;
//   - an IT account linked to a directory entry sees that person's
//     conversations and writes as them;
//   - an IT account without an entry sees every conversation and replies on
//     behalf of the staff member it belongs to;
//   - admins read everything and write nothing.
//
// A conversation another account may not see is a 404, not a 403.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
)

var (
	errChatNotFound = domain.NotFound("That conversation doesn’t exist or isn’t visible to you.")
	// errChatViewOnly: an admin trying to write in a conversation between a lead and IT.
	errChatViewOnly = domain.Forbidden("chat_view_only", "Admins can read this conversation but can’t reply in it.")
	// errChatClosed: the IT staff member has left the directory.
	errChatClosed = domain.Forbidden("chat_closed", "This person is no longer in the IT team, so new messages can’t be sent.")
)

// ChatFilter narrows GET /chats.
type ChatFilter struct {
	Query string
	Limit int
}

const messageSelect = `SELECT m.id, m.lead_id, m.staff_id, m.side, st.name, m.author_id, m.author_name, m.author_role,
	(m.side = 'it' AND st.user_id IS DISTINCT FROM m.author_id), m.body, m.created_at
	FROM chat_messages m JOIN it_staff st ON st.id = m.staff_id`

func scanMessage(row pgx.Row, actor Actor) (domain.ChatMessage, error) {
	var m domain.ChatMessage
	var at time.Time
	var staffName string
	if err := row.Scan(&m.ID, &m.LeadID, &m.StaffID, &m.Side, &staffName, &m.AuthorID, &m.AuthorName, &m.AuthorRole,
		&m.OnBehalf, &m.Body, &at); err != nil {
		return m, err
	}
	m.CreatedAt = domain.NewTime(at)
	m.Attachments = []domain.ChatAttachment{}
	m.Mine = m.AuthorID != nil && *m.AuthorID == actor.User.ID
	m.SenderName = m.AuthorName
	if m.Side == domain.ChatSideIT {
		m.SenderName = staffName
	}
	return m, nil
}

func scanMessages(rows pgx.Rows, actor Actor) ([]domain.ChatMessage, error) {
	defer rows.Close()
	out := []domain.ChatMessage{}
	for rows.Next() {
		m, err := scanMessage(rows, actor)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// chatView is what an account may see: the set of conversations as SQL
// (columns lead_id, staff_id), with its args; $1 is always the viewer's side.
type chatView struct {
	side     string
	observer bool
	mine     *string // the caller's own staff entry
	convs    string
	args     []any
}

func viewFor(ctx context.Context, q querier, actor Actor) (chatView, error) {
	v := chatView{side: domain.ChatSideFor(actor.User.Role), observer: domain.IsChatObserver(actor.User.Role)}
	v.args = []any{v.side}
	switch actor.User.Role {
	case "team_lead":
		v.args = append(v.args, actor.User.ID)
		v.convs = `SELECT $2::text AS lead_id, s.id AS staff_id FROM it_staff s
			WHERE s.active OR EXISTS (SELECT 1 FROM chat_messages e WHERE e.lead_id = $2 AND e.staff_id = s.id)`
	case "it", "admin":
		if actor.User.Role == "it" {
			mine, err := myStaffEntry(ctx, q, actor)
			if err != nil {
				return v, err
			}
			v.mine = mine
		}
		if v.mine != nil {
			v.args = append(v.args, *v.mine)
			v.convs = `SELECT DISTINCT e.lead_id, e.staff_id FROM chat_messages e WHERE e.staff_id = $2`
		} else {
			v.convs = `SELECT DISTINCT e.lead_id, e.staff_id FROM chat_messages e`
		}
	default:
		v.convs = `SELECT NULL::text AS lead_id, NULL::text AS staff_id WHERE FALSE`
	}
	return v, nil
}

// unreadSQL counts what the other side sent after the viewer's side ($1) last
// read the conversation c. Admins only watch: nothing is unread for them.
func (v chatView) unreadSQL() string {
	if v.observer {
		return "0"
	}
	return `(SELECT count(*) FROM chat_messages um WHERE um.lead_id = c.lead_id AND um.staff_id = c.staff_id AND um.side <> $1
		AND um.created_at > COALESCE((SELECT cr.read_at FROM chat_reads cr WHERE cr.lead_id = c.lead_id AND cr.staff_id = c.staff_id AND cr.side = $1), '-infinity'))`
}

// threads lists the conversations in view, optionally narrowed by a search,
// most recent activity first; conversations not started yet follow in
// directory order.
func threads(ctx context.Context, q querier, actor Actor, v chatView, search string, limit int) ([]domain.ChatThread, error) {
	args := append([]any{}, v.args...)
	cond := "TRUE"
	if search = strings.TrimSpace(search); search != "" {
		if len(search) > 100 {
			search = search[:100]
		}
		args = append(args, "%"+strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search)+"%")
		cond = fmt.Sprintf(`(s.name ILIKE %[1]s OR s.title ILIKE %[1]s OR lu.name ILIKE %[1]s OR COALESCE(t.name,'') ILIKE %[1]s
			OR EXISTS (SELECT 1 FROM chat_messages qm WHERE qm.lead_id = c.lead_id AND qm.staff_id = c.staff_id AND qm.body ILIKE %[1]s))`,
			fmt.Sprintf("$%d", len(args)))
	}
	rows, err := q.Query(ctx, `SELECT c.lead_id, lu.name, lu.team_id, t.name, s.id, s.name, s.title, s.active,
			(SELECT count(*) FROM chat_messages cm WHERE cm.lead_id = c.lead_id AND cm.staff_id = c.staff_id),
			`+v.unreadSQL()+`,
			(SELECT max(lm.created_at) FROM chat_messages lm WHERE lm.lead_id = c.lead_id AND lm.staff_id = c.staff_id) AS last_at,
			(SELECT cr.read_at FROM chat_reads cr WHERE cr.lead_id = c.lead_id AND cr.staff_id = c.staff_id AND cr.side <> $1),
			(SELECT lm.id FROM chat_messages lm WHERE lm.lead_id = c.lead_id AND lm.staff_id = c.staff_id ORDER BY lm.created_at DESC, lm.id DESC LIMIT 1)
		FROM (`+v.convs+`) c
		JOIN users lu ON lu.id = c.lead_id AND lu.role = 'team_lead'
		LEFT JOIN teams t ON t.id = lu.team_id
		JOIN it_staff s ON s.id = c.staff_id
		WHERE $1::text IS NOT NULL AND `+cond+`
		ORDER BY last_at DESC NULLS LAST, s.sort_order, s.name, lu.name, c.lead_id, s.id
		LIMIT `+fmt.Sprint(limit), args...)
	if err != nil {
		return nil, err
	}
	out := []domain.ChatThread{}
	var lastIDs []string
	for rows.Next() {
		t := domain.ChatThread{Side: v.side}
		var last, otherRead *time.Time
		var lastID *string
		if err := rows.Scan(&t.Lead.ID, &t.Lead.Name, &t.Lead.TeamID, &t.Lead.TeamName, &t.Staff.ID, &t.Staff.Name, &t.Staff.Title, &t.Staff.Active,
			&t.MessageCount, &t.Unread, &last, &otherRead, &lastID); err != nil {
			rows.Close()
			return nil, err
		}
		// Everyone writes only on their own side; admins never, and nobody
		// to someone who has left the IT directory.
		t.CanPost = !v.observer && t.Staff.Active
		if last != nil {
			at := domain.NewTime(*last)
			t.LastActivityAt = &at
		}
		if otherRead != nil {
			at := domain.NewTime(*otherRead)
			t.OtherReadAt = &at
		}
		if lastID != nil {
			lastIDs = append(lastIDs, *lastID)
		}
		out = append(out, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(lastIDs) == 0 {
		return out, nil
	}
	mrows, err := q.Query(ctx, messageSelect+" WHERE m.id = ANY($1)", lastIDs)
	if err != nil {
		return nil, err
	}
	msgs, err := scanMessages(mrows, actor)
	if err != nil {
		return nil, err
	}
	if msgs, err = loadAttachments(ctx, q, msgs); err != nil {
		return nil, err
	}
	byConv := make(map[[2]string]domain.ChatMessage, len(msgs))
	for _, m := range msgs {
		byConv[[2]string{m.LeadID, m.StaffID}] = m
	}
	for i := range out {
		if m, ok := byConv[[2]string{out[i].Lead.ID, out[i].Staff.ID}]; ok {
			out[i].LastMessage = &m
		}
	}
	return out, nil
}

// thread is the header of one conversation the caller may open. It does not
// need messages yet: a lead may start one with anyone in the directory, and
// IT with any lead (an IT member with a login only as themselves).
func thread(ctx context.Context, q querier, actor Actor, leadID, staffID string) (domain.ChatThread, chatView, error) {
	v, err := viewFor(ctx, q, actor)
	if err != nil {
		return domain.ChatThread{}, v, err
	}
	leadID, staffID = strings.TrimSpace(leadID), strings.TrimSpace(staffID)
	switch {
	case leadID == "" || staffID == "",
		actor.User.Role == "team_lead" && leadID != actor.User.ID,
		v.mine != nil && *v.mine != staffID,
		actor.User.Role != "team_lead" && actor.User.Role != "it" && actor.User.Role != "admin":
		return domain.ChatThread{}, v, errChatNotFound
	}
	pair := v
	pair.args = []any{v.side, leadID, staffID}
	pair.convs = `SELECT $2::text AS lead_id, $3::text AS staff_id`
	ts, err := threads(ctx, q, actor, pair, "", 1)
	if err != nil {
		return domain.ChatThread{}, v, err
	}
	if len(ts) == 0 {
		return domain.ChatThread{}, v, errChatNotFound
	}
	return ts[0], v, nil
}

func chatUnread(ctx context.Context, q querier, v chatView) (domain.ChatUnread, error) {
	var out domain.ChatUnread
	if v.observer {
		return out, nil
	}
	err := q.QueryRow(ctx, `SELECT COALESCE(sum(u), 0), count(*) FILTER (WHERE u > 0) FROM (
			SELECT `+v.unreadSQL()+` AS u FROM (`+v.convs+`) c WHERE $1::text IS NOT NULL) x`, v.args...).
		Scan(&out.Unread, &out.UnreadChats)
	return out, err
}

// ChatUnread is the nav badge: unread messages for the caller's side.
func (s *Store) ChatUnread(ctx context.Context, actor Actor) (domain.ChatUnread, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.ChatUnread{}, err
	}
	v, err := viewFor(ctx, pool, actor)
	if err != nil {
		return domain.ChatUnread{}, err
	}
	return chatUnread(ctx, pool, v)
}

// Chats lists the caller's conversations: for a lead, one per IT staff member.
func (s *Store) Chats(ctx context.Context, actor Actor, f ChatFilter) (domain.ChatList, error) {
	out := domain.ChatList{Items: []domain.ChatThread{}}
	if err := s.purgeExpiredChat(ctx); err != nil {
		return out, err
	}
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 200
	}
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		v, err := viewFor(ctx, tx, actor)
		if err != nil {
			return err
		}
		out.MyStaffID = v.mine
		if out.Items, err = threads(ctx, tx, actor, v, f.Query, f.Limit); err != nil {
			return err
		}
		u, err := chatUnread(ctx, tx, v)
		out.Unread, out.UnreadChats = u.Unread, u.UnreadChats
		return err
	})
	return out, err
}

// ChatMessages reads one conversation: its header and the newest messages
// (oldest first). With after (a message id) only newer messages are returned,
// for polling.
func (s *Store) ChatMessages(ctx context.Context, actor Actor, leadID, staffID, after string) (domain.ChatMessages, error) {
	out := domain.ChatMessages{Messages: []domain.ChatMessage{}}
	if err := s.purgeExpiredChat(ctx); err != nil {
		return out, err
	}
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		t, _, err := thread(ctx, tx, actor, leadID, staffID)
		if err != nil {
			return err
		}
		out.Thread = t
		var rows pgx.Rows
		if after = strings.TrimSpace(after); after != "" {
			rows, err = tx.Query(ctx, messageSelect+` WHERE m.lead_id = $1 AND m.staff_id = $2 AND (m.created_at, m.id) >
				(SELECT a.created_at, a.id FROM chat_messages a WHERE a.id = $3 AND a.lead_id = $1 AND a.staff_id = $2)
				ORDER BY m.created_at, m.id LIMIT $4`, t.Lead.ID, t.Staff.ID, after, domain.MaxThreadMessages)
		} else {
			rows, err = tx.Query(ctx, `SELECT * FROM (`+messageSelect+` WHERE m.lead_id = $1 AND m.staff_id = $2
				ORDER BY m.created_at DESC, m.id DESC LIMIT $3) x ORDER BY 11, 1`, t.Lead.ID, t.Staff.ID, domain.MaxThreadMessages+1)
		}
		if err != nil {
			return err
		}
		if out.Messages, err = scanMessages(rows, actor); err != nil {
			return err
		}
		if out.Messages, err = loadAttachments(ctx, tx, out.Messages); err != nil {
			return err
		}
		if after == "" && len(out.Messages) > domain.MaxThreadMessages {
			out.HasMore = true
			out.Messages = out.Messages[1:]
		}
		return nil
	})
	return out, err
}

// PostChatMessage sends a message in the conversation between a lead and an
// IT staff member, on the caller's own side.
func (s *Store) PostChatMessage(ctx context.Context, actor Actor, leadID, staffID, body string, files []domain.ChatFileIn) (domain.ChatMessage, error) {
	var out domain.ChatMessage
	body = strings.TrimSpace(body)
	if body == "" && len(files) == 0 {
		return out, domain.Invalid("Please fix the highlighted fields.", map[string]string{"body": fmt.Sprintf("Write a message (up to %d characters)", domain.MaxMessageBody)})
	}
	if body != "" {
		var ok bool
		body, ok = domain.NormalizeMessage(body)
		if !ok {
			return out, domain.Invalid("Please fix the highlighted fields.", map[string]string{"body": fmt.Sprintf("Write a message (up to %d characters)", domain.MaxMessageBody)})
		}
	}
	if err := domain.ValidateChatFiles(files); err != nil {
		return out, err
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		t, v, err := thread(ctx, tx, actor, leadID, staffID)
		if err != nil {
			return err
		}
		if v.observer {
			return errChatViewOnly
		}
		if !t.CanPost {
			return errChatClosed
		}
		now := s.Now()
		msgID := NewID("msg")
		if _, err := tx.Exec(ctx, `INSERT INTO chat_messages (id, lead_id, staff_id, side, author_id, author_name, author_role, body, created_at)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8,$9)`,
			msgID, t.Lead.ID, t.Staff.ID, v.side, actor.User.ID, actor.User.Name, actor.User.Role, body, now); err != nil {
			return err
		}
		for _, f := range files {
			if _, err := tx.Exec(ctx, `INSERT INTO chat_message_files (id, message_id, name, content_type, data) VALUES ($1,$2,$3,$4,$5)`,
				NewID("img"), msgID, f.Name, f.ContentType, f.Data); err != nil {
				return err
			}
		}
		// Writing means you have read the conversation up to here.
		if err := markRead(ctx, tx, t.Lead.ID, t.Staff.ID, v.side, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "chat.message", "chat", t.Lead.ID+"/"+t.Staff.ID, map[string]any{
			"leadId": t.Lead.ID, "staffId": t.Staff.ID, "side": v.side, "length": len([]rune(body)), "messageId": msgID}); err != nil {
			return err
		}
		if out, err = scanMessage(tx.QueryRow(ctx, messageSelect+" WHERE m.id = $1", msgID), actor); err != nil {
			return err
		}
		loaded, err := loadAttachments(ctx, tx, []domain.ChatMessage{out})
		if err != nil {
			return err
		}
		out = loaded[0]
		return nil
	})
	return out, err
}

func markRead(ctx context.Context, q querier, leadID, staffID, side string, at time.Time) error {
	_, err := q.Exec(ctx, `INSERT INTO chat_reads (lead_id, staff_id, side, read_at) VALUES ($1,$2,$3,$4)
		ON CONFLICT (lead_id, staff_id, side) DO UPDATE SET read_at = GREATEST(chat_reads.read_at, EXCLUDED.read_at)`, leadID, staffID, side, at)
	return err
}

// MarkChatRead marks the conversation read for the caller's side and returns
// the caller's remaining unread totals. An admin looking in is not IT reading
// it, so it does nothing for them (the lead must not see "Seen").
func (s *Store) MarkChatRead(ctx context.Context, actor Actor, leadID, staffID string) (domain.ChatUnread, error) {
	var out domain.ChatUnread
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		t, v, err := thread(ctx, tx, actor, leadID, staffID)
		if err != nil {
			return err
		}
		if !v.observer {
			if err := markRead(ctx, tx, t.Lead.ID, t.Staff.ID, v.side, s.Now()); err != nil {
				return err
			}
		}
		out, err = chatUnread(ctx, tx, v)
		return err
	})
	return out, err
}

func (s *Store) purgeExpiredChat(ctx context.Context) error {
	pool, err := s.pool()
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `DELETE FROM chat_messages WHERE created_at < $1`, s.Now().Add(-domain.ChatRetention))
	return err
}

func loadAttachments(ctx context.Context, q querier, msgs []domain.ChatMessage) ([]domain.ChatMessage, error) {
	if len(msgs) == 0 {
		return msgs, nil
	}
	ids := make([]string, len(msgs))
	byID := make(map[string]int, len(msgs))
	for i := range msgs {
		ids[i] = msgs[i].ID
		byID[msgs[i].ID] = i
		msgs[i].Attachments = []domain.ChatAttachment{}
	}
	rows, err := q.Query(ctx, `SELECT id, message_id, name, content_type, octet_length(data) FROM chat_message_files WHERE message_id = ANY($1) ORDER BY created_at, id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a domain.ChatAttachment
		var messageID string
		if err := rows.Scan(&a.ID, &messageID, &a.Name, &a.ContentType, &a.Size); err != nil {
			return nil, err
		}
		i, ok := byID[messageID]
		if !ok {
			continue
		}
		m := msgs[i]
		a.URL = "/api/v1/chats/" + m.LeadID + "/" + m.StaffID + "/messages/" + messageID + "/files/" + a.ID
		msgs[i].Attachments = append(msgs[i].Attachments, a)
	}
	return msgs, rows.Err()
}

// ChatFile returns one image from a conversation the caller may open.
func (s *Store) ChatFile(ctx context.Context, actor Actor, leadID, staffID, messageID, fileID string) (name, contentType string, data []byte, err error) {
	err = s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		t, _, err := thread(ctx, tx, actor, leadID, staffID)
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT f.name, f.content_type, f.data
			FROM chat_message_files f
			JOIN chat_messages m ON m.id = f.message_id
			WHERE f.id = $1 AND f.message_id = $2 AND m.lead_id = $3 AND m.staff_id = $4`, fileID, messageID, t.Lead.ID, t.Staff.ID).Scan(&name, &contentType, &data)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NotFound("That image is no longer available.")
		}
		return err
	})
	return name, contentType, data, err
}
