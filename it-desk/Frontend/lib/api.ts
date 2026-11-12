import { z } from "zod";
import {
  exitRecordSchema,
  floorDraftSchema,
  floorSchema,
  floorSummarySchema,
  managedUserSchema,
  memberSchema,
  memberDetailSchema,
  publishResultSchema,
  settingsSchema,
  transferSchema,
  workspaceSchema,
  zoneChangeResultSchema,
  type ConflictMode,
  type FloorElement,
} from "./schemas";
import { sessionSchema, userSchema, type Role } from "./session";

/* ----------------------------------------------------------------------------
 * Typed client for the IT-Desk Go API.
 *
 * - Every response is validated with Zod; a contract mismatch surfaces as an
 *   ApiError("invalid_response") instead of corrupting the store.
 * - Timeouts per attempt, exponential backoff with jitter, and Retry-After are
 *   honoured. Reads retry on network errors / 429 / 502 / 503 / 504. Writes
 *   only retry when they carry an Idempotency-Key, so a retry can never apply
 *   the same change twice (the server replays the first response).
 * - Auth: the session lives in an HttpOnly cookie (`credentials: "include"`);
 *   every write carries the session's CSRF token in `X-CSRF-Token`. A 401
 *   hands control to the session layer (sign-in screen with a return URL), a
 *   stale CSRF token is refreshed once transparently, and a forced password
 *   change routes to the change-password screen.
 * ------------------------------------------------------------------------- */

/**
 * Where /api/v1 lives. In the browser this is same-origin ("") — server.mjs
 * proxies /api to the Go API — so the app works from any host name or LAN IP.
 * Server-side code calls the API directly. NEXT_PUBLIC_API_URL still overrides
 * the browser base (e.g. an API on a separate domain).
 */
export const API_BASE_URL = (
  typeof window === "undefined"
    ? (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8080")
    : (process.env.NEXT_PUBLIC_API_URL ?? "")
).replace(/\/+$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(init: { status: number; code: string; message: string; fields?: Record<string, string>; requestId?: string; retryAfterMs?: number }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** The server or the network is (temporarily) unreachable. */
  get isUnavailable() {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }

  /** The data changed underneath us; the caller should resync. */
  get isConflict() {
    return this.status === 409;
  }

  get isForbidden() {
    return this.status === 403;
  }
}

/* ----------------------------------------------------------------------------
 * Session hooks (registered by <SessionProvider>, browser only)
 * ------------------------------------------------------------------------- */

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

type AuthHandlers = {
  /** The session is gone (expired, revoked, signed out elsewhere). */
  onUnauthenticated?: () => void;
  /** The server requires a password change before anything else. */
  onPasswordChangeRequired?: () => void;
  /** Fetch a fresh CSRF token; resolves true when one was obtained. */
  refreshCsrf?: () => Promise<boolean>;
};

let authHandlers: AuthHandlers = {};

export function setAuthHandlers(handlers: AuthHandlers) {
  authHandlers = handlers;
  return () => {
    if (authHandlers === handlers) authHandlers = {};
  };
}

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
    requestId: z.string().optional(),
  }),
});

type RequestOptions<T> = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  schema: z.ZodType<T>;
  /** Required for retries of writes. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  /** Don't hand 401/403 to the session layer (sign-in screen, session probe). */
  silentAuth?: boolean;
};

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

function backoff(attempt: number, retryAfterMs?: number) {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 8_000);
  const base = Math.min(300 * 2 ** attempt, 4_000);
  return base / 2 + Math.random() * (base / 2);
}

function parseRetryAfter(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

export function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

async function attempt<T>(path: string, opts: RequestOptions<T>): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const method = opts.method ?? "GET";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/v1${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
      cache: "no-store",
      credentials: "include",
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const timedOut = timeout.aborted;
    throw new ApiError({
      status: 0,
      code: timedOut ? "timeout" : "network_error",
      message: timedOut ? "The server took too long to respond." : "Can’t reach the IT-Desk server. Check your connection.",
    });
  }

  const requestId = res.headers.get("X-Request-Id") ?? undefined;
  let payload: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const parsed = errorEnvelope.safeParse(payload);
    throw new ApiError({
      status: res.status,
      code: parsed.success ? parsed.data.error.code : `http_${res.status}`,
      message: parsed.success ? parsed.data.error.message : `The server responded with ${res.status}.`,
      fields: parsed.success ? parsed.data.error.fields : undefined,
      requestId: (parsed.success ? parsed.data.error.requestId : undefined) ?? requestId,
      retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")),
    });
  }

  if (res.status === 204) return opts.schema.parse(undefined);
  const data = z.object({ data: opts.schema }).safeParse(payload);
  if (!data.success) {
    if (process.env.NODE_ENV !== "production") console.error("API contract mismatch", path, data.error.issues);
    throw new ApiError({
      status: res.status,
      code: "invalid_response",
      message: "The server sent data this app doesn’t understand.",
      requestId,
    });
  }
  return data.data.data;
}

