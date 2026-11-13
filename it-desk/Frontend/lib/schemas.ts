import { z } from "zod";
import { DAY_MS, DEVICE_KINDS, IT_STATUSES, SEAT_CODE_PATTERN } from "./constants";
import { nowMs } from "./clock";
import { userSchema } from "./session";

/* ----------------------------------------------------------------------------
 * Domain schemas. Every API response is validated against these.
 * ------------------------------------------------------------------------- */

export const MEMBER_STATUSES = ["active", "resigned", "unknown"] as const;
export const DIRECTIONS = ["in", "out", "internal"] as const;

export const memberStatusSchema = z.enum(MEMBER_STATUSES);
export const directionSchema = z.enum(DIRECTIONS);
export const itStatusSchema = z.enum(IT_STATUSES);
export const deviceKindSchema = z.enum(DEVICE_KINDS);

const id = z.string().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD format");

export const seatSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(SEAT_CODE_PATTERN, "Use a seat code like L4-A01");

export const teamLeadSchema = z.object({ id, name: z.string() });

/** A team in the directory. Leads and counts are derived by the server; a new team can have no lead and no people. */
export const teamSchema = z.object({
  id,
  slug: z.string().default(""),
  name: z.string().min(2),
  code: z.string().min(2).max(3),
  leadName: z.string(),
  leads: z.array(teamLeadSchema).default([]),
  location: z.string().min(2),
  memberCount: z.number().int().nonnegative().default(0),
  seatsOccupied: z.number().int().nonnegative().default(0),
  seatsTotal: z.number().int().nonnegative().default(0),
});

/** Admin view of an account (GET /admin/users). */
export const managedUserSchema = userSchema.extend({
  status: z.enum(["active", "disabled"]),
  mustChangePassword: z.boolean(),
  hasPassword: z.boolean(),
  lockedUntil: z.iso.datetime({ offset: true }).nullable(),
  failedAttempts: z.number().int(),
  lastLoginAt: z.iso.datetime({ offset: true }).nullable(),
  activeSessions: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  version: z.number().int(),
});
export type ManagedUser = z.infer<typeof managedUserSchema>;

export const deviceSchema = z.object({
  id,
  kind: deviceKindSchema,
  model: z.string().min(2),
  assetTag: z.string().regex(/^IT-[A-Z]{2}-\d{4}$/, "Asset tags look like IT-LP-0142"),
});

export const memberSchema = z.object({
  id,
  name: z.string().min(2),
  /** Optional for members added by hand. */
  email: z.email().or(z.literal("")),
  employeeId: z.string().default(""),
  role: z.string().min(2),
  subGroup: z.string().min(2),
  /** Seat code (e.g. L4-A01); seatId/floorId locate it on a published floor. */
  seat: seatSchema.nullable(),
  seatId: z.string().nullable().default(null),
  floorId: z.string().nullable().default(null),
  /** The team's lead (flag on the record or a lead account with the same email). */
  isLead: z.boolean().default(false),
  teamId: id,
  status: memberStatusSchema,
  joinedAt: isoDate,
  hue: z.number().int().min(0).max(359),
  version: z.number().int().min(0),
  devices: z.array(deviceSchema),
});

