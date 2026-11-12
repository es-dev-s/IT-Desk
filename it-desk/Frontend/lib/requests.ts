import { z } from "zod";
import { newIdempotencyKey, request } from "./api";
import { acknowledgementSchema } from "./schemas";

/* ----------------------------------------------------------------------------
 * IT requests: equipment asks and reported issues raised by admins and team
 * leads, fulfilled by IT. Separate from transfers (no seat or member move).
 * Both types share tickets (REQ-…), scoping and the IT workflow; an issue has
 * a category + title instead of items, and `notes` is its description.
 * The API is the authority for every rule below; these mirror it so the form
 * can explain problems before a round trip.
 * ------------------------------------------------------------------------- */

export const REQUEST_TYPES = ["equipment", "issue"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const ISSUE_CATEGORIES = ["hardware", "network", "software", "access", "other"] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const TYPE_LABEL: Record<RequestType, string> = { equipment: "Equipment", issue: "Issue" };

export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  hardware: "Hardware",
  network: "Network",
  software: "Software",
  access: "Access",
  other: "Other",
};

export const CATEGORY_HINT: Record<IssueCategory, string> = {
  hardware: "Laptop, screen, keyboard",
  network: "Wi‑Fi, internet, VPN",
  software: "Crash or install",
  access: "Login or password",
  other: "Something else",
};

export const REQUEST_KINDS = ["laptop", "headphone", "mouse", "cpu", "other"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

export const REQUEST_STATUSES = ["open", "in_progress", "resolved", "cancelled", "rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_LIMITS = {
  maxQuantity: 10,
  minNotes: 5,
  maxNotes: 1000,
  maxDescription: 120,
  maxComment: 1000,
  maxResolution: 500,
  minTitle: 3,
  maxTitle: 120,
  maxDevice: 80,
} as const;

export const KIND_LABEL: Record<RequestKind, string> = {
  laptop: "Laptop",
  headphone: "Headphones",
  mouse: "Mouse",
  cpu: "CPU",
  other: "Other",
};

export const KIND_HINT: Record<RequestKind, string> = {
  laptop: "New or replacement",
  headphone: "Headset for calls",
  mouse: "Wired or wireless",
  cpu: "Desktop tower",
  other: "Describe it",
};

export const PRIORITY_LABEL: Record<RequestPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const STATUS_LABEL: Record<RequestStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  cancelled: "Cancelled",
  rejected: "Rejected",
};

export const isClosed = (s: RequestStatus) => s === "resolved" || s === "cancelled" || s === "rejected";

const iso = z.iso.datetime({ offset: true });

export const requestItemSchema = z.object({
  kind: z.enum(REQUEST_KINDS),
  quantity: z.number().int().min(1).max(REQUEST_LIMITS.maxQuantity),
  description: z.string(),
});
export type RequestItem = z.infer<typeof requestItemSchema>;

export const itRequestSchema = z.object({
  id: z.string().min(1),
  ticket: z.string().min(1),
  type: z.enum(REQUEST_TYPES).catch("equipment"),
  status: z.enum(REQUEST_STATUSES),
  priority: z.enum(REQUEST_PRIORITIES),
  items: z.array(requestItemSchema),
  category: z.enum(ISSUE_CATEGORIES).nullable().catch(null),
  title: z.string().catch(""),
  device: z.string().catch(""),
  notes: z.string(),
  requesterId: z.string().nullable(),
  requesterName: z.string(),
  requesterRole: z.string(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  teamCode: z.string().nullable(),
  forMemberId: z.string().nullable(),
  forMemberName: z.string().nullable(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  staffId: z.string().nullable().catch(null),
  staffName: z.string().nullable().catch(null),
  staffTitle: z.string().nullable().catch(null),
  resolution: z.string(),
  commentCount: z.number().int().min(0),
  createdAt: iso,
  updatedAt: iso,
  startedAt: iso.nullable(),
  closedAt: iso.nullable(),
  version: z.number().int().min(0),
  acknowledgement: acknowledgementSchema.nullable().optional(),
});
export type ITRequest = z.infer<typeof itRequestSchema>;

export const requestEventSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["created", "acknowledged", "assigned", "status", "comment", "cancelled", "rejected"]),
  actorId: z.string().nullable(),
  actorName: z.string(),
  actorRole: z.string(),
  body: z.string(),
  fromStatus: z.string().nullable(),
  toStatus: z.string().nullable(),
  at: iso,
});
export type RequestEvent = z.infer<typeof requestEventSchema>;