export async function request<T>(path: string, opts: RequestOptions<T>): Promise<T> {
  const isRead = (opts.method ?? "GET") === "GET";
  const canRetry = isRead || Boolean(opts.idempotencyKey);
  const retries = canRetry ? (opts.retries ?? 3) : 0;
  let csrfRefreshed = false;
  for (let n = 0; ; n++) {
    try {
      return await attempt(path, opts);
    } catch (err) {
      if (err instanceof ApiError && !opts.silentAuth) {
        if (err.status === 401) {
          authHandlers.onUnauthenticated?.();
          throw err;
        }
        if (err.code === "password_change_required") {
          authHandlers.onPasswordChangeRequired?.();
          throw err;
        }
        // A rotated/expired CSRF token: fetch the current one and replay once.
        // Safe for writes: the server rejected the request before doing anything.
        if (err.code === "csrf_failed" && !csrfRefreshed && authHandlers.refreshCsrf) {
          csrfRefreshed = true;
          if (await authHandlers.refreshCsrf()) {
            n -= 1;
            continue;
          }
        }
      }
      if (!(err instanceof ApiError) || n >= retries) throw err;
      const retryable = err.status === 0 || RETRYABLE_STATUS.has(err.status) || err.code === "request_in_progress";
      if (!retryable) throw err;
      await sleep(backoff(n, err.retryAfterMs), opts.signal);
    }
  }
}

/* ----------------------------------------------------------------------------
 * Endpoints
 * ------------------------------------------------------------------------- */

const membersSchema = z.array(memberSchema);

export type MemberInput = {
  name: string;
  employeeId: string;
  email: string;
  designation: string;
  subGroup: string;
  teamId: string;
  /** A published seat (element id); null = no seat. */
  seatId: string | null;
  isLead?: boolean;
  devices: { id?: string; kind: string; model: string; assetTag: string }[];
};
const transferResultSchema = z.object({
  transfer: transferSchema,
  members: membersSchema,
  undoExpiresAt: z.iso.datetime(),
});
const exitResultSchema = z.object({
  batchId: z.string(),
  exits: z.array(exitRecordSchema),
  members: membersSchema,
  undoExpiresAt: z.iso.datetime(),
});
const undoResultSchema = z.object({ members: membersSchema });

export type TransferRequest = {
  mode: "internal" | "team";
  toTeamId?: string;
  assignments: { memberId: string; toSeatId: string; expectedVersion?: number }[];
  devicesByMember: Record<string, string[]>;
  effectiveDate: string;
  note: string;
};

export type ExitRequest = {
  memberIds: string[];
  status: "resigned" | "unknown";
  reason: string;
  effectiveDate: string;
};

const withKey = () => ({ idempotencyKey: newIdempotencyKey() });