/** GET /members/{id}/detail: the member plus a newest-first timeline. */
export const memberHistoryItemSchema = z.object({
  kind: z.enum(["created", "updated", "desk", "team", "transfer", "exit", "request"]).or(z.string()),
  at: z.iso.datetime({ offset: true }),
  actor: z.string().default(""),
  title: z.string(),
  detail: z.string().default(""),
  ticket: z.string().optional(),
  status: z.string().optional(),
  refId: z.string().optional(),
  acknowledgedBy: z.string().nullable().optional(),
  acknowledgedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type MemberHistoryItem = z.infer<typeof memberHistoryItemSchema>;

export const memberDetailSchema = z.object({
  member: memberSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  history: z.array(memberHistoryItemSchema).nullable().transform((v) => v ?? []),
});
export type MemberDetail = z.infer<typeof memberDetailSchema>;

export const moveSchema = z.object({
  memberId: id,
  memberName: z.string().min(2),
  fromSeat: seatSchema.nullable(),
  toSeat: seatSchema.nullable(),
  fromSeatId: z.string().nullable().optional(),
  toSeatId: z.string().nullable().optional(),
  devices: z.array(deviceSchema),
});

export const statusStepSchema = z.object({ status: itStatusSchema, at: z.iso.datetime() });

/** IT has seen it ("Seen by Bikash · working on it"). Null until an IT user acknowledges. */
export const acknowledgementSchema = z.object({
  byId: z.string().nullable(),
  byName: z.string(),
  at: z.iso.datetime({ offset: true }),
});
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

export const transferSchema = z.object({
  id,
  ticket: z.string().regex(/^IT-\d{4}$/),
  direction: directionSchema,
  fromTeamId: id,
  toTeamId: id,
  moves: z.array(moveSchema).min(1),
  effectiveDate: isoDate,
  createdAt: z.iso.datetime(),
  initiatedBy: z.string().min(2),
  note: z.string().max(280),
  itStatus: itStatusSchema,
  history: z.array(statusStepSchema).min(1),
  version: z.number().int().min(0).optional(),
  acknowledgement: acknowledgementSchema.nullable().optional(),
});

export const exitRecordSchema = z.object({
  id,
  /** Exits marked together share a batch; undo works per batch. */
  batchId: z.string().optional(),
  memberId: id,
  memberName: z.string().min(2),
  status: z.enum(["resigned", "unknown"]),
  seat: seatSchema.nullable(),
  seatId: z.string().nullable().optional(),
  effectiveDate: isoDate,
  createdAt: z.iso.datetime(),
  initiatedBy: z.string().min(2),
  reason: z.string().min(2),
});

/* ----------------------------------------------------------------------------
 * Floor plans. A floor is a cols × rows grid of elements; seats are 1×1 with a
 * code unique on the floor and an optional team zone.
 * ------------------------------------------------------------------------- */

export const ELEMENT_KINDS = ["seat", "block", "void", "wall", "door", "room", "label"] as const;
export const elementKindSchema = z.enum(ELEMENT_KINDS);
export type ElementKind = z.infer<typeof elementKindSchema>;

export const floorElementSchema = z.object({
  id,
  kind: elementKindSchema,
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).default(1),
  h: z.number().int().min(1).default(1),
  code: z.string().default(""),
  label: z.string().default(""),
  teamId: z.string().nullable().default(null),
  leadSeat: z.boolean().default(false),
  codeLocked: z.boolean().default(false),
});
export type FloorElement = z.infer<typeof floorElementSchema>;

/** Who sits on a seat. Other teams' people are redacted for leads (leads themselves stay visible). */
export const seatOccupantSchema = z.object({
  memberId: z.string().default(""),
  name: z.string().default(""),
  teamId: z.string(),
  isLead: z.boolean().default(false),
  devices: z.number().int().default(0),
  hue: z.number().int().default(0),
  redacted: z.boolean().default(false),
});
export type SeatOccupant = z.infer<typeof seatOccupantSchema>;

export const floorStatsSchema = z.object({
  seats: z.number().int(),
  occupied: z.number().int(),
  zoned: z.number().int(),
  free: z.number().int(),
  byTeam: z.record(z.string(), z.number().int()).default({}),
  teams: z.array(z.string()).default([]),
});
export type FloorStats = z.infer<typeof floorStatsSchema>;

const floorBase = {
  id,
  buildingId: z.string(),
  name: z.string(),
  level: z.number().int(),
  sortOrder: z.number().int(),
  seatPrefix: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  notes: z.string().default(""),
  status: z.enum(["draft", "published"]),
  version: z.number().int(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  stats: floorStatsSchema,
};

/** A published floor with occupancy (every role). */
export const floorSchema = z.object({
  ...floorBase,
  elements: z.array(floorElementSchema),
  occupants: z.record(z.string(), seatOccupantSchema).nullable().transform((v) => v ?? {}),
});
export type Floor = z.infer<typeof floorSchema>;

/** Floors list entry (admins also see drafts). */
export const floorSummarySchema = z.object({
  ...floorBase,
  draftVersion: z.number().int().default(0),
  hasUnpublishedChanges: z.boolean().default(false),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type FloorSummary = z.infer<typeof floorSummarySchema>;

/** The admin's working copy (autosaved; publishing makes it live). */
export const floorDraftSchema = z.object({
  floorId: id,
  cols: z.number().int(),
  rows: z.number().int(),
  seatPrefix: z.string(),
  elements: z.array(floorElementSchema),
  draftVersion: z.number().int(),
  updatedAt: z.iso.datetime({ offset: true }),
  dirty: z.boolean(),
  issues: z.array(z.string()).default([]),
});
export type FloorDraft = z.infer<typeof floorDraftSchema>;

export const affectedMemberSchema = z.object({
  memberId: id,
  name: z.string(),
  teamId: z.string(),
  fromSeatId: z.string(),
  fromSeat: z.string(),
  toSeatId: z.string().nullable(),
  toSeat: z.string().nullable(),
  action: z.enum(["carry", "relocate", "unseat", "keep", "conflict"]),
});
export type AffectedMember = z.infer<typeof affectedMemberSchema>;

export const zoneChangeResultSchema = z.object({
  id: z.string().default(""),
  dryRun: z.boolean(),
  seatsChanged: z.number().int(),
  affected: z.array(affectedMemberSchema).default([]),
  floors: z.array(z.string()).default([]),
  undoExpiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type ZoneChangeResult = z.infer<typeof zoneChangeResultSchema>;

export const publishResultSchema = z.object({
  floor: floorSchema.optional(),
  dryRun: z.boolean(),
  affected: z.array(affectedMemberSchema).default([]),
  added: z.number().int(),
  removed: z.number().int(),
  changed: z.number().int(),
});
export type PublishResult = z.infer<typeof publishResultSchema>;

/** How a change that hits occupied seats treats the people sitting there. */
export type ConflictMode = "" | "relocate" | "unseat" | "keep";

export const settingsSchema = z.object({
  notifications: z.record(z.string(), z.boolean()),
});

/** GET /api/v1/workspace: one consistent snapshot, scoped to the signed-in user's role. */
export const workspaceSchema = z.object({
  /** "" = the admin's org-wide view ("All teams"). */
  currentTeamId: z.string(),
  user: userSchema,
  teams: z.array(teamSchema),
  members: z.array(memberSchema),
  transfers: z.array(transferSchema),
  exits: z.array(exitRecordSchema),
  /** Published floors with occupancy (other teams' people redacted for leads). */
  floors: z.array(floorSchema).default([]),
  settings: settingsSchema,
  serverTime: z.iso.datetime(),
  undoWindowSeconds: z.number().int().min(0),
  /** Floor layouts are read-only (server FLOOR_LAYOUT_LOCKED): no builder, new floors or publishing. */
  floorLayoutLocked: z.boolean().default(false),
});

export type MemberStatus = z.infer<typeof memberStatusSchema>;
export type Direction = z.infer<typeof directionSchema>;
export type ItStatus = z.infer<typeof itStatusSchema>;
export type DeviceKind = z.infer<typeof deviceKindSchema>;
export type Team = z.infer<typeof teamSchema>;
export type TeamLead = z.infer<typeof teamLeadSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type Member = z.infer<typeof memberSchema>;
export type Move = z.infer<typeof moveSchema>;
export type Transfer = z.infer<typeof transferSchema>;
export type ExitRecord = z.infer<typeof exitRecordSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;

/* ----------------------------------------------------------------------------
 * Form schemas
 * ------------------------------------------------------------------------- */

/** Allowed effective dates: 30 days back to 90 days ahead of (server) today. Same rule as the API. */
function effectiveRange() {
  const today = Math.floor(nowMs() / DAY_MS) * DAY_MS;
  return { min: today - 31 * DAY_MS, max: today + 91 * DAY_MS };
}

export const reasonSchema = z
  .string()
  .trim()
  .min(4, "Add a short reason (at least 4 characters)")
  .max(280, "Keep it under 280 characters");

export const effectiveDateSchema = isoDate.refine((value) => {
  const ms = Date.parse(value);
  const { min, max } = effectiveRange();
  return !Number.isNaN(ms) && ms >= min && ms <= max;
}, "Pick a date between 30 days ago and 90 days ahead");

export const transferModeSchema = z.enum(["internal", "team"]);
export type TransferMode = z.infer<typeof transferModeSchema>;

/** Shape of the stepped transfer flow. Business rules live in transfer-rules.ts. */
export const transferDraftSchema = z.object({
  mode: transferModeSchema,
  toTeamId: z.string().min(1, "Choose a destination team"),
  assignments: z
    .array(z.object({ memberId: id, toSeatId: z.string() }))
    .min(1, "Choose at least one member"),
  devicesByMember: z.record(z.string(), z.array(z.string())),
  effectiveDate: effectiveDateSchema,
  note: z.string().trim().max(280, "Keep the note under 280 characters"),
});
export type TransferDraft = z.input<typeof transferDraftSchema>;

export const exitFormSchema = z.object({
  reason: reasonSchema,
  effectiveDate: effectiveDateSchema,
});

export type FieldErrors = Partial<Record<string, string>>;

export function toFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "form";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
