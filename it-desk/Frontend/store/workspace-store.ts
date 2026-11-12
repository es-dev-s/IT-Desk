import { createStore } from "zustand/vanilla";
import { api, ApiError, floorsApi, type WorkspaceResponse } from "@/lib/api";
import { nowMs, syncServerTime } from "@/lib/clock";
import { IT_STATUSES } from "@/lib/constants";
import { seatIndex } from "@/lib/floors";
import type {
  ExitRecord,
  Floor,
  ItStatus,
  Member,
  Team,
  Transfer,
  TransferDraft,
} from "@/lib/schemas";
import { validateTransfer } from "@/lib/transfer-rules";
import type { Permission, User } from "@/lib/session";

/**
 * Client cache of the server workspace (PostgreSQL is the source of truth).
 *
 * - `load()` fetches one consistent snapshot; `refresh()` resyncs silently
 *   (on focus, reconnect, interval and after conflicts) but never while a
 *   write is in flight, so it can't clobber an optimistic update.
 * - Writes are optimistic: the UI updates instantly, the API call runs with an
 *   Idempotency-Key, and on failure exactly the touched records are rolled
 *   back and a resync is scheduled. On success the server's records replace
 *   the optimistic ones (server-assigned ids, tickets, versions).
 * - Undo goes through the API and is only offered within the server's window.
 * - Role-aware: actions the signed-in role can't perform are refused here too
 *   (defence in depth; the API enforces the same rules and team scoping).
 * - Admins and IT see the whole organisation; `selectTeam()` switches the
 *   team in focus (mirrored to `?teamId=` so the view is linkable). The
 *   admin is not on a team: "" is the org-wide "All teams" view.
 * - `floors` are the published floor plans with occupancy; a member's seat is
 *   a seat id on one of them (`assignSeat()` seats or unseats a person).
 */

export type LoadStatus = "idle" | "loading" | "ready" | "error";

type UndoEntry =
  | { kind: "transfer"; transferId: string; expiresAt: number }
  | { kind: "exit"; batchId: string; exitIds: string[]; expiresAt: number };

export type ActionFailure = { ok: false; error: string; code?: string; fields?: Record<string, string> };
export type ActionResult<T = object> = ({ ok: true; undoKey: string } & T) | ActionFailure;

export type TransferResult = ActionResult<{ transferId: string; ticket: string; members: number; devices: number }>;

export type LoadError = { message: string; code: string; requestId?: string };

export type WorkspaceState = {
  status: LoadStatus;
  loadError: LoadError | null;
  /** Last background sync failed (shown as a non-blocking banner). */
  syncError: LoadError | null;
  lastSyncedAt: number | null;
  /** Writes in flight. */
  pending: number;
  undoWindowSeconds: number;

  currentTeamId: string;
  /** Team the user asked for (admin/IT team switcher); null = server default. */
  requestedTeamId: string | null;
  /** A team switch is loading. */
  switching: boolean;
  user: User;
  permissions: readonly string[];
  teams: Record<string, Team>;
  teamIds: string[];
  members: Record<string, Member>;
  memberIds: string[];
  transfers: Record<string, Transfer>;
  transferIds: string[];
  exits: Record<string, ExitRecord>;
  exitIds: string[];
  /** Published floors (occupants of other teams are redacted for leads). */
  floors: Floor[];
  notifications: Record<string, boolean>;
  undoLog: Record<string, UndoEntry>;
};

export type WorkspaceActions = {
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  selectTeam: (teamId: string) => Promise<void>;
  setPermissions: (permissions: readonly string[]) => void;
  can: (permission: Permission) => boolean;
  createTransfer: (draft: TransferDraft) => Promise<TransferResult>;
  advanceItStatus: (transferId: string) => Promise<ActionResult<{ status: ItStatus }>>;
  /** IT: "Seen · working on it". Optimistic chip, replaced by the saved transfer. */
  acknowledgeTransfer: (transferId: string) => Promise<ActionResult<{ byName: string }>>;
  /** Merge one transfer the API returned (e.g. from a live event). */
  upsertTransfer: (t: Transfer) => void;
  /** Seat (or unseat with null) a person. Admin: any seat; lead: own people inside the own zone. */
  assignSeat: (memberId: string, seatId: string | null) => Promise<ActionResult<{ member: Member }>>;
  /** Merge one member the API returned (added or edited), ignoring older versions. */
  applyMember: (m: Member) => void;
  markExit: (input: {
    memberIds: string[];
    status: "resigned" | "unknown";
    reason: string;
    effectiveDate: string;
  }) => Promise<ActionResult<{ count: number }>>;
  undo: (undoKey: string) => Promise<ActionResult>;
  canUndo: (undoKey: string) => boolean;
  updateProfile: (input: { name: string; email: string; title: string }) => Promise<ActionResult>;
  setNotification: (id: string, on: boolean) => Promise<ActionResult>;
};

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

