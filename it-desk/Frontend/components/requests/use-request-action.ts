"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import type { ITRequestDetail } from "@/lib/requests";
import { useRequests } from "@/store/requests-store";
import { useSession } from "@/components/auth/session-provider";

/**
 * Runs one request mutation with a pending flag, toasts and cache upkeep.
 * Every write sends `expectedVersion`; on a conflict (someone else changed the
 * request) the list is refreshed and `onConflict` lets the caller reload.
 */
export function useRequestAction(opts: { onDone?: (r: ITRequestDetail) => void; onConflict?: () => void } = {}) {
  const { session } = useSession();
  const upsert = useRequests((s) => s.upsert);
  const load = useRequests((s) => s.load);
  const [pending, setPending] = useState<string | null>(null);

  const run = async (key: string, ticket: string, fn: () => Promise<ITRequestDetail>, success?: (r: ITRequestDetail) => string) => {
    if (pending) return null;
    setPending(key);
    try {
      const r = await fn();
      upsert(r);
      opts.onDone?.(r);
      if (success) toast.success(success(r));
      void load(session.user.id, { silent: true });
      return r;
    } catch (err) {
      const conflict = err instanceof ApiError && err.status === 409;
      toast.error(conflict ? `${ticket} changed meanwhile` : `${ticket}: couldn’t update`, {
        description: conflict ? "We loaded the latest version. Check it and try again." : err instanceof ApiError ? err.message : "Please try again.",
      });
      if (conflict) {
        opts.onConflict?.();
        void load(session.user.id, { silent: true });
      }
      return null;
    } finally {
      setPending(null);
    }
  };

  return { pending, run };
}
