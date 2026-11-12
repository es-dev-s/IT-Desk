import { cookies, headers } from "next/headers";
import { redirect, RedirectType } from "next/navigation";
import { canOpen } from "./route-access";
import { SESSION_COOKIES, homeFor, safeNext, sessionSchema, type Session } from "./session";

/** API base for server-side calls (inside a container this differs from the browser's). */
const API_ORIGIN = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");

/** The path being rendered, forwarded by proxy.ts (layouts don't receive it otherwise). */
async function currentPath() {
  return safeNext((await headers()).get("x-itdesk-path"), "/");
}

/**
 * Validates the session cookie against the API before any protected UI is
 * rendered. The proxy only checks that a cookie exists; this is the real check.
 *
 * - no cookie / 401 → sign-in screen with a return URL
 * - password change required → change-password screen
 * - API unreachable → null: the client confirms the session itself and shows
 *   a recoverable state, so a blip never signs anyone out
 */
export async function requireSession(): Promise<Session | null> {
  const jar = await cookies();
  const path = await currentPath();
  const login = (reason?: string) => `/login?${reason ? `reason=${reason}&` : ""}next=${encodeURIComponent(path)}`;

  const cookie = SESSION_COOKIES.map((name) => jar.get(name)).find((c) => c?.value);
  if (!cookie) redirect(login());

  let res: Response;
  try {
    res = await fetch(`${API_ORIGIN}/api/v1/auth/me`, {
      headers: { cookie: `${cookie.name}=${cookie.value}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  if (res.status === 401) redirect(login("expired"));
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    if (body?.error?.code === "password_change_required") redirect(`/change-password?next=${encodeURIComponent(path)}`);
    return null;
  }
  if (!res.ok) return null;

  const parsed = sessionSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return null;
  if (parsed.data.mustChangePassword) redirect(`/change-password?next=${encodeURIComponent(path)}`);
  return parsed.data;
}

/**
 * Server half of the central route guard: a role without the permission the
 * current route needs (lib/route-access.ts) is replaced to its home, so it
 * never sees the page or a 403 screen.
 */
export async function requireRouteAccess(session: Session) {
  // Only judge real page loads: without proxy.ts's header (e.g. prefetches) the path is unknown.
  const raw = (await headers()).get("x-itdesk-path");
  if (!raw) return;
  const path = safeNext(raw, "/");
  if (!canOpen(session.permissions, path)) redirect(homeFor(session.user.role), RedirectType.replace);
}
