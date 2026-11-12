"use client";

import { create } from "zustand";
import { ApiError } from "@/lib/api";
import { itRequestSchema, requestsApi, type ITRequest, type RequestCounts, type RequestForm } from "@/lib/requests";

/**
 * Client cache of the IT requests the signed-in user can see (the API scopes
 * the list: a lead gets their team, admin and IT the whole organisation).
 * The list is small, so it is fetched whole and filtered locally (no jitter
 * while typing); counts come from the server. Refreshed on focus, on an
 * interval, and after every write.
 */

type Overlay<T> = { open: boolean; nonce: number } & T;

type RequestsState = {
  userId: string | null;
  items: ITRequest[] | null;
  counts: RequestCounts | null;
  total: number;
  error: string | null;
  loading: boolean;
  /** "Request IT" dialog. `draft`/`errors` restore the form after a failed send. */
  dialog: Overlay<{ draft: RequestForm | null; errors: Record<string, string> | null }>;
  /** Detail sheet (mounted in the shell, so a toast can open it from any page). */
  detail: Overlay<{ id: string | null }>;
  load: (userId: string, opts?: { silent?: boolean }) => Promise<void>;
  upsert: (request: ITRequest) => void;
  reset: () => void;
  openDialog: (draft?: RequestForm | null, errors?: Record<string, string> | null) => void;
  closeDialog: () => void;
  openDetail: (id: string) => void;
  closeDetail: () => void;
};

let nonce = 0;
let inflight: Promise<void> | null = null;

/** Detail responses carry the timeline; the list cache keeps the summary only. */
const strip = (r: ITRequest): ITRequest => itRequestSchema.parse(r);

export const useRequests = create<RequestsState>()((set, get) => ({
  userId: null,
  items: null,
  counts: null,
  total: 0,
  error: null,
  loading: false,
  dialog: { open: false, nonce: 0, draft: null, errors: null },
  detail: { open: false, nonce: 0, id: null },

  load: async (userId, opts = {}) => {
    if (get().userId !== userId) set({ userId, items: null, counts: null, total: 0, error: null });
    if (inflight) return inflight;
    if (!opts.silent) set({ loading: true });
    inflight = (async () => {
      try {
        const list = await requestsApi.list({ limit: 200, sort: "newest" });
        if (get().userId !== userId) return; // signed out / switched user meanwhile
        set({ items: list.items, counts: list.counts, total: list.total, error: null });
      } catch (err) {
        if (get().userId !== userId) return;
        set({ error: err instanceof ApiError ? err.message : "Couldn’t load requests." });
      } finally {
        inflight = null;
        set({ loading: false });
      }
    })();
    return inflight;
  },

  upsert: (request) =>
    set((s) => {
      const r = strip(request);
      const items = s.items ?? [];
      const i = items.findIndex((x) => x.id === r.id);
      if (i === -1) return { items: [r, ...items] };
      const next = items.slice();
      next[i] = r;
      return { items: next };
    }),

  reset: () => set({ userId: null, items: null, counts: null, total: 0, error: null, loading: false }),

  openDialog: (draft = null, errors = null) => set({ dialog: { open: true, nonce: ++nonce, draft, errors } }),
  closeDialog: () => set((s) => ({ dialog: { ...s.dialog, open: false } })),
  openDetail: (id) => set({ detail: { open: true, nonce: ++nonce, id } }),
  closeDetail: () => set((s) => ({ detail: { ...s.detail, open: false } })),
}));
