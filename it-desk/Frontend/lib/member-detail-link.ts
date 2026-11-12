"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/** Set when we pushed `?member=` ourselves, so closing can step back instead of stacking history. */
let pushed = false;

/** Opens/closes the member detail sheet through `?member=<id>` (deep-linkable; Back closes it). */
export function useMemberDetailLink() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("member");
  const href = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set("member", id);
      else next.delete("member");
      const q = next.toString();
      return q ? `${pathname}?${q}` : pathname;
    },
    [params, pathname],
  );
  const open = useCallback(
    (id: string) => {
      if (current === id) return;
      if (current) router.replace(href(id), { scroll: false });
      else {
        pushed = true;
        router.push(href(id), { scroll: false });
      }
    },
    [current, href, router],
  );
  const close = useCallback(() => {
    if (!current) return;
    if (pushed) {
      pushed = false;
      router.back();
    } else router.replace(href(null), { scroll: false });
  }, [current, href, router]);
  return { memberId: current, open, close };
}