export const api = {
  workspace: (teamId?: string | null, signal?: AbortSignal) =>
    request(teamId ? `/workspace?teamId=${encodeURIComponent(teamId)}` : "/workspace", {
      schema: workspaceSchema,
      signal,
      timeoutMs: 12_000,
    }),
  createTransfer: (body: TransferRequest) => request("/transfers", { method: "POST", body, schema: transferResultSchema, ...withKey() }),
  advanceTransfer: (id: string, from: string) =>
    request(`/transfers/${encodeURIComponent(id)}/advance`, {
      method: "POST",
      body: { from },
      schema: transferSchema,
      ...withKey(),
    }),
  /** IT: "Seen · working on it". Idempotent; tells the requester live. */
  acknowledgeTransfer: (id: string, expectedVersion?: number) =>
    request(`/transfers/${encodeURIComponent(id)}/acknowledge`, {
      method: "POST",
      body: { expectedVersion },
      schema: transferSchema,
      ...withKey(),
    }),
  undoTransfer: (id: string) => request(`/transfers/${encodeURIComponent(id)}`, { method: "DELETE", schema: undoResultSchema, ...withKey() }),
  markExit: (body: ExitRequest) => request("/exits", { method: "POST", body, schema: exitResultSchema, ...withKey() }),
  undoExitBatch: (batchId: string) =>
    request(`/exits/batches/${encodeURIComponent(batchId)}`, {
      method: "DELETE",
      schema: undoResultSchema,
      ...withKey(),
    }),
  /** One member with history. Team leads only see their own team (404 otherwise). */
  memberDetail: (id: string) => request(`/members/${encodeURIComponent(id)}/detail`, { schema: memberDetailSchema }),
  /** Admin, or a team lead for their own team. Broadcast live to everyone who can see the team. */
  createMember: (body: MemberInput) => request("/members", { method: "POST", body, schema: memberSchema, ...withKey() }),
  updateMember: (id: string, body: MemberInput & { expectedVersion: number }) =>
    request(`/members/${encodeURIComponent(id)}`, { method: "PATCH", body, schema: memberSchema, ...withKey() }),
  updateProfile: (body: { name: string; email: string; title: string }) => request("/me/profile", { method: "PUT", body, schema: userSchema, ...withKey() }),
  updateSettings: (notifications: Record<string, boolean>) =>
    request("/settings", { method: "PUT", body: { notifications }, schema: settingsSchema, ...withKey() }),
};

export type WorkspaceResponse = z.infer<typeof workspaceSchema>;

/* ----------------------------------------------------------------------------
 * Floor plans (see docs/floors.md). Reads: every role (published floors);
 * writes: admin, except seating a person (admin anywhere, lead in own zone).
 * ------------------------------------------------------------------------- */

export type FloorCreateInput = {
  name: string;
  level: number;
  sortOrder?: number;
  seatPrefix: string;
  cols?: number;
  rows?: number;
  notes?: string;
  template?: "facing-rows";
  templateSeats?: number;
  elements?: FloorElement[];
  publish?: boolean;
};
export type FloorMetaInput = { name?: string; level?: number; sortOrder?: number; seatPrefix?: string; notes?: string; expectedVersion?: number };
export type DraftPut = { cols?: number; rows?: number; seatPrefix?: string; elements: FloorElement[]; expectedDraftVersion?: number };
export type ZoneRequest = {
  teamId: string | null;
  seatIds: string[];
  leadSeat?: boolean;
  onConflict?: ConflictMode;
  dryRun?: boolean;
};
export type ZoneMoveRequest = {
  teamId: string;
  fromFloorId?: string;
  fromSeatIds?: string[];
  toSeatIds: string[];
  carry?: boolean;
  onConflict?: ConflictMode;
  dryRun?: boolean;
};

const enc = encodeURIComponent;

