package auth

// Role is one of the three account types. There is no self sign-up: admins
// create every account.
type Role string

const (
	RoleAdmin    Role = "admin"
	RoleTeamLead Role = "team_lead"
	RoleIT       Role = "it"
)

func (r Role) Valid() bool { return r == RoleAdmin || r == RoleTeamLead || r == RoleIT }

func (r Role) Label() string {
	switch r {
	case RoleAdmin:
		return "Admin"
	case RoleTeamLead:
		return "Team Lead"
	case RoleIT:
		return "IT"
	}
	return string(r)
}

// Permission names one capability. Every API route declares exactly one; the
// router refuses to register a route without one (deny by default).
type Permission string

const (
	PermSelf            Permission = "self"             // own session, profile, preferences, password
	PermViewWorkspace   Permission = "workspace.view"   // dashboard snapshot (scoped per role)
	PermViewTeams       Permission = "teams.view"       // team directory (no people)
	PermViewMembers     Permission = "members.view"     // people & devices (scoped per role)
	PermViewFloor       Permission = "floor.view"       // published floor plans (other teams' names redacted for leads)
	PermManageFloors    Permission = "floors.manage"    // build, publish and re-zone floors (admin)
	PermAssignSeat      Permission = "seats.assign"     // seat a person (admin: anywhere; lead: own zone)
	PermViewTransfers   Permission = "transfers.view"   // transfer requests (scoped per role)
	PermCreateTransfer  Permission = "transfers.create" // seat move / team transfer
	PermUndoTransfer    Permission = "transfers.undo"   // undo own transfer within the window
	PermAdvanceTransfer Permission = "transfers.advance"
	PermViewExits       Permission = "exits.view"
	PermMarkExit        Permission = "exits.create"
	PermUndoExit        Permission = "exits.undo"
	PermViewOverview    Permission = "analytics.view"
	PermViewActivity    Permission = "audit.view"
	PermManageUsers     Permission = "users.manage"
	PermManageMembers   Permission = "members.manage" // add / edit people (leads: own team only)

	// IT requests (equipment / support asks, separate from transfers).
	PermViewRequests   Permission = "requests.view"    // list & read (scoped per role)
	PermCreateRequest  Permission = "requests.create"  // raise a request (admin, team lead)
	PermCancelRequest  Permission = "requests.cancel"  // withdraw own request while open
	PermCommentRequest Permission = "requests.comment" // add to the timeline
	PermFulfilRequest  Permission = "requests.fulfil"  // IT: claim/assign, start, resolve, reject
)

// Matrix is the single source of truth for who can do what. Row-level scoping
// (a team lead only ever sees their own team) is enforced separately in the
// store queries.
var Matrix = map[Role]map[Permission]bool{
	RoleAdmin: set(PermSelf, PermViewWorkspace, PermViewTeams, PermViewMembers, PermViewFloor, PermManageFloors, PermAssignSeat, PermViewTransfers,
		PermViewExits, PermViewOverview, PermViewActivity, PermManageUsers, PermManageMembers,
		PermViewRequests, PermCreateRequest, PermCancelRequest, PermCommentRequest),
	RoleTeamLead: set(PermSelf, PermViewWorkspace, PermViewTeams, PermViewMembers, PermViewFloor, PermAssignSeat, PermViewTransfers,
		PermCreateTransfer, PermUndoTransfer, PermViewExits, PermMarkExit, PermUndoExit, PermViewOverview, PermManageMembers,
		PermViewRequests, PermCreateRequest, PermCancelRequest, PermCommentRequest),
	RoleIT: set(PermSelf, PermViewWorkspace, PermViewTeams, PermViewMembers, PermViewFloor, PermViewTransfers, PermAdvanceTransfer,
		PermViewRequests, PermCommentRequest, PermFulfilRequest),
}

// AllPermissions lists every permission (for tests and the /auth/me payload).
var AllPermissions = []Permission{PermSelf, PermViewWorkspace, PermViewTeams, PermViewMembers, PermViewFloor, PermManageFloors, PermAssignSeat,
	PermViewTransfers, PermCreateTransfer, PermUndoTransfer, PermAdvanceTransfer, PermViewExits, PermMarkExit,
	PermUndoExit, PermViewOverview, PermViewActivity, PermManageUsers, PermManageMembers,
	PermViewRequests, PermCreateRequest, PermCancelRequest, PermCommentRequest, PermFulfilRequest}

func set(ps ...Permission) map[Permission]bool {
	m := make(map[Permission]bool, len(ps))
	for _, p := range ps {
		m[p] = true
	}
	return m
}

// Can reports whether role holds perm. Unknown roles or permissions: no.
func Can(role Role, perm Permission) bool {
	return Matrix[role][perm]
}

// Permissions returns the sorted capability list for a role.
func Permissions(role Role) []Permission {
	var out []Permission
	for _, p := range AllPermissions {
		if Can(role, p) {
			out = append(out, p)
		}
	}
	return out
}
