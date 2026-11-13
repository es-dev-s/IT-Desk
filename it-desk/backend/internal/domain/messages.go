package domain

import (
	"strings"
	"time"
	"unicode/utf8"
)

// Request chat (migration 0012): one conversation per IT request between the
// requester's side and IT.
const (
	ChatSideRequester = "requester"
	ChatSideIT        = "it"

	MaxMessageBody = 2000
	// MaxThreadMessages caps one GET of a conversation (newest kept).
	MaxThreadMessages = 500
	// Chat images: a few screenshots per message, kept for one month.
	MaxChatImages     = 3
	MaxChatImageBytes = 2 << 20
	ChatRetention     = 30 * 24 * time.Hour
)

func IsChatSide(s string) bool { return s == ChatSideRequester || s == ChatSideIT }

// ChatSideFor is the side an account reads a request's conversation from: IT
// accounts are IT, team leads are the requester's side, and an admin is the
// requester on requests they raised. On everything else an admin only watches
// (see IsChatObserver); they see it laid out the way IT does.
func ChatSideFor(role, userID string, requesterID *string) string {
	switch role {
	case "it":
		return ChatSideIT
	case "team_lead":
		return ChatSideRequester
	}
	if requesterID != nil && *requesterID == userID {
		return ChatSideRequester
	}
	return ChatSideIT
}

// IsChatObserver: an admin on a request somebody else raised. They can read
// the conversation between the lead and IT but never write in it, and reading
// it does not count as either side having read it.
func IsChatObserver(role, userID string, requesterID *string) bool {
	return role == "admin" && (requesterID == nil || *requesterID != userID)
}

// CanPostAs reports whether an account may send a message as side on a request.
// Everyone speaks only for themselves: IT accounts as IT, team leads as the
// requester, and an admin only as the requester on a request they raised.
// Nobody, admins included, can send as IT without being an IT account.
func CanPostAs(role, userID string, requesterID *string, side string) bool {
	switch role {
	case "admin":
		return side == ChatSideRequester && !IsChatObserver(role, userID, requesterID)
	case "it":
		return side == ChatSideIT
	case "team_lead":
		return side == ChatSideRequester
	}
	return false
}

// NormalizeMessage trims the body, normalises line endings, collapses runs of
// more than two blank lines and checks the length.
func NormalizeMessage(s string) (string, bool) {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	s = strings.TrimSpace(s)
	for strings.Contains(s, "\n\n\n\n") {
		s = strings.ReplaceAll(s, "\n\n\n\n", "\n\n\n")
	}
	n := utf8.RuneCountInString(s)
	return s, n >= 1 && n <= MaxMessageBody
}

// ValidateChatFiles checks count, size and that the bytes are a real image.
// Names are trimmed to a safe file name. The slice is updated in place.
func ValidateChatFiles(files []ChatFileIn) *Error {
	if len(files) > MaxChatImages {
		return Invalid("Please fix the highlighted fields.", map[string]string{"images": "Attach up to 3 images"})
	}
	for i := range files {
		if len(files[i].Data) == 0 || len(files[i].Data) > MaxChatImageBytes {
			return Invalid("Please fix the highlighted fields.", map[string]string{"images": "Each image must be under 2 MB"})
		}
		ct := sniffImage(files[i].Data)
		if ct == "" {
			return Invalid("Please fix the highlighted fields.", map[string]string{"images": "Only PNG, JPEG, GIF and WebP images can be sent"})
		}
		files[i].ContentType = ct
		files[i].Name = cleanImageName(files[i].Name, ct)
	}
	return nil
}

func sniffImage(b []byte) string {
	switch {
	case len(b) >= 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G':
		return "image/png"
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 6 && (string(b[:6]) == "GIF87a" || string(b[:6]) == "GIF89a"):
		return "image/gif"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

func cleanImageName(name, ct string) string {
	name = strings.TrimSpace(name)
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == '"' || r == '\\' {
			return -1
		}
		return r
	}, name)
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[ct]
	if name == "" {
		return "image" + ext
	}
	if utf8.RuneCountInString(name) > 80 {
		name = string([]rune(name)[:80])
	}
	return name
}

// RequestMessage is one chat message. For IT-side messages SenderName is the
// staff member the request is routed to ("IT team" when nobody is); the
// account that actually wrote it is always AuthorName.
type RequestMessage struct {
	ID         string  `json:"id"`
	RequestID  string  `json:"requestId"`
	// Ticket is the REQ id of the request this message belongs to: one
	// conversation spans all of a requester's requests.
	Ticket     string  `json:"ticket"`
	Side       string  `json:"side"`
	SenderName string  `json:"senderName"`
	StaffID    *string `json:"staffId"`
	StaffName  *string `json:"staffName"`
	AuthorID   *string `json:"authorId"`
	AuthorName string  `json:"authorName"`
	AuthorRole string  `json:"authorRole"`
	// OnBehalf: written by an account standing in for the staff member shown.
	OnBehalf  bool   `json:"onBehalf"`
	Mine      bool   `json:"mine"`
	Body        string           `json:"body"`
	Attachments []ChatAttachment `json:"attachments"`
	CreatedAt   Time             `json:"createdAt"`
}

// ChatAttachment is an image on a message. Bytes are fetched from URL.
type ChatAttachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int    `json:"size"`
	URL         string `json:"url"`
}

// ChatFileIn is a decoded image ready to store.
type ChatFileIn struct {
	Name        string
	ContentType string
	Data        []byte
}

// ChatThread is one conversation in GET /chats and the header of a thread.
//
// A conversation is per requester (lead): Request is the one with the latest
// activity (where new messages go by default) and Requests lists all of them,
// newest activity first. Counts, last message and unread span all of them.
type ChatThread struct {
	Request  ITRequest   `json:"request"`
	Requests []ITRequest `json:"requests"`
	// Side is the caller's side on this request (what "unread" is measured for).
	Side string `json:"side"`
	// CanPostAs is empty for an admin watching someone else's conversation (view only).
	CanPostAs    []string        `json:"canPostAs"`
	MessageCount int             `json:"messageCount"`
	Unread       int             `json:"unread"`
	LastMessage  *RequestMessage `json:"lastMessage"`
	// LastActivityAt: the last message, or when the request was raised.
	LastActivityAt Time `json:"lastActivityAt"`
	// OtherReadAt: when the other side last read the conversation ("Seen").
	OtherReadAt *Time `json:"otherReadAt"`
}

type ChatList struct {
	Items []ChatThread `json:"items"`
	// MyStaffID: the caller's own directory entry (IT staff with a login).
	MyStaffID   *string      `json:"myStaffId"`
	Unread      int          `json:"unread"`      // unread messages across every listed thread
	UnreadChats int          `json:"unreadChats"` // threads with at least one unread
}

type ChatMessages struct {
	Thread   ChatThread       `json:"thread"`
	Messages []RequestMessage `json:"messages"`
	// HasMore: older messages exist beyond the newest MaxThreadMessages.
	HasMore bool `json:"hasMore"`
}

// ChatUnread is GET /chats/unread (the nav badge).
// For IT staff with a login it counts only conversations routed to them or to
// nobody; other IT accounts count every IT-side conversation. Admins count
// only replies on requests they raised themselves.
type ChatUnread struct {
	Unread      int `json:"unread"`
	UnreadChats int `json:"unreadChats"`
}
