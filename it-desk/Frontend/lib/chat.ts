import { z } from "zod";
import { API_BASE_URL, newIdempotencyKey, request } from "./api";
import { isClosed, itRequestSchema } from "./requests";

/* ----------------------------------------------------------------------------
 * Request chat: one conversation per requester (lead) holding all of their IT
 * requests, each message tagged with its REQ id, between the requester's side
 * (the lead / their team) and IT. IT staff have no logins yet, so IT-side
 * messages are written by an IT or admin account and shown as the staff
 * member the request is routed to ("IT team" when nobody is).
 * ------------------------------------------------------------------------- */

const iso = z.iso.datetime({ offset: true });

export const CHAT_SIDES = ["requester", "it"] as const;
export type ChatSide = (typeof CHAT_SIDES)[number];

export const CHAT_LIMITS = { maxBody: 2000, maxImages: 3, maxImageBytes: 2 * 1024 * 1024 } as const;
/** Poll cadence while the Messages page is open (and the tab is visible). */
export const CHAT_POLL_MS = 4000;

export const chatAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
  /** REQ id of the request this message is about. */
  ticket: z.string().catch(""),
  side: z.enum(CHAT_SIDES),
  senderName: z.string(),
  staffId: z.string().nullable(),
  staffName: z.string().nullable(),
  authorId: z.string().nullable(),
  authorName: z.string(),
  authorRole: z.string(),
  onBehalf: z.boolean(),
  mine: z.boolean(),
  body: z.string(),
  attachments: z.array(chatAttachmentSchema).catch([]),
  createdAt: iso,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatThreadSchema = z.object({
  /** The request with the latest activity. */
  request: itRequestSchema,
  /** Every request in this conversation (one per requester), latest activity first. */
  requests: z.array(itRequestSchema).min(1),
  side: z.enum(CHAT_SIDES),
  canPostAs: z.array(z.enum(CHAT_SIDES)).catch([]),
  messageCount: z.number().int().min(0),
  unread: z.number().int().min(0),
  lastMessage: chatMessageSchema.nullable(),
  lastActivityAt: iso,
  otherReadAt: iso.nullable(),
});
export type ChatThread = z.infer<typeof chatThreadSchema>;

export const chatUnreadSchema = z.object({ unread: z.number().int().min(0), unreadChats: z.number().int().min(0) });
export type ChatUnread = z.infer<typeof chatUnreadSchema>;

export const chatListSchema = chatUnreadSchema.extend({
  items: z.array(chatThreadSchema),
  /** The caller's own IT staff entry (IT staff who sign in as themselves). */
  myStaffId: z.string().nullish().transform((v) => v ?? null),
});
export type ChatList = z.infer<typeof chatListSchema>;

export const chatPageSchema = z.object({
  thread: chatThreadSchema,
  messages: z.array(chatMessageSchema),
  hasMore: z.boolean(),
});
export type ChatPage = z.infer<typeof chatPageSchema>;

export type ChatFilter = "active" | "closed" | "all";
/** "mine": routed to the signed-in IT person's own staff entry. */
export type ChatScope = "mine" | "everyone";

const rid = (id: string) => encodeURIComponent(id);

export const chatApi = {
  list: (opts: { status?: ChatFilter; scope?: ChatScope; q?: string } = {}, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (opts.status && opts.status !== "all") p.set("status", opts.status);
    if (opts.scope === "mine") p.set("assigned", "me");
    if (opts.q?.trim()) p.set("q", opts.q.trim());
    const qs = p.toString();
    return request(`/chats${qs ? `?${qs}` : ""}`, { schema: chatListSchema, signal, retries: 0 });
  },
  unread: (signal?: AbortSignal) => request("/chats/unread", { schema: chatUnreadSchema, signal, retries: 0 }),
  messages: (id: string, after?: string, signal?: AbortSignal) =>
    request(`/it-requests/${rid(id)}/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`, { schema: chatPageSchema, signal, retries: after ? 0 : 2 }),
  /** The idempotency key is the client's message id, so a retried send never posts twice. */
  send: (id: string, body: { body: string; as?: ChatSide; images?: { name: string; data: string }[] }, key: string = newIdempotencyKey()) =>
    request(`/it-requests/${rid(id)}/messages`, {
      method: "POST",
      body,
      schema: chatMessageSchema,
      idempotencyKey: key,
      timeoutMs: body.images?.length ? 30_000 : undefined,
    }),
  read: (id: string) =>
    request(`/it-requests/${rid(id)}/messages/read`, { method: "POST", body: {}, schema: chatUnreadSchema, idempotencyKey: newIdempotencyKey(), retries: 0 }),
};

/** Who the conversation is with, from the viewer's side. */
export function counterpart(t: ChatThread): { name: string; subtitle: string; staff: boolean; unassigned: boolean } {
  const r = t.request;
  if (t.side === "requester") {
    // One conversation can span requests routed to different IT members.
    const open = t.requests.filter((x) => !isClosed(x.status));
    const relevant = open.length ? open : t.requests;
    const staff = new Map<string, { name: string; title: string | null }>();
    for (const x of relevant) if (x.staffId && x.staffName) staff.set(x.staffId, { name: x.staffName, title: x.staffTitle ?? null });
    const all = [...staff.values()];
    if (all.length === 1 && relevant.every((x) => x.staffId)) return { name: all[0].name, subtitle: all[0].title || "IT", staff: true, unassigned: false };
    if (all.length > 0) return { name: "IT team", subtitle: `Handled by ${all.map((s) => s.name).join(", ")}`, staff: false, unassigned: false };
    return { name: "IT team", subtitle: "Unassigned", staff: false, unassigned: true };
  }
  return {
    name: r.requesterName,
    subtitle: r.teamName ? `${r.teamName} · ${r.requesterRole === "admin" ? "Admin" : "Team lead"}` : r.requesterRole === "admin" ? "Admin" : "Team lead",
    staff: false,
    unassigned: t.requests.every((x) => !x.staffId),
  };
}

/** The request new messages are about by default: the latest one still open. */
export const defaultTarget = (t: ChatThread) => (t.requests.find((x) => !isClosed(x.status)) ?? t.request).id;

/** Whether a conversation holds this request (the URL may name any of them). */
export const threadHas = (t: ChatThread, requestId: string | null) => requestId !== null && t.requests.some((x) => x.id === requestId);

export const chatHref = (requestId: string) => `/messages?r=${encodeURIComponent(requestId)}`;

/** Same-origin (or configured API) URL for an attachment. Cookies go with the image request. */
export function attachmentSrc(url: string, download = false) {
  const path = `${url}${download ? "?download=1" : ""}`;
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}