export const requestDetailSchema = itRequestSchema.extend({ events: z.array(requestEventSchema) });
export type ITRequestDetail = z.infer<typeof requestDetailSchema>;

export const requestCountsSchema = z.object({
  open: z.number().int(),
  inProgress: z.number().int(),
  resolved: z.number().int(),
  cancelled: z.number().int(),
  rejected: z.number().int(),
  total: z.number().int(),
  unassigned: z.number().int(),
  activeIssues: z.number().int().catch(0),
});
export type RequestCounts = z.infer<typeof requestCountsSchema>;

const requestListSchema = z.object({
  items: z.array(itRequestSchema),
  total: z.number().int(),
  counts: requestCountsSchema,
});
export type RequestList = z.infer<typeof requestListSchema>;

export const assigneeSchema = z.object({ id: z.string(), name: z.string(), title: z.string(), open: z.number().int() });
export type Assignee = z.infer<typeof assigneeSchema>;

/* ----------------------------------------------------------------------------
 * Form schema (Zod). Error paths match the API's field keys.
 * ------------------------------------------------------------------------- */

export const requestFormSchema = z
  .object({
    type: z.enum(REQUEST_TYPES),
    items: z
      .array(
        z.object({
          kind: z.enum(REQUEST_KINDS),
          quantity: z.number().int().min(1, "At least 1").max(REQUEST_LIMITS.maxQuantity, `At most ${REQUEST_LIMITS.maxQuantity}`),
          description: z.string().trim().max(REQUEST_LIMITS.maxDescription, `Keep it under ${REQUEST_LIMITS.maxDescription} characters`),
        }),
      ),
    category: z.union([z.enum(ISSUE_CATEGORIES), z.literal("")]),
    title: z.string().trim().max(REQUEST_LIMITS.maxTitle, `Keep the title under ${REQUEST_LIMITS.maxTitle} characters`),
    device: z.string().trim().max(REQUEST_LIMITS.maxDevice, `Keep it under ${REQUEST_LIMITS.maxDevice} characters`),
    notes: z
      .string()
      .trim()
      .min(REQUEST_LIMITS.minNotes, `Add a short note (at least ${REQUEST_LIMITS.minNotes} characters)`)
      .max(REQUEST_LIMITS.maxNotes, `Keep notes under ${REQUEST_LIMITS.maxNotes} characters`),
    priority: z.enum(REQUEST_PRIORITIES),
    forMemberId: z.string(),
    teamId: z.string(),
    staffId: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "issue") {
      if (!v.category) ctx.addIssue({ code: "custom", path: ["category"], message: "Choose what kind of issue it is" });
      if (v.title.length < REQUEST_LIMITS.minTitle)
        ctx.addIssue({ code: "custom", path: ["title"], message: "Sum it up in a few words" });
      return;
    }
    if (v.items.length === 0) ctx.addIssue({ code: "custom", path: ["items"], message: "Pick at least one item" });
    v.items.forEach((it, i) => {
      if (it.kind === "other" && it.description.length < 2)
        ctx.addIssue({ code: "custom", path: ["items", i, "description"], message: "Say what you need" });
    });
  });
export type RequestForm = z.infer<typeof requestFormSchema>;

