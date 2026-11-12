import { NAV_ITEMS } from "./nav";
import { homeFor, safeNext, type Permission, type Role } from "./session";

/**
 * Single source of truth for which permission a URL needs. Covers every nav
 * page (lib/nav.ts) plus sub-routes that are stricter than their nav entry.
 * New gated pages only need an entry in NAV_ITEMS or SUB_ROUTES.
 */
const SUB_ROUTES: { pattern: RegExp; permission: Permission }[] = [
  { pattern: /^\/floors\/manage(?:\/|$)/, permission: "floors.manage" },
  { pattern: /^\/floors\/[^/]+\/edit(?:\/|$)/, permission: "floors.manage" },
];

/** The permission `pathname` requires, or null for pages every signed-in user may open. */
export function requiredPermission(pathname: string): Permission | null {
  const path = pathname.split(/[?#]/)[0] || "/";
  const sub = SUB_ROUTES.find((r) => r.pattern.test(path));
  if (sub) return sub.permission;
  const page = NAV_ITEMS.filter((i) => (i.href === "/" ? path === "/" : path === i.href || path.startsWith(`${i.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return page && page.permission !== "self" ? page.permission : null;
}

export function canOpen(permissions: readonly string[], pathname: string) {
  const need = requiredPermission(pathname);
  return need === null || permissions.includes(need);
}

/**
 * Post-login destination: `next` only if it is a same-origin relative path the
 * signed-in role may open; otherwise the role's home.
 */
export function landingFor(session: { user: { role: Role }; permissions: readonly string[] }, next: string | null | undefined) {
  const home = homeFor(session.user.role);
  const dest = safeNext(next, home);
  return canOpen(session.permissions, dest) ? dest : home;
}
