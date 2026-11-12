"use client";

import { create } from "zustand";
import { ApiError } from "@/lib/api";
import { itStaffApi, type ITStaff } from "@/lib/it-staff";

/**
 * Active IT staff directory (small, rarely changes): fetched once when a
 * picker first needs it, refreshed after admin edits.
 */
type StaffState = {
  items: ITStaff[] | null;
  error: string | null;
  load: (opts?: { force?: boolean }) => Promise<void>;
};

let inflight: Promise<void> | null = null;

export const useITStaff = create<StaffState>()((set, get) => ({
  items: null,
  error: null,
  load: async ({ force = false } = {}) => {
    if (!force && get().items) return;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        set({ items: await itStaffApi.list(), error: null });
      } catch (err) {
        set({ error: err instanceof ApiError ? err.message : "Couldn’t load the IT staff list." });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
}));