const indexById = <T extends { id: string }>(items: readonly T[]) =>
  Object.fromEntries(items.map((item) => [item.id, item])) as Record<string, T>;

let sequence = 0;
const tempId = (prefix: string) => `tmp_${prefix}_${Date.now().toString(36)}${(sequence++).toString(36)}`;

const EMPTY: Omit<WorkspaceState, "status" | "loadError" | "syncError" | "lastSyncedAt" | "pending" | "requestedTeamId" | "switching" | "permissions"> = {
  undoWindowSeconds: 0,
  currentTeamId: "",
  user: { id: "", name: "", email: "", title: "", role: "team_lead" },
  teams: {},
  teamIds: [],
  members: {},
  memberIds: [],
  transfers: {},
  transferIds: [],
  exits: {},
  exitIds: [],
  floors: [],
  notifications: {},
  undoLog: {},
};

function fromSnapshot(ws: WorkspaceResponse) {
  syncServerTime(ws.serverTime);
  return {
    undoWindowSeconds: ws.undoWindowSeconds,
    currentTeamId: ws.currentTeamId,
    user: ws.user,
    teams: indexById(ws.teams),
    teamIds: ws.teams.map((t) => t.id),
    members: indexById(ws.members),
    memberIds: ws.members.map((m) => m.id),
    transfers: indexById(ws.transfers),
    transferIds: ws.transfers.map((t) => t.id),
    exits: indexById(ws.exits),
    exitIds: ws.exits.map((e) => e.id),
    floors: ws.floors,
    notifications: ws.settings.notifications,
  };
}

function toLoadError(err: unknown): LoadError {
  if (err instanceof ApiError) return { message: err.message, code: err.code, requestId: err.requestId };
  return { message: "Something went wrong while loading your workspace.", code: "unknown" };
}

function toFailure(err: unknown): ActionFailure {
  if (err instanceof ApiError) {
    const message = err.requestId && err.status >= 500 ? `${err.message} (ref ${err.requestId.slice(0, 8)})` : err.message;
    return { ok: false, error: message, code: err.code, fields: err.fields };
  }
  return { ok: false, error: "Something went wrong. Please try again." };
}

/** Merge server member records (they carry the authoritative version). */
const mergeMembers = (members: Record<string, Member>, updates: readonly Member[]) => {
  const next = { ...members };
  for (const m of updates) next[m.id] = m;
  return next;
};

const DENIED: ActionFailure = { ok: false, error: "Your role doesn’t allow this action.", code: "forbidden" };

/** Reads `?teamId=` once on the client, so a shared link opens the same team. */
const teamFromUrl = () => {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("teamId");
};

