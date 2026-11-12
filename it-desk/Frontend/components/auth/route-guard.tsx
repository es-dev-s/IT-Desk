"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { canOpen } from "@/lib/route-access";
import { homeFor } from "@/lib/session";
import { useSession } from "./session-provider";

/**
 * Client half of the central route guard (the app layout does the same check
 * on the server for full loads). A role that can't open the current route is
 * replaced to its home — nothing of the page renders, so there is no 403 flash.
 */
export function RouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { session } = useSession();
  const allowed = canOpen(session.permissions, pathname);
  const home = homeFor(session.user.role);
  useEffect(() => {
    if (!allowed) router.replace(home);
  }, [allowed, home, router]);
  return allowed ? children : null;
}
