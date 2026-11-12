package domain

// Notification kinds (mirrors the CHECK constraint, migrations 0005 and 0007).
const (
	NotifyTransferCreated      = "transfer.created"
	NotifyTransferAcknowledged = "transfer.acknowledged"
	NotifyTransferAdvanced     = "transfer.advanced"
	NotifyRequestCreated       = "request.created"
	NotifyRequestAcknowledged  = "request.acknowledged"
	NotifyRequestStatus        = "request.status"
	NotifyRequestAssigned      = "request.assigned"
	NotifyRequestComment       = "request.comment"
	NotifyRequestCancelled     = "request.cancelled"
	NotifyRequestRejected      = "request.rejected"
	NotifyFloorSeats           = "floor.seats" // people moved/unseated by a zone change

	EntityTransfer  = "transfer"
	EntityITRequest = "it_request"
	// Live-only entities (no notification rows).
	EntityMember = "member" // added, edited, exited, restored
	EntityUser   = "user"   // admin account changes (admins only)
	EntityTeam   = "team"   // a team's leads or counts changed
	// EntityFloor is also used as a notification entity type (zone changes).
	EntityFloor = "floor" // published layout, zones or occupancy changed (broadcast)
)

// Notification is one item in a user's bell. It is also the unit of the
// real-time stream: its ID is the SSE event id used for Last-Event-ID resume.
type Notification struct {
	ID         int64   `json:"id"`
	Kind       string  `json:"kind"`
	EntityType string  `json:"entityType"`
	EntityID   string  `json:"entityId"`
	Ticket     string  `json:"ticket"`
	TeamID     *string `json:"teamId"`
	Title      string  `json:"title"`
	Body       string  `json:"body"`
	ActorID    *string `json:"actorId"`
	ActorName  string  `json:"actorName"`
	ReadAt     *Time   `json:"readAt"`
	CreatedAt  Time    `json:"createdAt"`
}

// NotificationPage is GET /notifications: newest first, keyset-paged by id.
type NotificationPage struct {
	Items      []Notification `json:"items"`
	Unread     int            `json:"unread"`
	NextBefore *int64         `json:"nextBefore"`
}

// EntityChange is the payload of a live "entity" event: something the
// recipient can see changed, so lists and open sheets should refresh it.
type EntityChange struct {
	Entity  string `json:"entity"` // transfer | it_request | member | user | team
	ID      string `json:"id"`
	Ticket  string `json:"ticket"`
	Change  string `json:"change"` // created | acknowledged | advanced | status | assigned | comment | cancelled | rejected | withdrawn
	Version int    `json:"version"`
	ActorID string `json:"actorId,omitempty"`
}

// Truncate shortens s to at most n runes, adding an ellipsis when cut.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
