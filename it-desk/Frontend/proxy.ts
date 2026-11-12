import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route protection: requests without a session cookie never reach
 * a protected page; they are sent to the sign-in screen with a return URL.
 * The session itself is validated against the API by the app layout (and by
 * the API on every call), so a forged or stale cookie gets no further.
 */
const SESSION_COOKIES = ["__Host-itdesk_session", "itdesk_session"];
const PUBLIC_PATHS = ["/login", "/change-password"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = SESSION_COOKIES.some((name) => Boolean(request.cookies.get(name)?.value));

  if (!isPublic && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  // Layouts don't receive the URL; forward it so a server-side redirect can return here.
  const forwarded = new Headers(request.headers);
  forwarded.set("x-itdesk-path", `${pathname}${search}`);
  return NextResponse.next({ request: { headers: forwarded } });
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
