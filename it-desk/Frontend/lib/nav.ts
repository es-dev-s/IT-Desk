import { ArrowLeftRight, Building2, FileSpreadsheet, LayoutGrid, Map as MapIcon, LifeBuoy, MessagesSquare, Settings, ShieldCheck, Users, Wrench, type LucideIcon } from "lucide-react";
import type { Permission, Role } from "./session";

export type NavChild = { href: string; label: string };
/** `children` turns the entry into a group in the sidebar: it opens to list them instead of linking anywhere itself. */
export type NavItem = { href: string; label: string; icon: LucideIcon; permission: Permission; description: string; children?: readonly NavChild[] };

/** Every page, with the permission that unlocks it. The nav only lists what the role can open. */
export const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: LayoutGrid, permission: "analytics.view", description: "Team health at a glance" },
  { href: "/queue", label: "IT queue", icon: Wrench, permission: "transfers.advance", description: "Device moves to work through" },
  { href: "/members", label: "Members", icon: Users, permission: "floor.view", description: "People and seats" },
  { href: "/floors", label: "Floors", icon: MapIcon, permission: "floor.view", description: "Floor plans, team zones and seats" },
  { href: "/transfers", label: "Transfers", icon: ArrowLeftRight, permission: "transfers.view", description: "Moves and their IT status" },
  { href: "/requests", label: "Requests", icon: LifeBuoy, permission: "requests.view", description: "Equipment and support asks to IT" },
  { href: "/messages", label: "Messages", icon: MessagesSquare, permission: "requests.comment", description: "Chat with IT about a request" },
  {
    href: "/reports",
    label: "Reports",
    icon: FileSpreadsheet,
    permission: "reports.view",
    description: "Seats, devices and IT tasks",
    children: [
      { href: "/reports/members", label: "Member & device report" },
      { href: "/reports/it-tasks", label: "IT task report" },
    ],
  },
  { href: "/teams", label: "Teams", icon: Building2, permission: "users.manage", description: "Teams and their leads" },
  { href: "/users", label: "Users", icon: ShieldCheck, permission: "users.manage", description: "Accounts and access" },
  { href: "/settings", label: "Settings", icon: Settings, permission: "self", description: "Profile and notifications" },
] as const satisfies readonly NavItem[];

export function navFor(permissions: readonly string[]): NavItem[] {
  return NAV_ITEMS.filter((item) => permissions.includes(item.permission));
}

export function isActivePath(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export type Crumb = { label: string; href?: string; icon?: LucideIcon };

/** Pages whose content follows the team in focus (admins can switch it). */
const TEAM_SCOPED = new Set(["/", "/members"]);

/**
 * Role-aware trail. The last crumb is the current page and carries no href.
 * - Team lead: Team › Page
 * - Admin:     Organization › Team (team-scoped pages) › Page
 * - IT:        IT operations › Page
 */
export function getBreadcrumbs(pathname: string, ctx: { role: Role; teamName?: string; home: string }): Crumb[] {
  const page = NAV_ITEMS.find((item) => isActivePath(pathname, item.href));
  const sub = page ? subPages(pathname, page.href) : [];
  const current: Crumb = { label: page?.label ?? "Not found", icon: page?.icon, href: sub.length ? page?.href : undefined };
  const tail = [current, ...sub];
  if (ctx.role === "team_lead") return [{ label: ctx.teamName ?? "My team", href: ctx.home }, ...tail];
  if (ctx.role === "it") return [{ label: "IT operations", href: ctx.home }, ...tail];
  const trail: Crumb[] = [{ label: "Organization", href: ctx.home }];
  if (page && TEAM_SCOPED.has(page.href) && ctx.teamName) trail.push({ label: ctx.teamName, href: "/" });
  return [...trail, ...tail];
}

/** Crumbs below a nav page (floor management and the layout builder). */
function subPages(pathname: string, href: string): Crumb[] {
  const child = NAV_ITEMS.find((i): i is (typeof NAV_ITEMS)[number] & { children: readonly NavChild[] } => i.href === href && "children" in i)?.children.find((c) =>
    isActivePath(pathname, c.href),
  );
  if (child) return [{ label: child.label }];
  if (href !== "/floors" || pathname === "/floors") return [];
  if (pathname === "/floors/manage") return [{ label: "Manage" }];
  if (/^\/floors\/[^/]+\/edit$/.test(pathname)) return [{ label: "Manage", href: "/floors/manage" }, { label: "Edit layout" }];
  return [];
}
