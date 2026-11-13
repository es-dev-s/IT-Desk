package store

// Request chat: messages belong to a request (migration 0012) but a
// conversation spans all of one requester's requests. Scoping is
// the request's: a team lead only ever sees conversations on their own team's
// requests (others are 404). Read state is kept per side.

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"itdesk/backend/internal/domain"
)

var errChatSide = domain.Forbidden("chat_side", "You can’t send messages for that side of this conversation.")

// errChatViewOnly: an admin trying to write in a conversation between a lead and IT.
var errChatViewOnly = domain.Forbidden("chat_view_only", "Admins can read this conversation but can’t reply in it.")

// ChatFilter narrows GET /chats.
type ChatFilter struct {
	Status string // "", "active" (open + in progress) or "closed"
	// Assigned: "" (all), "me" (routed to the caller's own staff entry) or "none".
	Assigned string
	Query    string
	Limit  int
}

// viewerSideSQL is domain.ChatSideFor in SQL; $1 = role, $2 = user id.
const viewerSideSQL = `CASE WHEN $1 = 'it' THEN 'it' WHEN $1 = 'team_lead' THEN 'requester' WHEN r.requester_id = $2 THEN 'requester' ELSE 'it' END`

// unreadSQL counts what the other side sent after vs.side last read. An admin
// watching someone else's conversation (domain.IsChatObserver) has no unread.
const unreadSQL = `(CASE WHEN $1 = 'admin' AND r.requester_id IS DISTINCT FROM $2 THEN 0 ELSE
	(SELECT count(*) FROM it_request_messages um WHERE um.request_id = r.id AND um.side <> vs.side
	AND um.created_at > COALESCE((SELECT cr.read_at FROM it_request_chat_reads cr WHERE cr.request_id = r.id AND cr.side = vs.side), '-infinity')) END)`

const messageSelect = `SELECT m.id, m.request_id, m.side, m.staff_id, m.staff_name, m.author_id, m.author_name, m.author_role,
	(m.side = 'it' AND m.staff_id IS NOT NULL AND st.user_id IS DISTINCT FROM m.author_id), m.body, m.created_at, mr.ticket
	FROM it_request_messages m JOIN it_requests mr ON mr.id = m.request_id LEFT JOIN it_staff st ON st.id = m.staff_id`

func scanMessage(row pgx.Row, actor Actor) (domain.RequestMessage, error) {
	var m domain.RequestMessage
	var at time.Time
	if err := row.Scan(&m.ID, &m.RequestID, &m.Side, &m.StaffID, &m.StaffName, &m.AuthorID, &m.AuthorName, &m.AuthorRole,
		&m.OnBehalf, &m.Body, &at, &m.Ticket); err != nil {
		return m, err
	}
	m.CreatedAt = domain.NewTime(at)
	m.Attachments = []domain.ChatAttachment{}
	m.Mine = m.AuthorID != nil && *m.AuthorID == actor.User.ID
	m.SenderName = m.AuthorName
	if m.Side == domain.ChatSideIT {
		m.SenderName = "IT team"
		if m.StaffName != nil && *m.StaffName != "" {
			m.SenderName = *m.StaffName
		}
	}
	return m, nil
}