/** A blank "Request IT" form (equipment by default). */
export const EMPTY_REQUEST_FORM: RequestForm = {
  type: "equipment",
  items: [],
  category: "",
  title: "",
  device: "",
  notes: "",
  priority: "normal",
  forMemberId: "",
  teamId: "",
  staffId: "",
};

/** Flattens Zod issues to `items.0.description`-style keys (same as the API). */
export function formErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** One-line "what is it": the issue title, or the item list for equipment. */
export function requestSummary(r: Pick<ITRequest, "type" | "items" | "title" | "category">) {
  if (r.type === "issue") return r.title || (r.category ? `${CATEGORY_LABEL[r.category]} issue` : "Issue");
  return itemSummary(r.items);
}

export function itemSummary(items: RequestItem[]) {
  return items
    .map((it) => {
      const name = it.kind === "other" && it.description ? it.description : KIND_LABEL[it.kind];
      return it.quantity > 1 ? `${name} ×${it.quantity}` : name;
    })
    .join(", ");
}

/* ----------------------------------------------------------------------------
 * Endpoints
 * ------------------------------------------------------------------------- */

export type RequestQuery = { status?: string; type?: RequestType; q?: string; teamId?: string; assignee?: string; mine?: boolean; sort?: "newest" | "priority"; limit?: number };

const withKey = () => ({ idempotencyKey: newIdempotencyKey() });
const path = (id: string, tail = "") => `/it-requests/${encodeURIComponent(id)}${tail}`;

export const requestsApi = {
  list: (query: RequestQuery = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "" && v !== false) params.set(k, String(v));
    const qs = params.toString();
    return request(`/it-requests${qs ? `?${qs}` : ""}`, { schema: requestListSchema, signal });
  },
  get: (id: string, signal?: AbortSignal) => request(path(id), { schema: requestDetailSchema, signal }),
  create: (body: {
    type: RequestType;
    items: RequestItem[];
    category?: IssueCategory;
    title?: string;
    device?: string;
    notes: string;
    priority: RequestPriority;
    forMemberId?: string;
    teamId?: string;
    staffId?: string;
  }) =>
    request("/it-requests", { method: "POST", body, schema: requestDetailSchema, ...withKey() }),
  assignees: (signal?: AbortSignal) => request("/it-requests/assignees", { schema: z.array(assigneeSchema), signal }),
  cancel: (id: string, body: { reason?: string; expectedVersion?: number }) =>
    request(path(id, "/cancel"), { method: "POST", body, schema: requestDetailSchema, ...withKey() }),
  /** `assigneeId`: "me" claims, "" unassigns, otherwise an IT user id. */
  assign: (id: string, body: { assigneeId: string; expectedVersion?: number }) =>
    request(path(id, "/assign"), { method: "POST", body, schema: requestDetailSchema, ...withKey() }),
  /** IT / admin: route to an IT staff directory entry ("" clears). */
  route: (id: string, body: { staffId: string; expectedVersion?: number }) =>
    request(path(id, "/staff"), { method: "POST", body, schema: requestDetailSchema, ...withKey() }),
  move: (id: string, body: { status: "open" | "in_progress" | "resolved"; note?: string; expectedVersion?: number }) =>
    request(path(id, "/status"), { method: "POST", body, schema: requestDetailSchema, ...withKey() }),
  /** IT: "Seen · working on it" — claims it (if free) and starts it. Idempotent. */
  acknowledge: (id: string, body: { expectedVersion?: number } = {}) =>
    request(path(id, "/acknowledge"), { method: "POST", body, schema: requestDetailSchema, ...withKey() }),
  reject: (id: string, body: { reason: string; expectedVersion?: number }) =>
    request(path(id, "/reject"), { method: "POST", body, schema: requestDetailSchema, ...withKey() }),
  comment: (id: string, body: string) =>
    request(path(id, "/comments"), { method: "POST", body: { body }, schema: requestDetailSchema, ...withKey() }),
};
