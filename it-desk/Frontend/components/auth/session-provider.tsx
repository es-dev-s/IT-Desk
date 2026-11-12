"use client";

import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { authApi, setAuthHandlers, setCsrfToken } from "@/lib/api";
import { can as hasPermission, type Permission, type Session } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/shell/logo";

type SessionContextValue = {
  session: Session;
  can: (permission: Permission) => boolean;
  /** Re-read the session from the API (e.g. after a profile change). */
  refresh: () => Promise<boolean>;
  replace: (session: Session) => void;
  signOut: () => Promise<void>;
  signingOut: boolean;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/** Where the browser is right now, as a return URL for the sign-in screen. */
const here = () => `${window.location.pathname}${window.location.search}`;

/**
 * Set once the page is navigating away to sign-in or change-password, so
 * parallel 401s don't trigger a second navigation. Module-level on purpose:
 * the navigation is a full page load, which resets it.
 */
let leaving = false;
const leaveOnce = (go: () => void) => {
  if (leaving) return;
  leaving = true;
  go();
};

const isUnauthenticated = (err: unknown) => Boolean(err && typeof err === "object" && "status" in err && err.status === 401);

function goToChangePassword() {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load re-validates the session on the server
  window.location.assign(`/change-password?next=${encodeURIComponent(here())}`);
}

function goToLogin(reason: "expired" | "signed_out") {
  const next = reason === "expired" ? `&next=${encodeURIComponent(here())}` : "";
  // A full navigation drops every in-memory cache of the previous session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional full load
  window.location.assign(`/login?reason=${reason}${next}`);
}

/**
 * Holds the signed-in session for the app shell. The server layout already
 * validated it against the API; this keeps it fresh, feeds the CSRF token to
 * the API client and routes auth failures (401 → sign-in with a return URL,
 * forced password change → change-password).
 */
export function SessionProvider({ initial, children }: { initial: Session | null; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(initial);
  const [probe, setProbe] = useState<"idle" | "loading" | "failed">(initial ? "idle" : "loading");
  const [signingOut, setSigningOut] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await authApi.me({ silent: true });
      setCsrfToken(next.csrfToken);
      setSession(next);
      if (next.mustChangePassword) leaveOnce(goToChangePassword);
      return true;
    } catch (err) {
      if (isUnauthenticated(err)) leaveOnce(() => goToLogin("expired"));
      return false;
    }
  }, []);

  // The server couldn't reach the API while rendering: confirm the session from the browser.
  useEffect(() => {
    if (probe !== "loading") return;
    const ctrl = new AbortController();
    authApi.me({ silent: true, signal: ctrl.signal }).then(
      (next) => {
        setCsrfToken(next.csrfToken);
        setSession(next);
        setProbe("idle");
        if (next.mustChangePassword) leaveOnce(goToChangePassword);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (isUnauthenticated(err)) leaveOnce(() => goToLogin("expired"));
        else setProbe("failed");
      },
    );
    return () => ctrl.abort();
  }, [probe]);

  useEffect(() => {
    setCsrfToken(session?.csrfToken ?? null);
  }, [session?.csrfToken]);

  useEffect(
    () =>
      setAuthHandlers({
        onUnauthenticated: () => leaveOnce(() => goToLogin("expired")),
        onPasswordChangeRequired: () => leaveOnce(goToChangePassword),
        refreshCsrf: refresh,
      }),
    [refresh],
  );

  // Revoked elsewhere (admin, another tab signing out)? Notice on return to the tab.
  useEffect(() => {
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await authApi.logout();
    } catch (err) {
      // Already signed out (401) is fine; anything else leaves the cookie valid.
      if (!isUnauthenticated(err)) {
        setSigningOut(false);
        throw err;
      }
    }
    setCsrfToken(null);
    // Sign-out never carries a return path, and per-tab route state is dropped,
    // so the next person to sign in starts from their own home.
    try {
      window.sessionStorage.clear();
    } catch {}
    leaving = false;
    leaveOnce(() => goToLogin("signed_out"));
  }, []);

  const value = useMemo<SessionContextValue | null>(
    () =>
      session
        ? {
            session,
            can: (permission) => hasPermission(session, permission),
            refresh,
            replace: setSession,
            signOut,
            signingOut,
          }
        : null,
    [session, refresh, signOut, signingOut],
  );

  if (!value) {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas px-6">
        <div className="flex max-w-sm flex-col items-center text-center">
          <Logo />
          {probe === "failed" ? (
            <>
              <h1 className="mt-6 text-[15px] font-semibold text-neutral-900">Can’t reach the IT Desk server</h1>
              <p className="mt-1.5 text-sm text-neutral-500">We couldn’t confirm your session. Check your connection and try again.</p>
              <Button className="mt-5" variant="dark" onClick={() => setProbe("loading")}>
                Try again
              </Button>
            </>
          ) : (
            <p className="mt-6 text-sm text-neutral-500" role="status">
              Checking your session…
            </p>
          )}
        </div>
      </div>
    );
  }

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession() {
  const value = use(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

/** True when the signed-in role holds `permission`. */
export function useCan(permission: Permission) {
  return useSession().can(permission);
}
