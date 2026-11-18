import { z } from "zod";
import { API_BASE_URL, newIdempotencyKey, request } from "./api";
import { isClosed, itRequestSchema } from "./requests";

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
  requestId: z.string().optional(),
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

const threadFields = z.object({
  side: z.enum(CHAT_SIDES),
  canPostAs: z.array(z.enum(CHAT_SIDES)).catch([]),
  messageCount: z.number().int().min(0),
  unread: z.number().int().min(0),
  lastMessage: chatMessageSchema.nullable(),
  otherReadAt: iso.nullable(),
});

export const chatThreadSchema = threadFields.extend({
  /** The request with the latest activity. */
  request: itRequestSchema,
  /** Every request in this conversation (one per requester), latest activity first. */
  requests: z.array(itRequestSchema).min(1),
  lastActivityAt: iso,
});
export type ChatThread = z.infer<typeof chatThreadSchema>;

export const CONTACT_ROLES = ["it", "team_lead", "admin"] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

const directThreadSchema = threadFields.extend({
  contact: z.object({ id: z.string().min(1), name: z.string(), title: z.string(), role: z.enum(CONTACT_ROLES).catch("it"), available: z.boolean() }),
  lastActivityAt: iso.nullable(),
});
export type DirectThread = z.infer<typeof directThreadSchema>;
export type Conversation = ChatThread | DirectThread;

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

const directListSchema = chatUnreadSchema.extend({ items: z.array(directThreadSchema) });
const directPageSchema = chatPageSchema.extend({ thread: directThreadSchema });

export type ChatFilter = "active" | "closed" | "all";
/** "mine": routed to the signed-in IT person's own staff entry. */
export type ChatScope = "mine" | "everyone";

const rid = (id: string) => encodeURIComponent(id);

function conversationApi(path: (id: string) => string) {
  return {
    /** A retried send uses the same idempotency key. */
    send: (id: string, body: { body: string; images?: { name: string; data: string }[] }, key = newIdempotencyKey()) =>
      request(path(id), {
        method: "POST",
        body,
        schema: chatMessageSchema,
        idempotencyKey: key,
        timeoutMs: body.images?.length ? 30_000 : undefined,
      }),
    read: (id: string) =>
      request(`${path(id)}/read`, { method: "POST", body: {}, schema: chatUnreadSchema, idempotencyKey: newIdempotencyKey(), retries: 0 }),
  };
}

const requestMessagesPath = (id: string) => `/it-requests/${rid(id)}/messages`;
const directMessagesPath = (id: string) => `/direct-chats/${rid(id)}/messages`;
const afterQuery = (after?: string) => after ? `?after=${rid(after)}` : "";

export const chatApi = {
  ...conversationApi(requestMessagesPath),
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
    request(`${requestMessagesPath(id)}${afterQuery(after)}`, { schema: chatPageSchema, signal, retries: after ? 0 : 2 }),
};

export const directChatApi = {
  ...conversationApi(directMessagesPath),
  list: (query: string, signal?: AbortSignal) =>
    request(`/direct-chats${query.trim() ? `?q=${rid(query.trim())}` : ""}`, { schema: directListSchema, signal, retries: 0 }),
  unread: (signal?: AbortSignal) => request("/direct-chats/unread", { schema: chatUnreadSchema, signal, retries: 0 }),
  messages: (id: string, after?: string, signal?: AbortSignal) =>
    request(`${directMessagesPath(id)}${afterQuery(after)}`, { schema: directPageSchema, signal, retries: after ? 0 : 2 }),
};

/** Who the conversation is with, from the viewer's side. */
export function counterpart(t: Conversation): { name: string; subtitle: string; unassigned: boolean } {
  if ("contact" in t) {
    const { name, title, role } = t.contact;
    const subtitle = role === "team_lead" ? (title ? `Team lead · ${title}` : "Team lead") : title || (role === "admin" ? "Super admin" : "IT");
    return { name, subtitle, unassigned: false };
  }
  const r = t.request;
  if (t.side === "requester") {
    // One conversation can span requests routed to different IT members.
    const open = t.requests.filter((x) => !isClosed(x.status));
    const relevant = open.length ? open : t.requests;
    const staff = new Map<string, { name: string; title: string | null }>();
    for (const x of relevant) if (x.staffId && x.staffName) staff.set(x.staffId, { name: x.staffName, title: x.staffTitle ?? null });
    const all = [...staff.values()];
    if (all.length === 1 && relevant.every((x) => x.staffId)) return { name: all[0].name, subtitle: all[0].title || "IT", unassigned: false };
    if (all.length > 0) return { name: "IT team", subtitle: `Handled by ${all.map((s) => s.name).join(", ")}`, unassigned: false };
    return { name: "IT team", subtitle: "Unassigned", unassigned: true };
  }
  return {
    name: r.requesterName,
    subtitle: r.teamName ? `${r.teamName} · ${r.requesterRole === "admin" ? "Admin" : "Team lead"}` : r.requesterRole === "admin" ? "Admin" : "Team lead",
    unassigned: t.requests.every((x) => !x.staffId),
  };
}

/** The request new messages are about by default: the latest one still open. */
export const defaultTarget = (t: ChatThread) => (t.requests.find((x) => !isClosed(x.status)) ?? t.request).id;

/** Whether a conversation holds this request (the URL may name any of them). */
export const threadHas = (t: Conversation, id: string | null) => "contact" in t ? t.contact.id === id : t.requests.some((x) => x.id === id);

export const requestChatsHref = "/requests/chat";
export const chatHref = (requestId: string) => `${requestChatsHref}?r=${rid(requestId)}`;
export const directChatHref = (peerId: string) => `/messages?person=${rid(peerId)}`;

/** Same-origin (or configured API) URL for an attachment. Cookies go with the image request. */
export function attachmentSrc(url: string, download = false) {
  const path = `${url}${download ? "?download=1" : ""}`;
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}
