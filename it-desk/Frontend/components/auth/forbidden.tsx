"use client";

import { ArrowLeft, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { homeFor, type Permission } from "@/lib/session";
import { buttonClass } from "@/components/ui/button";
import { useSession } from "./session-provider";
import { RoleBadge } from "./role-badge";

/** Calm 403 state: says what happened, who you are signed in as, and where to go. */
export function Forbidden({ title = "You don’t have access to this page", description }: { title?: string; description?: string }) {
  const { session } = useSession();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center" data-testid="forbidden">
      <span className="relative grid size-14 place-items-center rounded-2xl bg-[linear-gradient(160deg,var(--color-brand-50),var(--color-brand-100))] text-accent ring-1 ring-inset ring-accent/15">
        <ShieldAlert className="size-6" aria-hidden />
      </span>
      <p className="mt-5 font-mono text-[11px] font-semibold tracking-[0.18em] text-accent">ERROR 403</p>
      <h1 className="mt-2 text-lg font-semibold tracking-[-0.02em] text-neutral-900">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-500">
        {description ?? "Your role doesn’t include this area. If you need it for your work, ask an admin to update your access."}
      </p>
      <div className="mt-4 flex items-center gap-2 text-xs text-neutral-500">
        Signed in as <span className="font-medium text-neutral-800">{session.user.name}</span>
        <RoleBadge role={session.user.role} />
      </div>
      <Link href={homeFor(session.user.role)} className={buttonClass("secondary", "md", "mt-7")}>
        <ArrowLeft aria-hidden />
        Back to your workspace
      </Link>
    </div>
  );
}

/**
 * Renders children only for roles holding `permission`. The central route
 * guard (app layout + RouteGuard) normally redirects before this renders, so
 * the 403 state is only a last-resort fallback.
 */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useSession();
  return can(permission) ? children : <Forbidden />;
}

/** "/" is the overview for leads and admins; IT lands on its queue. */
export function HomeRoute({ children }: { children: ReactNode }) {
  const { session, can } = useSession();
  const router = useRouter();
  const target = homeFor(session.user.role);
  const redirecting = !can("analytics.view") && target !== "/";
  useEffect(() => {
    if (redirecting) router.replace(target);
  }, [redirecting, router, target]);
  if (redirecting) return null;
  return can("analytics.view") ? children : <Forbidden />;
}
