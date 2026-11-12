"use client";

import { ArrowRight, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { ApiError, authApi } from "@/lib/api";
import { landingFor } from "@/lib/route-access";
import { cn } from "@/lib/utils";
import { Field, inputClass } from "@/components/ui/field";
import { AuthFrame } from "./auth-frame";
import { Notice, type NoticeTone } from "./notice";
import { PasswordInput } from "./password-input";

const loginSchema = z.object({
  email: z.string().trim().min(1, "Enter your work email").max(254, "That email is too long").pipe(z.email("Enter a valid email address")),
  password: z.string().min(1, "Enter your password").max(256, "That password is too long"),
});
type Errors = Partial<Record<"email" | "password", string>>;

type Banner = { tone: NoticeTone; title?: string; text: string } | null;

const REASON: Record<string, Banner> = {
  expired: { tone: "info", text: "Your session ended. Sign in again to pick up where you left off." },
  signed_out: { tone: "info", text: "You’ve been signed out." },
  password_changed: { tone: "info", text: "Password updated. Sign in with your new password." },
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Per-tab navigation state from a previous user must not leak into this sign-in. */
function clearClientRouteState() {
  try {
    window.sessionStorage.clear();
  } catch {}
}

export function LoginView() {
  const params = useSearchParams();
  const next = params.get("next");
  const reason = params.get("reason");
  const uid = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<Banner>(reason ? (REASON[reason] ?? null) : null);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [caps, setCaps] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Already signed in (another tab, back button)? Skip the form.
  useEffect(() => {
    const ctrl = new AbortController();
    authApi
      .me({ silent: true, signal: ctrl.signal })
      .then((s) => {
        setRedirecting(true);
        window.location.replace(s.mustChangePassword ? "/change-password" : landingFor(s, next));
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [next]);

  // Lockout countdown.
  useEffect(() => {
    if (!lockedUntil) return;
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockedUntil) {
        setLockedUntil(null);
        setBanner(null);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  const locked = lockedUntil !== null && lockedUntil > now;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || locked) return;
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const errs: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Errors;
        errs[key] ??= issue.message;
      }
      setErrors(errs);
      (errs.email ? emailRef.current : document.getElementById(`${uid}-password`))?.focus();
      return;
    }
    setErrors({});
    setBanner(null);
    setSubmitting(true);
    try {
      const session = await authApi.login({ email: parsed.data.email.toLowerCase(), password: parsed.data.password });
      setRedirecting(true);
      // Full navigation: the server renders the app with the fresh session cookie.
      const dest = landingFor(session, next);
      clearClientRouteState();
      window.location.assign(session.mustChangePassword ? `/change-password?next=${encodeURIComponent(dest)}` : dest);
    } catch (err) {
      setSubmitting(false);
      setPassword("");
      if (err instanceof ApiError) {
        if (err.code === "too_many_attempts" || err.status === 429) {
          const wait = err.retryAfterMs ?? 60_000;
          const t = Date.now();
          setNow(t);
          setLockedUntil(t + wait);
          setBanner({ tone: "lock", title: "Sign-in temporarily locked", text: err.message });
          return;
        }
        if (err.code === "invalid_credentials" || err.status === 401) {
          setBanner({ tone: "error", text: "Email or password is incorrect. Check both and try again." });
          document.getElementById(`${uid}-password`)?.focus();
          return;
        }
        if (err.status === 422 && err.fields) {
          setErrors({ email: err.fields.email, password: err.fields.password });
          return;
        }
        if (err.isUnavailable) {
          setBanner({ tone: "offline", title: "Can’t reach IT-Desk", text: "The server isn’t responding. Check your connection and try again in a moment." });
          return;
        }
        setBanner({ tone: "error", text: err.requestId ? `${err.message} (ref ${err.requestId.slice(0, 8)})` : err.message });
        return;
      }
      setBanner({ tone: "error", text: "Something went wrong. Please try again." });
    }
  };

  const busy = submitting || redirecting;

  return (
    <AuthFrame>
      <div className="lg:hidden">
        <span className="inline-flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white shadow-xs">
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
              <rect x="2.5" y="3" width="4.5" height="4.5" rx="1.2" fill="currentColor" />
              <rect x="9" y="3" width="4.5" height="4.5" rx="1.2" fill="currentColor" opacity="0.45" />
              <rect x="2.5" y="9.5" width="4.5" height="4.5" rx="1.2" fill="currentColor" opacity="0.45" />
              <rect x="9" y="9.5" width="4.5" height="4.5" rx="1.2" fill="currentColor" />
            </svg>
          </span>
          <span className="text-base font-semibold tracking-[-0.02em] text-neutral-900">IT-Desk</span>
        </span>
      </div>

      <h1 className="mt-10 text-[26px] font-semibold tracking-[-0.03em] text-neutral-900 lg:mt-0">Sign in</h1>
      <p className="mt-1.5 text-sm leading-6 text-neutral-500">Use the work account your administrator set up for you.</p>

      <div className="mt-6 min-h-0 space-y-3" aria-live="polite">
        {banner ? (
          <Notice tone={banner.tone} title={banner.title}>
            {banner.text}
            {locked ? (
              <span className="tnum mt-1 block font-mono text-xs font-semibold" aria-live="off">
                Try again in {clock(lockedUntil - now)}
              </span>
            ) : null}
          </Notice>
        ) : null}
      </div>

      <form method="post" onSubmit={(e) => void submit(e)} noValidate className="mt-6 space-y-1" aria-busy={busy}>
        <Field id={`${uid}-email`} label="Work email" error={errors.email}>
          <input
            ref={emailRef}
            id={`${uid}-email`}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            placeholder="you@company.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (errors.email) setErrors((x) => ({ ...x, email: undefined }));
            }}
            disabled={busy}
            aria-invalid={Boolean(errors.email) || undefined}
            aria-describedby={`${uid}-email-msg`}
            maxLength={254}
            className={cn(inputClass, "h-11 text-[15px] disabled:bg-subtle")}
          />
        </Field>
        <Field
          id={`${uid}-password`}
          label="Password"
          error={errors.password}
          hint={caps ? "Caps Lock is on" : undefined}
        >
          <PasswordInput
            id={`${uid}-password`}
            name="password"
            value={password}
            onChange={(v) => {
              setPassword(v);
              if (errors.password) setErrors((x) => ({ ...x, password: undefined }));
            }}
            autoComplete="current-password"
            invalid={Boolean(errors.password)}
            disabled={busy}
            onCapsLock={setCaps}
            describedBy={`${uid}-password-msg`}
          />
        </Field>

        <button
          type="submit"
          disabled={busy || locked}
          className={cn(
            "group relative mt-2 inline-flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-lg text-[15px] font-semibold text-white outline-none transition-[background-color,box-shadow,opacity] duration-150",
            "bg-[linear-gradient(180deg,var(--color-brand-500),var(--color-brand-600))] shadow-[0_1px_2px_rgb(58_18_6/0.25),inset_0_1px_0_rgb(255_255_255/0.18)] hover:bg-[linear-gradient(180deg,var(--color-brand-600),var(--color-brand-700))]",
            "focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {redirecting ? "Opening your workspace…" : "Signing in…"}
            </>
          ) : locked ? (
            <span className="tnum">Locked · {clock(lockedUntil - now)}</span>
          ) : (
            <>
              Sign in
              <ArrowRight className="size-4 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
            </>
          )}
        </button>
      </form>

      <div className="mt-8 rounded-xl border border-line bg-subtle/70 px-4 py-3.5 text-[13px] leading-5 text-neutral-600">
        <p className="font-medium text-neutral-800">No account yet?</p>
        <p className="mt-0.5">
          IT-Desk has no self sign-up. An admin creates accounts for team leads and IT, and can reset a forgotten password.
        </p>
      </div>
    </AuthFrame>
  );
}
