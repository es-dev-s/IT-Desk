import type { Permission, User } from "./session";
import type { RosterEntry } from "./schemas";

/**
 * Whether a roster entry is the signed-in team lead's own record: their
 * unrostered account, or the lead roster record on their team with their email.
 */
export function isSelfEntry(entry: RosterEntry, user: User): boolean {
  if (user.role !== "team_lead") return false;
  if (!("status" in entry)) return entry.id === user.id;
  return entry.isLead && entry.teamId === user.teamId && Boolean(entry.email) && entry.email.toLowerCase() === user.email.toLowerCase();
}

/**
 * A lead's seat is picked directly (no transfer): by an admin for any lead,
 * or by a team lead for themselves.
 */
export function canPickLeadSeat(entry: RosterEntry, self: boolean, can: (permission: Permission) => boolean): boolean {
  if (!can("seats.assign")) return false;
  const lead = "status" in entry ? entry.isLead && entry.status === "active" : true;
  return lead && (self || !can("transfers.create"));
}