func scanMessages(rows pgx.Rows, actor Actor) ([]domain.RequestMessage, error) {
	defer rows.Close()
	out := []domain.RequestMessage{}
	for rows.Next() {
		m, err := scanMessage(rows, actor)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func postSides(actor Actor, requesterID *string) []string {
	out := []string{}
	for _, s := range []string{domain.ChatSideRequester, domain.ChatSideIT} {
		if domain.CanPostAs(actor.User.Role, actor.User.ID, requesterID, s) {
			out = append(out, s)
		}
	}
	return out
}

// requestsByID loads requests (scope already applied by the caller's ids).
func requestsByID(ctx context.Context, q querier, ids []string) (map[string]domain.ITRequest, error) {
	rows, err := q.Query(ctx, requestSelect+" WHERE r.id = ANY($1)", ids)
	if err != nil {
		return nil, err
	}
	list, err := scanRequests(rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]domain.ITRequest, len(list))
	for _, r := range list {
		out[r.ID] = r
	}
	return out, nil
}

// threadsFor builds the chat summary (side, counts, last message, read state)
// for already-scoped request ids, in the order given.
func threadsFor(ctx context.Context, q querier, actor Actor, ids []string) ([]domain.ChatThread, error) {
	out := []domain.ChatThread{}
	if len(ids) == 0 {
		return out, nil
	}
	reqs, err := requestsByID(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	rows, err := q.Query(ctx, `SELECT r.id, vs.side,
			(SELECT count(*) FROM it_request_messages cm WHERE cm.request_id = r.id), `+unreadSQL+`,
			GREATEST(r.created_at, COALESCE((SELECT max(lm.created_at) FROM it_request_messages lm WHERE lm.request_id = r.id), r.created_at)),
			(SELECT cr.read_at FROM it_request_chat_reads cr WHERE cr.request_id = r.id AND cr.side <> vs.side),
			(SELECT lm.id FROM it_request_messages lm WHERE lm.request_id = r.id ORDER BY lm.created_at DESC, lm.id DESC LIMIT 1)
		FROM it_requests r CROSS JOIN LATERAL (SELECT `+viewerSideSQL+` AS side) vs
		WHERE r.id = ANY($3)`, actor.User.Role, actor.User.ID, ids)
	if err != nil {
		return nil, err
	}
	type stat struct {
		side          string
		count, unread int
		last          time.Time
		otherRead     *time.Time
		lastID        *string
	}
	stats := map[string]stat{}
	var lastIDs []string
	for rows.Next() {
		var id string
		var st stat
		if err := rows.Scan(&id, &st.side, &st.count, &st.unread, &st.last, &st.otherRead, &st.lastID); err != nil {
			rows.Close()
			return nil, err
		}
		stats[id] = st
		if st.lastID != nil {
			lastIDs = append(lastIDs, *st.lastID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	last := map[string]domain.RequestMessage{}
	if len(lastIDs) > 0 {
		mrows, err := q.Query(ctx, messageSelect+" WHERE m.id = ANY($1)", lastIDs)
		if err != nil {
			return nil, err
		}
		msgs, err := scanMessages(mrows, actor)
		if err != nil {
			return nil, err
		}
		msgs, err = loadAttachments(ctx, q, msgs)
		if err != nil {
			return nil, err
		}
		for _, m := range msgs {
			last[m.RequestID] = m
		}
	}
	for _, id := range ids {
		r, ok := reqs[id]
		st, ok2 := stats[id]
		if !ok || !ok2 {
			continue
		}
		t := domain.ChatThread{Request: r, Side: st.side, CanPostAs: postSides(actor, r.RequesterID), MessageCount: st.count, Unread: st.unread,
			LastActivityAt: domain.NewTime(st.last)}
		if m, ok := last[id]; ok {
			t.LastMessage = &m
		}
		if st.otherRead != nil {
			v := domain.NewTime(*st.otherRead)
			t.OtherReadAt = &v
		}
		out = append(out, t)
	}
	return out, nil
}

// mergeThreads folds the per-request summaries of one requester (newest
// activity first) into a single conversation.
func mergeThreads(ts []domain.ChatThread) domain.ChatThread {
	out := ts[0]
	out.Requests = make([]domain.ITRequest, 0, len(ts))
	for i, t := range ts {
		out.Requests = append(out.Requests, t.Request)
		if i == 0 {
			continue
		}
		out.MessageCount += t.MessageCount
		out.Unread += t.Unread
		if t.LastMessage != nil && (out.LastMessage == nil || t.LastMessage.CreatedAt.After(out.LastMessage.CreatedAt.Time)) {
			out.LastMessage = t.LastMessage
		}
		if t.LastActivityAt.After(out.LastActivityAt.Time) {
			out.LastActivityAt = t.LastActivityAt
		}
		if t.OtherReadAt != nil && (out.OtherReadAt == nil || t.OtherReadAt.After(out.OtherReadAt.Time)) {
			out.OtherReadAt = t.OtherReadAt
		}
	}
	return out
}

// conversationIDs returns every in-scope request of the same requester as id
// (id included), newest activity first. Empty when id is out of scope.
func conversationIDs(ctx context.Context, q querier, actor Actor, id string) ([]string, error) {
	scope, args := chatScope(actor, []any{id})
	return queryIDs(ctx, q, `SELECT r.id FROM it_requests r
		WHERE COALESCE(r.requester_id, r.id) = (SELECT COALESCE(b.requester_id, b.id) FROM it_requests b WHERE b.id = $1) AND `+scope+`
		ORDER BY GREATEST(r.created_at, COALESCE((SELECT max(m.created_at) FROM it_request_messages m WHERE m.request_id = r.id), r.created_at)) DESC, r.id`, args...)
}

func queryIDs(ctx context.Context, q querier, sql string, args ...any) ([]string, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// scopeWhere returns the team-scope condition (args start at $3: $1/$2 are
// reserved for the viewer-side expression).
func chatScope(actor Actor, args []any) (string, []any) {
	if scope := actor.TeamScope(); scope != "" {
		args = append(args, scope)
		return fmt.Sprintf("r.team_id = $%d", len(args)), args
	}
	return "TRUE", args
}

func chatUnread(ctx context.Context, q querier, actor Actor) (domain.ChatUnread, error) {
	var out domain.ChatUnread
	scope, args := chatScope(actor, []any{actor.User.Role, actor.User.ID})
	// Staff with their own login: the badge is about their conversations.
	if actor.User.Role == "it" {
		mine, err := myStaffEntry(ctx, q, actor)
		if err != nil {
			return out, err
		}
		if mine != nil {
			args = append(args, *mine)
			scope += fmt.Sprintf(" AND (r.staff_id = $%d OR r.staff_id IS NULL)", len(args))
		}
	}
	err := q.QueryRow(ctx, `SELECT COALESCE(sum(u), 0), count(*) FILTER (WHERE u > 0) FROM (
			SELECT sum(u) AS u FROM (SELECT COALESCE(r.requester_id, r.id) AS conv, `+unreadSQL+` AS u FROM it_requests r CROSS JOIN LATERAL (SELECT `+viewerSideSQL+` AS side) vs
			WHERE `+scope+` AND EXISTS (SELECT 1 FROM it_request_messages em WHERE em.request_id = r.id)) x GROUP BY conv) t`, args...).
		Scan(&out.Unread, &out.UnreadChats)
	return out, err
}

// ChatUnread is the nav badge: unread messages for the caller's side(s).
func (s *Store) ChatUnread(ctx context.Context, actor Actor) (domain.ChatUnread, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.ChatUnread{}, err
	}
	return chatUnread(ctx, pool, actor)
}

// Chats lists conversations in scope, most recent activity first. Every
// request has a conversation (it may still be empty).
func (s *Store) Chats(ctx context.Context, actor Actor, f ChatFilter) (domain.ChatList, error) {
	if err := s.purgeExpiredChat(ctx); err != nil {
		return domain.ChatList{}, err
	}
	out := domain.ChatList{Items: []domain.ChatThread{}}
	pool, err := s.pool()
	if err != nil {
		return out, err
	}
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 100
	}
	scope, args := chatScope(actor, []any{actor.User.Role, actor.User.ID})
	conds := []string{scope}
	switch f.Status {
	case "", "all":
	case "active":
		conds = append(conds, "r.status IN ('open','in_progress')")
	case "closed":
		conds = append(conds, "r.status IN ('resolved','cancelled','rejected')")
	default:
		return out, domain.Invalid("Unknown status filter.", map[string]string{"status": "Unknown status"})
	}
	mine, err := myStaffEntry(ctx, pool, actor)
	if err != nil {
		return out, err
	}
	out.MyStaffID = mine
	switch f.Assigned {
	case "":
	case "me":
		if mine == nil {
			conds = append(conds, "FALSE")
		} else {
			args = append(args, *mine)
			conds = append(conds, fmt.Sprintf("r.staff_id = $%d", len(args)))
		}
	case "none":
		conds = append(conds, "r.staff_id IS NULL")
	default:
		return out, domain.Invalid("Unknown assignment filter.", map[string]string{"assigned": "Use me or none"})
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		if len(q) > 100 {
			q = q[:100]
		}
		args = append(args, "%"+strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)+"%")
		p := fmt.Sprintf("$%d", len(args))
		conds = append(conds, fmt.Sprintf(`(r.ticket ILIKE %[1]s OR r.title ILIKE %[1]s OR r.notes ILIKE %[1]s OR r.requester_name ILIKE %[1]s
			OR COALESCE(r.staff_name,'') ILIKE %[1]s OR COALESCE(t.name,'') ILIKE %[1]s
			OR EXISTS (SELECT 1 FROM it_request_items i WHERE i.request_id = r.id AND (i.kind ILIKE %[1]s OR i.description ILIKE %[1]s))
			OR EXISTS (SELECT 1 FROM it_request_messages qm WHERE qm.request_id = r.id AND qm.body ILIKE %[1]s))`, p))
	}
	err = s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT r.id FROM it_requests r LEFT JOIN teams t ON t.id = r.team_id
			WHERE ($1::text IS NOT NULL AND $2::text IS NOT NULL) AND `+strings.Join(conds, " AND ")+`
			ORDER BY GREATEST(r.created_at, COALESCE((SELECT max(m.created_at) FROM it_request_messages m WHERE m.request_id = r.id), r.created_at)) DESC, r.id
			LIMIT `+fmt.Sprint(f.Limit), args...)
		if err != nil {
			return err
		}
		var matched []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			matched = append(matched, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		out.Items, err = conversationsFor(ctx, tx, actor, matched)
		if err != nil {
			return err
		}
		u, err := chatUnread(ctx, tx, actor)
		out.Unread, out.UnreadChats = u.Unread, u.UnreadChats
		return err
	})
	return out, err
}

// conversationsFor builds one conversation per requester for the matched
// requests, ordered by the first match. Each spans all of that requester's
// in-scope requests, not only the matching ones.
func conversationsFor(ctx context.Context, q querier, actor Actor, matched []string) ([]domain.ChatThread, error) {
	out := []domain.ChatThread{}
	if len(matched) == 0 {
		return out, nil
	}
	scope, args := chatScope(actor, []any{matched})
	all, err := queryIDs(ctx, q, `SELECT r.id FROM it_requests r
		WHERE COALESCE(r.requester_id, r.id) IN (SELECT COALESCE(b.requester_id, b.id) FROM it_requests b WHERE b.id = ANY($1)) AND `+scope, args...)
	if err != nil {
		return nil, err
	}
	threads, err := threadsFor(ctx, q, actor, all)
	if err != nil {
		return nil, err
	}
	conv := map[string]string{} // request id -> requester key
	for _, t := range threads {
		k := t.Request.ID
		if t.Request.RequesterID != nil {
			k = *t.Request.RequesterID
		}
		conv[t.Request.ID] = k
	}
	groups := map[string][]domain.ChatThread{}
	for _, t := range threads {
		groups[conv[t.Request.ID]] = append(groups[conv[t.Request.ID]], t)
	}
	done := map[string]bool{}
	for _, id := range matched {
		k, ok := conv[id]
		if !ok || done[k] {
			continue
		}
		done[k] = true
		g := groups[k]
		sort.SliceStable(g, func(i, j int) bool { return g[i].LastActivityAt.After(g[j].LastActivityAt.Time) })
		out = append(out, mergeThreads(g))
	}
	return out, nil
}

// chatRequestInScope returns the id if the request exists in the caller's scope.
func chatRequestInScope(ctx context.Context, q querier, actor Actor, id string) error {
	var team *string
	err := q.QueryRow(ctx, `SELECT team_id FROM it_requests WHERE id = $1`, id).Scan(&team)
	if errors.Is(err, pgx.ErrNoRows) {
		return errRequestNotFound
	}
	if err != nil {
		return err
	}
	if scope := actor.TeamScope(); scope != "" && (team == nil || *team != scope) {
		return errRequestNotFound
	}
	return nil
}

// ChatMessages reads one conversation: its header and the newest messages
// (oldest first). With after (a message id) only newer messages are returned,
// for polling.
func (s *Store) ChatMessages(ctx context.Context, actor Actor, id, after string) (domain.ChatMessages, error) {
	out := domain.ChatMessages{Messages: []domain.RequestMessage{}}
	if err := s.purgeExpiredChat(ctx); err != nil {
		return out, err
	}
	err := s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		if err := chatRequestInScope(ctx, tx, actor, id); err != nil {
			return err
		}
		ids, err := conversationIDs(ctx, tx, actor, id)
		if err != nil {
			return err
		}
		threads, err := conversationsFor(ctx, tx, actor, ids[:min(1, len(ids))])
		if err != nil {
			return err
		}
		if len(threads) == 0 {
			return errRequestNotFound
		}
		out.Thread = threads[0]
		var rows pgx.Rows
		if after = strings.TrimSpace(after); after != "" {
			rows, err = tx.Query(ctx, messageSelect+` WHERE m.request_id = ANY($1) AND (m.created_at, m.id) >
				(SELECT a.created_at, a.id FROM it_request_messages a WHERE a.id = $2 AND a.request_id = ANY($1))
				ORDER BY m.created_at, m.id LIMIT $3`, ids, after, domain.MaxThreadMessages)
		} else {
			rows, err = tx.Query(ctx, `SELECT * FROM (`+messageSelect+` WHERE m.request_id = ANY($1) ORDER BY m.created_at DESC, m.id DESC LIMIT $2) x
				ORDER BY 11, 1`, ids, domain.MaxThreadMessages+1)
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

// PostChatMessage sends a message on a request in scope. as names the side
// ("" = the caller's own side) and must be the caller's own: nobody speaks for
// the other side, and an admin can only write on requests they raised (others
// are view only). IT-side messages carry the staff member shown: the caller's
// own directory entry, else the one the request is routed to.
func (s *Store) PostChatMessage(ctx context.Context, actor Actor, id, body, as string, files []domain.ChatFileIn) (domain.RequestMessage, error) {
	var out domain.RequestMessage
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
	as = strings.TrimSpace(as)
	if as != "" && !domain.IsChatSide(as) {
		return out, domain.Invalid("Please fix the highlighted fields.", map[string]string{"as": "Choose requester or it"})
	}
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		r, err := lockRequest(ctx, tx, actor, id, nil)
		if err != nil {
			return err
		}
		side := as
		if side == "" {
			side = domain.ChatSideFor(actor.User.Role, actor.User.ID, r.requesterID)
		}
		if domain.IsChatObserver(actor.User.Role, actor.User.ID, r.requesterID) {
			return errChatViewOnly
		}
		if !domain.CanPostAs(actor.User.Role, actor.User.ID, r.requesterID, side) {
			return errChatSide
		}
		var staffID, staffName *string
		if side == domain.ChatSideIT {
			var sid, sname string
			err := tx.QueryRow(ctx, `SELECT id, name FROM it_staff WHERE user_id = $1 AND active`, actor.User.ID).Scan(&sid, &sname)
			switch {
			case err == nil:
				staffID, staffName = &sid, &sname
			case errors.Is(err, pgx.ErrNoRows):
				if err := tx.QueryRow(ctx, `SELECT staff_id, staff_name FROM it_requests WHERE id = $1`, id).Scan(&staffID, &staffName); err != nil {
					return err
				}
			default:
				return err
			}
		}
		now := s.Now()
		msgID := NewID("msg")
		if _, err := tx.Exec(ctx, `INSERT INTO it_request_messages (id, request_id, side, author_id, author_name, author_role, staff_id, staff_name, body, created_at)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10)`,
			msgID, id, side, actor.User.ID, actor.User.Name, actor.User.Role, staffID, staffName, body, now); err != nil {
			return err
		}
		for _, f := range files {
			if _, err := tx.Exec(ctx, `INSERT INTO it_request_message_files (id, message_id, name, content_type, data) VALUES ($1,$2,$3,$4,$5)`,
				NewID("img"), msgID, f.Name, f.ContentType, f.Data); err != nil {
				return err
			}
		}
		// Writing means you have read the conversation up to here.
		if err := markRead(ctx, tx, id, side, now); err != nil {
			return err
		}
		if err := audit(ctx, tx, actor, "it_request.message", "it_request", id, map[string]any{
			"ticket": r.ticket, "side": side, "staffId": staffID, "length": len([]rune(body)), "messageId": msgID}); err != nil {
			return err
		}
		out, err = scanMessage(tx.QueryRow(ctx, messageSelect+" WHERE m.id = $1", msgID), actor)
		if err != nil {
			return err
		}
		loaded, err := loadAttachments(ctx, tx, []domain.RequestMessage{out})
		if err != nil {
			return err
		}
		out = loaded[0]
		return nil
	})
	return out, err
}

func markRead(ctx context.Context, q querier, id, side string, at time.Time) error {
	_, err := q.Exec(ctx, `INSERT INTO it_request_chat_reads (request_id, side, read_at) VALUES ($1,$2,$3)
		ON CONFLICT (request_id, side) DO UPDATE SET read_at = GREATEST(it_request_chat_reads.read_at, EXCLUDED.read_at)`, id, side, at)
	return err
}

// MarkChatRead marks the conversation read for the caller's side and returns
// the caller's remaining unread totals. It does nothing for an admin watching
// a conversation they are not part of.
func (s *Store) MarkChatRead(ctx context.Context, actor Actor, id string) (domain.ChatUnread, error) {
	var out domain.ChatUnread
	err := s.withTx(ctx, writeTx, func(tx pgx.Tx) error {
		if err := chatRequestInScope(ctx, tx, actor, id); err != nil {
			return err
		}
		ids, err := conversationIDs(ctx, tx, actor, id)
		if err != nil {
			return err
		}
		now := s.Now()
		for _, rid := range ids {
			var requester *string
			if err := tx.QueryRow(ctx, `SELECT requester_id FROM it_requests WHERE id = $1`, rid).Scan(&requester); err != nil {
				return err
			}
			// An admin looking in is not IT reading it: the lead must not see "Seen".
			if domain.IsChatObserver(actor.User.Role, actor.User.ID, requester) {
				continue
			}
			if err := markRead(ctx, tx, rid, domain.ChatSideFor(actor.User.Role, actor.User.ID, requester), now); err != nil {
				return err
			}
		}
		out, err = chatUnread(ctx, tx, actor)
		return err
	})
	return out, err
}

func (s *Store) purgeExpiredChat(ctx context.Context) error {
	pool, err := s.pool()
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `DELETE FROM it_request_messages WHERE created_at < $1`, s.Now().Add(-domain.ChatRetention))
	return err
}

func loadAttachments(ctx context.Context, q querier, msgs []domain.RequestMessage) ([]domain.RequestMessage, error) {
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
	rows, err := q.Query(ctx, `SELECT id, message_id, name, content_type, octet_length(data) FROM it_request_message_files WHERE message_id = ANY($1) ORDER BY created_at, id`, ids)
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
		a.URL = "/api/v1/it-requests/" + msgs[i].RequestID + "/messages/" + messageID + "/files/" + a.ID
		msgs[i].Attachments = append(msgs[i].Attachments, a)
	}
	return msgs, rows.Err()
}

// ChatFile returns one image the caller is allowed to see on this request.
func (s *Store) ChatFile(ctx context.Context, actor Actor, requestID, messageID, fileID string) (name, contentType string, data []byte, err error) {
	err = s.withTx(ctx, snapshotTx, func(tx pgx.Tx) error {
		if err := chatRequestInScope(ctx, tx, actor, requestID); err != nil {
			return err
		}
		err := tx.QueryRow(ctx, `SELECT f.name, f.content_type, f.data
			FROM it_request_message_files f
			JOIN it_request_messages m ON m.id = f.message_id
			WHERE f.id = $1 AND f.message_id = $2 AND m.request_id = $3`, fileID, messageID, requestID).Scan(&name, &contentType, &data)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NotFound("That image is no longer available.")
		}
		return err
	})
	return name, contentType, data, err
}