export function createWorkspaceStore(initial: { permissions?: readonly string[] } = {}) {
  let inflightLoad: Promise<void> | null = null;
  let inflightTeam: string | null = null;
  /** Bumped by every team switch: a response for an older request is dropped. */
  let generation = 0;
  let resyncAfterWrites = false;
  /** A refresh was asked for while a fetch was already in flight: run one more after it. */
  let refetchAfter = false;

  return createStore<WorkspaceStore>()((set, get) => {
    const begin = () => set((s) => ({ pending: s.pending + 1 }));
    const end = () => {
      set((s) => ({ pending: Math.max(0, s.pending - 1) }));
      if (get().pending === 0 && resyncAfterWrites) {
        resyncAfterWrites = false;
        void get().refresh();
      }
    };
    /** After a failed or conflicting write, pull the truth once writes settle. */
    const resync = () => {
      if (get().pending > 0) resyncAfterWrites = true;
      else void get().refresh();
    };

    const fetchSnapshot = (mode: "load" | "refresh" | "switch") => {
      const teamId = get().requestedTeamId;
      if (inflightLoad && inflightTeam === teamId) {
        // The in-flight snapshot may predate the change that triggered this call
        // (e.g. a live event mid-fetch). Coalesce: one follow-up fetch, however many calls.
        if (mode === "refresh") refetchAfter = true;
        return inflightLoad;
      }
      const gen = generation;
      inflightTeam = teamId;
      let run: Promise<void> | null = null;
      run = (async () => {
        try {
          const ws = await api.workspace(teamId);
          if (gen !== generation) return;
          if (get().pending > 0 && mode !== "switch") {
            // A write started meanwhile; this snapshot may predate it.
            resyncAfterWrites = true;
            if (get().status === "ready") return;
          }
          set((s) => ({
            ...fromSnapshot(ws),
            // Keep undo offers for records that still exist.
            undoLog: Object.fromEntries(
              Object.entries(s.undoLog).filter(([, e]) =>
                e.kind === "transfer" ? ws.transfers.some((t) => t.id === e.transferId && t.itStatus === "requested") : ws.exits.some((x) => x.batchId === e.batchId),
              ),
            ),
            status: "ready",
            switching: false,
            loadError: null,
            syncError: null,
            lastSyncedAt: Date.now(),
          }));
        } catch (err) {
          if (gen !== generation) return;
          if (mode === "load" || get().status !== "ready") set({ status: "error", switching: false, loadError: toLoadError(err) });
          else set({ syncError: toLoadError(err), switching: false });
        } finally {
          if (inflightLoad === run) {
            inflightLoad = null;
            inflightTeam = null;
            if (refetchAfter) {
              refetchAfter = false;
              if (gen === generation && get().status === "ready") void fetchSnapshot("refresh");
            }
          }
        }
      })();
      inflightLoad = run;
      return run;
    };
    const allowed = (permission: Permission) => get().permissions.includes(permission);

    return {
      ...EMPTY,
      status: "idle",
      loadError: null,
      syncError: null,
      lastSyncedAt: null,
      pending: 0,
      requestedTeamId: null,
      switching: false,
      permissions: initial.permissions ?? [],

      load: () => {
        // From "error" we stay on the error screen (it shows its own retrying state).
        if (get().status === "idle") set({ status: "loading", loadError: null, requestedTeamId: teamFromUrl() });
        return fetchSnapshot("load");
      },

      refresh: () => (get().status === "ready" ? fetchSnapshot("refresh") : get().load()),

      selectTeam: (teamId) => {
        const s = get();
        // "" = "All teams" (org-wide; admin and IT only).
        if ((teamId !== "" && !s.teams[teamId]) || (teamId === s.currentTeamId && !s.switching)) return Promise.resolve();
        if (teamId === "" && s.user.role === "team_lead") return Promise.resolve();
        generation += 1;
        set({ requestedTeamId: teamId, switching: true, syncError: null });
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          if (teamId) url.searchParams.set("teamId", teamId);
          else url.searchParams.delete("teamId");
          window.history.replaceState(window.history.state, "", url);
        }
        return fetchSnapshot("switch");
      },

      setPermissions: (permissions) => set({ permissions }),
      can: (permission) => allowed(permission),

      canUndo: (undoKey) => {
        const entry = get().undoLog[undoKey];
        return Boolean(entry && entry.expiresAt > nowMs());
      },

      createTransfer: async (draft) => {
        if (!allowed("transfers.create")) return DENIED;
        const s = get();
        const errors = validateTransfer(s, draft);
        const first = Object.values(errors)[0];
        if (first) return { ok: false, error: first, fields: errors as Record<string, string> };

        const at = new Date(nowMs()).toISOString();
        const toTeamId = draft.mode === "internal" ? s.currentTeamId : draft.toTeamId;
        const before: Member[] = [];
        const optimisticMembers = { ...s.members };
        let devices = 0;
        const seats = seatIndex(s.floors);
        const assignments = draft.assignments.map(({ memberId, toSeatId }) => ({
          memberId,
          toSeatId,
          expectedVersion: s.members[memberId].version,
        }));
        const devicesByMember: Record<string, string[]> = {};
        const moves = assignments.map(({ memberId, toSeatId }) => {
          const seat = seats.get(toSeatId);
          const toSeat = seat?.code ?? null;
          const m = s.members[memberId];
          const keep = new Set(draft.devicesByMember[memberId] ?? m.devices.map((d) => d.id));
          const moving = m.devices.filter((d) => keep.has(d.id));
          devicesByMember[memberId] = moving.map((d) => d.id);
          devices += moving.length;
          before.push(m);
          optimisticMembers[memberId] = {
            ...m,
            seat: toSeat,
            seatId: toSeatId,
            floorId: seat?.floorId ?? null,
            teamId: toTeamId,
            version: m.version + 1,
          };
          return { memberId, memberName: m.name, fromSeat: m.seat, toSeat, fromSeatId: m.seatId, toSeatId, devices: moving };
        });
        const optimistic: Transfer = {
          id: tempId("trf"),
          ticket: "IT-····",
          direction: draft.mode === "internal" ? "internal" : "out",
          fromTeamId: s.currentTeamId,
          toTeamId,
          moves,
          effectiveDate: draft.effectiveDate,
          createdAt: at,
          initiatedBy: s.user.name,
          note: draft.note.trim(),
          itStatus: "requested",
          history: [{ status: "requested", at }],
        };

        set((cur) => ({
          members: mergeMembers(cur.members, moves.map((mv) => optimisticMembers[mv.memberId])),
          transfers: { ...cur.transfers, [optimistic.id]: optimistic },
          transferIds: [optimistic.id, ...cur.transferIds],
        }));
        begin();
        try {
          const res = await api.createTransfer({
            mode: draft.mode,
            toTeamId: draft.mode === "team" ? draft.toTeamId : undefined,
            assignments,
            devicesByMember,
            effectiveDate: draft.effectiveDate,
            note: draft.note.trim(),
          });
          const t = res.transfer;
          set((cur) => {
            const transfers = { ...cur.transfers, [t.id]: t };
            delete transfers[optimistic.id];
            return {
              members: mergeMembers(cur.members, res.members),
              transfers,
              transferIds: [t.id, ...cur.transferIds.filter((id) => id !== optimistic.id && id !== t.id)],
              undoLog: { ...cur.undoLog, [t.id]: { kind: "transfer", transferId: t.id, expiresAt: Date.parse(res.undoExpiresAt) } },
            };
          });
          return { ok: true, undoKey: t.id, transferId: t.id, ticket: t.ticket, members: t.moves.length, devices };
        } catch (err) {
          set((cur) => {
            const transfers = { ...cur.transfers };
            delete transfers[optimistic.id];
            return {
              members: mergeMembers(cur.members, before),
              transfers,
              transferIds: cur.transferIds.filter((id) => id !== optimistic.id),
            };
          });
          resync();
          return toFailure(err);
        } finally {
          end();
        }
      },

      advanceItStatus: async (transferId) => {
        if (!allowed("transfers.advance")) return DENIED;
        const t = get().transfers[transferId];
        if (!t || transferId.startsWith("tmp_")) return { ok: false, error: "This request is still being saved." };
        const index = IT_STATUSES.indexOf(t.itStatus);
        if (index === IT_STATUSES.length - 1) return { ok: false, error: "This request is already completed." };
        const status = IT_STATUSES[index + 1];
        const optimistic: Transfer = {
          ...t,
          itStatus: status,
          history: [...t.history, { status, at: new Date(nowMs()).toISOString() }],
        };
        set((cur) => {
          // Once IT has touched the request, the transfer can no longer be undone.
          const undoLog = { ...cur.undoLog };
          delete undoLog[transferId];
          return { transfers: { ...cur.transfers, [transferId]: optimistic }, undoLog };
        });
        begin();
        try {
          const saved = await api.advanceTransfer(transferId, t.itStatus);
          set((cur) => ({ transfers: { ...cur.transfers, [transferId]: saved } }));
          return { ok: true, undoKey: "", status: saved.itStatus };
        } catch (err) {
          set((cur) => ({ transfers: { ...cur.transfers, [transferId]: t } }));
          resync();
          return toFailure(err);
        } finally {
          end();
        }
      },

      acknowledgeTransfer: async (transferId) => {
        if (!allowed("transfers.advance")) return DENIED;
        const t = get().transfers[transferId];
        if (!t || transferId.startsWith("tmp_")) return { ok: false, error: "This request is still being saved." };
        if (t.acknowledgement) return { ok: true, undoKey: "", byName: t.acknowledgement.byName };
        const me = get().user;
        const optimistic: Transfer = { ...t, acknowledgement: { byId: me.id, byName: me.name, at: new Date(nowMs()).toISOString() } };
        set((cur) => {
          const undoLog = { ...cur.undoLog };
          delete undoLog[transferId];
          return { transfers: { ...cur.transfers, [transferId]: optimistic }, undoLog };
        });
        begin();
        try {
          const saved = await api.acknowledgeTransfer(transferId, t.version);
          set((cur) => ({ transfers: { ...cur.transfers, [transferId]: saved } }));
          return { ok: true, undoKey: "", byName: saved.acknowledgement?.byName ?? me.name };
        } catch (err) {
          set((cur) => ({ transfers: { ...cur.transfers, [transferId]: t } }));
          resync();
          return toFailure(err);
        } finally {
          end();
        }
      },

      assignSeat: async (memberId, seatId) => {
        if (!allowed("seats.assign")) return DENIED;
        const s = get();
        const m = s.members[memberId];
        if (!m) return { ok: false, error: "That person is no longer in your view." };
        if (m.status !== "active") return { ok: false, error: `${m.name} is not active.` };
        const seat = seatId ? seatIndex(s.floors).get(seatId) : undefined;
        if (seatId && !seat) return { ok: false, error: "That seat is no longer on a published floor." };
        if (seatId === m.seatId) return { ok: true, undoKey: "", member: m };
        const optimistic: Member = {
          ...m,
          seatId,
          seat: seat?.code ?? null,
          floorId: seat?.floorId ?? null,
          version: m.version + 1,
        };
        set((cur) => ({ members: { ...cur.members, [memberId]: optimistic } }));
        begin();
        try {
          const saved = await floorsApi.assignSeat(memberId, { seatId, expectedVersion: m.version });
          set((cur) => ({ members: { ...cur.members, [memberId]: saved } }));
          return { ok: true, undoKey: "", member: saved };
        } catch (err) {
          set((cur) => ({ members: { ...cur.members, [memberId]: m } }));
          resync();
          return toFailure(err);
        } finally {
          end();
        }
      },

      applyMember: (m) =>
        set((cur) => {
          const prev = cur.members[m.id];
          if (prev && prev.version > m.version) return cur;
          // Admin and IT hold the whole organisation; a lead only their team.
          const here = cur.user.role !== "team_lead" || m.teamId === cur.currentTeamId;
          if (!here) {
            // Moved to another team (admin edit): drop it from this floor.
            if (!prev) return cur;
            const members = { ...cur.members };
            delete members[m.id];
            return { members, memberIds: cur.memberIds.filter((id) => id !== m.id) };
          }
          return {
            members: { ...cur.members, [m.id]: m },
            memberIds: prev ? cur.memberIds : [...cur.memberIds, m.id],
          };
        }),

      upsertTransfer: (t) =>
        set((cur) => ({
          transfers: { ...cur.transfers, [t.id]: t },
          transferIds: cur.transferIds.includes(t.id) ? cur.transferIds : [t.id, ...cur.transferIds],
        })),

      markExit: async ({ memberIds, status, reason, effectiveDate }) => {
        if (!allowed("exits.create")) return DENIED;
        const s = get();
        const eligible = [...new Set(memberIds)]
          .map((id) => s.members[id])
          .filter(
            (m) =>
              m &&
              (s.currentTeamId === "" || m.teamId === s.currentTeamId) &&
              (m.status === "active" || (status === "resigned" && m.status === "unknown")),
          );
        if (eligible.length === 0) return { ok: false, error: "None of the selected members can be updated." };

        const at = new Date(nowMs()).toISOString();
        const records: ExitRecord[] = eligible.map((m) => ({
          id: tempId("exit"),
          memberId: m.id,
          memberName: m.name,
          status,
          seat: m.seat,
          seatId: m.seatId,
          effectiveDate,
          createdAt: at,
          initiatedBy: s.user.name,
          reason: reason.trim(),
        }));
        const tempIds = new Set(records.map((r) => r.id));
        set((cur) => ({
          members: mergeMembers(cur.members, eligible.map((m) => ({ ...m, status, seat: null, seatId: null, floorId: null, version: m.version + 1 }))),
          exits: { ...cur.exits, ...indexById(records) },
          exitIds: [...records.map((r) => r.id), ...cur.exitIds],
        }));
        begin();
        try {
          const res = await api.markExit({ memberIds: eligible.map((m) => m.id), status, reason: reason.trim(), effectiveDate });
          set((cur) => {
            const exits = { ...cur.exits, ...indexById(res.exits) };
            for (const id of tempIds) delete exits[id];
            const serverIds = res.exits.map((e) => e.id);
            return {
              members: mergeMembers(cur.members, res.members),
              exits,
              exitIds: [...serverIds, ...cur.exitIds.filter((id) => !tempIds.has(id) && !serverIds.includes(id))],
              undoLog: {
                ...cur.undoLog,
                [res.batchId]: { kind: "exit", batchId: res.batchId, exitIds: serverIds, expiresAt: Date.parse(res.undoExpiresAt) },
              },
            };
          });
          return { ok: true, undoKey: res.batchId, count: res.exits.length };
        } catch (err) {
          set((cur) => {
            const exits = { ...cur.exits };
            for (const id of tempIds) delete exits[id];
            return {
              members: mergeMembers(cur.members, eligible),
              exits,
              exitIds: cur.exitIds.filter((id) => !tempIds.has(id)),
            };
          });
          resync();
          return toFailure(err);
        } finally {
          end();
        }
      },

      undo: async (undoKey) => {
        const entry = get().undoLog[undoKey];
        if (!entry) return { ok: false, error: "This change can no longer be undone." };
        if (!allowed(entry.kind === "transfer" ? "transfers.undo" : "exits.undo")) return DENIED;
        if (entry.expiresAt <= nowMs()) {
          set((cur) => {
            const undoLog = { ...cur.undoLog };
            delete undoLog[undoKey];
            return { undoLog };
          });
          return { ok: false, error: "The undo window has passed." };
        }
        begin();
        try {
          const res = entry.kind === "transfer" ? await api.undoTransfer(entry.transferId) : await api.undoExitBatch(entry.batchId);
          set((cur) => {
            const undoLog = { ...cur.undoLog };
            delete undoLog[undoKey];
            const members = mergeMembers(cur.members, res.members);
            if (entry.kind === "transfer") {
              const transfers = { ...cur.transfers };
              delete transfers[entry.transferId];
              return { members, undoLog, transfers, transferIds: cur.transferIds.filter((id) => id !== entry.transferId) };
            }
            const removed = new Set(entry.exitIds);
            const exits = { ...cur.exits };
            for (const id of removed) delete exits[id];
            return { members, undoLog, exits, exitIds: cur.exitIds.filter((id) => !removed.has(id)) };
          });
          return { ok: true, undoKey };
        } catch (err) {
          if (err instanceof ApiError && err.isConflict) {
            set((cur) => {
              const undoLog = { ...cur.undoLog };
              delete undoLog[undoKey];
              return { undoLog };
            });
          }
          resync();
          return toFailure(err);
        } finally {
          end();
        }
      },

      updateProfile: async (input) => {
        begin();
        try {
          const user = await api.updateProfile(input);
          set((cur) => {
            // A lead's name is shown on their team; keep it in step.
            const team = user.role === "team_lead" && user.teamId ? cur.teams[user.teamId] : undefined;
            if (!team) return { user };
            const leads = team.leads.map((l) => (l.id === user.id ? { ...l, name: user.name } : l));
            return {
              user,
              teams: { ...cur.teams, [team.id]: { ...team, leads, leadName: leads.map((l) => l.name).join(", ") || team.leadName } },
            };
          });
          return { ok: true, undoKey: "" };
        } catch (err) {
          return toFailure(err);
        } finally {
          end();
        }
      },

      setNotification: async (id, on) => {
        const previous = get().notifications[id];
        set((cur) => ({ notifications: { ...cur.notifications, [id]: on } }));
        begin();
        try {
          const saved = await api.updateSettings({ [id]: on });
          set({ notifications: saved.notifications });
          return { ok: true, undoKey: "" };
        } catch (err) {
          set((cur) => ({ notifications: { ...cur.notifications, [id]: previous } }));
          return toFailure(err);
        } finally {
          end();
        }
      },
    };
  });
}

export type WorkspaceStoreApi = ReturnType<typeof createWorkspaceStore>;