export const floorsApi = {
  list: (signal?: AbortSignal) => request("/floors", { schema: z.array(floorSummarySchema), signal }),
  get: (id: string, signal?: AbortSignal) => request(`/floors/${enc(id)}`, { schema: floorSchema, signal }),
  create: (body: FloorCreateInput) => request("/floors", { method: "POST", body, schema: floorSummarySchema, ...withKey() }),
  update: (id: string, body: FloorMetaInput) => request(`/floors/${enc(id)}`, { method: "PATCH", body, schema: floorSummarySchema, ...withKey() }),
  remove: (id: string) => request(`/floors/${enc(id)}`, { method: "DELETE", schema: z.object({ deleted: z.boolean() }), ...withKey() }),
  duplicate: (id: string, body: { name: string; keepZones: boolean }) =>
    request(`/floors/${enc(id)}/duplicate`, { method: "POST", body, schema: floorSummarySchema, ...withKey() }),
  draft: (id: string, signal?: AbortSignal) => request(`/floors/${enc(id)}/draft`, { schema: floorDraftSchema, signal }),
  saveDraft: (id: string, body: DraftPut) => request(`/floors/${enc(id)}/draft`, { method: "PUT", body, schema: floorDraftSchema, retries: 0, ...withKey() }),
  discardDraft: (id: string) => request(`/floors/${enc(id)}/draft`, { method: "DELETE", schema: floorDraftSchema, ...withKey() }),
  publish: (id: string, body: { expectedDraftVersion?: number; onConflict?: ConflictMode; dryRun?: boolean }) =>
    request(`/floors/${enc(id)}/publish`, { method: "POST", body, schema: publishResultSchema, ...withKey() }),
  assignZone: (floorId: string, body: ZoneRequest) =>
    request(`/floors/${enc(floorId)}/zones`, { method: "POST", body, schema: zoneChangeResultSchema, ...withKey() }),
  moveZone: (body: ZoneMoveRequest) => request("/zones/move", { method: "POST", body, schema: zoneChangeResultSchema, ...withKey() }),
  undoZoneChange: (id: string) => request(`/zone-changes/${enc(id)}/undo`, { method: "POST", schema: z.object({ undone: z.boolean() }), ...withKey() }),
  /** Give published seats their real, physical numbers (ids stay; swaps work in one call). */
  setSeatCodes: (floorId: string, body: { changes: { seatId: string; code: string }[]; dryRun?: boolean }) =>
    request(`/floors/${enc(floorId)}/seat-codes`, {
      method: "PUT",
      body,
      schema: z.object({ dryRun: z.boolean(), changed: z.array(z.object({ seatId: z.string(), code: z.string() })).default([]) }),
      ...withKey(),
    }),
  /** Seat a person (null = unseat). Admin: any seat; lead: own people inside own zone. */
  assignSeat: (memberId: string, body: { seatId: string | null; expectedVersion?: number }) =>
    request(`/members/${enc(memberId)}/seat`, { method: "PUT", body, schema: memberSchema, ...withKey() }),
};

/* ----------------------------------------------------------------------------
 * Authentication. There is no sign-up: accounts are created by an admin.
 * ------------------------------------------------------------------------- */

export const authApi = {
  /** Never retried: a retry would count as a second failed attempt. */
  login: (body: { email: string; password: string }) =>
    request("/auth/login", { method: "POST", body, schema: sessionSchema, retries: 0, silentAuth: true, timeoutMs: 15_000 }),
  /** Current session. `silentAuth` lets callers decide what a 401 means. */
  me: (opts: { silent?: boolean; signal?: AbortSignal } = {}) =>
    request("/auth/me", { schema: sessionSchema, silentAuth: opts.silent, signal: opts.signal, retries: 2 }),
  logout: () => request("/auth/logout", { method: "POST", schema: z.object({ signedOut: z.boolean() }), silentAuth: true }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request("/auth/change-password", { method: "POST", body, schema: sessionSchema, silentAuth: true, timeoutMs: 15_000 }),
};

/* ----------------------------------------------------------------------------
 * Admin: user management
 * ------------------------------------------------------------------------- */

export type UserInput = { email: string; name: string; title: string; role: Role; teamId?: string; expectedVersion?: number };

const credentialResultSchema = z.object({ user: managedUserSchema, temporaryPassword: z.string().min(8) });

export const adminApi = {
  users: (signal?: AbortSignal) => request("/admin/users", { schema: z.array(managedUserSchema), signal }),
  // Responses that carry a one-time password are never replayed from an idempotency cache,
  // so these two are sent once (no automatic retry).
  createUser: (body: UserInput) => request("/admin/users", { method: "POST", body, schema: credentialResultSchema }),
  resetPassword: (id: string) => request(`/admin/users/${encodeURIComponent(id)}/reset-password`, { method: "POST", schema: credentialResultSchema }),
  updateUser: (id: string, body: Partial<UserInput> & { expectedVersion: number }) =>
    request(`/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body, schema: managedUserSchema, ...withKey() }),
  deleteUser: (id: string) => request(`/admin/users/${encodeURIComponent(id)}`, { method: "DELETE", schema: z.object({ deleted: z.boolean() }), ...withKey() }),
  setEnabled: (id: string, enabled: boolean) =>
    request(`/admin/users/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
      method: "POST",
      schema: managedUserSchema,
      ...withKey(),
    }),
  revokeSessions: (id: string) =>
    request(`/admin/users/${encodeURIComponent(id)}/revoke-sessions`, { method: "POST", schema: managedUserSchema, ...withKey() }),
};
