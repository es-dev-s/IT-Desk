package domain

import (
	"strings"
	"time"
	"unicode/utf8"
)

// Direct messages (migration 0014): one continuous conversation per team lead
// and IT staff member, not tied to any request.
const (
	ChatSideLead = "lead"
	ChatSideIT   = "it"

	MaxMessageBody = 2000
	// MaxThreadMessages caps one GET of a conversation (newest kept).
	MaxThreadMessages = 500
	// Chat images: a few screenshots per message, kept for one month.
	MaxChatImages     = 3
	MaxChatImageBytes = 2 << 20
	ChatRetention     = 30 * 24 * time.Hour
)

// ChatSideFor is the side an account reads conversations from: team leads are
// the lead side, everyone else (IT, and admins watching) sees it the way IT does.
func ChatSideFor(role string) string {
	if role == "team_lead" {
		return ChatSideLead
	}
	return ChatSideIT
}

// IsChatObserver: admins can read every conversation between a lead and IT
// but never write in one, and reading it does not count as either side having
// read it.
func IsChatObserver(role string) bool { return role == "admin" }

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

// ChatMessage is one message in a lead ↔ IT conversation. IT-side messages
// are shown as the conversation's staff member (SenderName); the account that
// actually wrote it is always AuthorName.
type ChatMessage struct {
	ID         string  `json:"id"`
	LeadID     string  `json:"leadId"`
	StaffID    string  `json:"staffId"`
	Side       string  `json:"side"`
	SenderName string  `json:"senderName"`
	AuthorID   *string `json:"authorId"`
	AuthorName string  `json:"authorName"`
	AuthorRole string  `json:"authorRole"`
	// OnBehalf: an IT account without its own directory entry wrote it for the staff member shown.
	OnBehalf    bool             `json:"onBehalf"`
	Mine        bool             `json:"mine"`
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

// ChatLead is the team lead in a conversation.
type ChatLead struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	TeamID   *string `json:"teamId"`
	TeamName *string `json:"teamName"`
}

// ChatStaff is the IT staff member in a conversation.
type ChatStaff struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Title  string `json:"title"`
	Active bool   `json:"active"`
}

// ChatThread is one conversation in GET /chats and the header of a thread.
// A team lead has one with every active IT staff member (empty until someone
// writes); IT and admins list the conversations that have messages.
type ChatThread struct {
	Lead  ChatLead  `json:"lead"`
	Staff ChatStaff `json:"staff"`
	// Side is the caller's side (what "unread" is measured for).
	Side string `json:"side"`
	// CanPost is false for an admin (view only) and for a lead whose IT
	// contact has left the directory.
	CanPost      bool         `json:"canPost"`
	MessageCount int          `json:"messageCount"`
	Unread       int          `json:"unread"`
	LastMessage  *ChatMessage `json:"lastMessage"`
	// LastActivityAt: the last message; null for a conversation not started yet.
	LastActivityAt *Time `json:"lastActivityAt"`
	// OtherReadAt: when the other side last read the conversation ("Seen").
	OtherReadAt *Time `json:"otherReadAt"`
}

type ChatList struct {
	Items []ChatThread `json:"items"`
	// MyStaffID: the caller's own directory entry (IT staff with a login).
	MyStaffID   *string `json:"myStaffId"`
	Unread      int     `json:"unread"`      // unread messages across the caller's conversations
	UnreadChats int     `json:"unreadChats"` // conversations with at least one unread
}

type ChatMessages struct {
	Thread   ChatThread    `json:"thread"`
	Messages []ChatMessage `json:"messages"`
	// HasMore: older messages exist beyond the newest MaxThreadMessages.
	HasMore bool `json:"hasMore"`
}

// ChatUnread is GET /chats/unread (the nav badge). Leads count their own
// conversations; IT staff with a login count theirs; other IT accounts count
// every conversation. Admins only watch, so theirs is always zero.
type ChatUnread struct {
	Unread      int `json:"unread"`
	UnreadChats int `json:"unreadChats"`
}
