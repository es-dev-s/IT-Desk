import { z } from "zod";
import { newIdempotencyKey, request } from "./api";

const iso = z.iso.datetime({ offset: true });

export const NOTIFICATION_KINDS = [
  "transfer.created",
  "transfer.acknowledged",
  "transfer.advanced",
  "request.created",
  "request.acknowledged",
  "request.status",
  "request.assigned",
  "request.comment",
  "request.cancelled",
  "request.rejected",
  "floor.seats",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notificationSchema = z.object({
  id: z.number().int().positive(),
  // Unknown future kinds still render (as a generic item) instead of failing the page.
  kind: z.string(),
  entityType: z.enum(["transfer", "it_request", "floor"]),
  entityId: z.string(),
  ticket: z.string(),
  teamId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string(),
  readAt: iso.nullable(),
  createdAt: iso,
});
export type AppNotification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  unread: z.number().int().min(0),
  nextBefore: z.number().int().nullable(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const readResultSchema = z.object({
  updated: z.number().int().min(0),
  unread: z.number().int().min(0),
  ids: z.array(z.number().int()).optional(),
  all: z.boolean().optional(),
});
export type ReadResult = z.infer<typeof readResultSchema>;

/** Payload of a live "entity" event: something the viewer can see changed. */
export const entityChangeSchema = z.object({
  entity: z.enum(["transfer", "it_request", "member", "user", "team", "floor"]),
  id: z.string(),
  ticket: z.string().default(""),
  change: z.string(),
  version: z.number().int(),
  actorId: z.string().optional(),
});
export type EntityChange = z.infer<typeof entityChangeSchema>;

export const readyEventSchema = z.object({
  userId: z.string(),
  unread: z.number().int().min(0),
  resumed: z.boolean(),
  resync: z.boolean(),
  lastEventId: z.number().int().min(0),
  serverTime: iso,
  heartbeatSeconds: z.number().int().positive(),
});
export type ReadyEvent = z.infer<typeof readyEventSchema>;

export const notificationsApi = {
  list: (opts: { before?: number; limit?: number; unread?: boolean } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", String(opts.before));
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.unread) q.set("unread", "true");
    const qs = q.toString();
    return request(`/notifications${qs ? `?${qs}` : ""}`, { schema: notificationPageSchema, signal });
  },
  read: (id: number) =>
    request(`/notifications/${id}/read`, { method: "POST", schema: readResultSchema, idempotencyKey: newIdempotencyKey() }),
  readAll: () => request("/notifications/read-all", { method: "POST", schema: readResultSchema, idempotencyKey: newIdempotencyKey() }),
};

/** Notifications that mean "IT has something new to pick up". */
export const isNewWork = (kind: string) => kind === "transfer.created" || kind === "request.created";
/** Notifications that mean "IT has seen yours and is working on it". */
export const isSeen = (kind: string) => kind === "transfer.acknowledged" || kind === "request.acknowledged";
