"use client";

import { Check, KeyRound, Loader2, LogOut } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ApiError, authApi, setCsrfToken } from "@/lib/api";
import { MAX_PASSWORD, MIN_PASSWORD, ROLE_LABEL, homeFor, passwordProblem, passwordStrength, safeNext, type Session } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Field } from "@/components/ui/field";
import { AuthFrame } from "./auth-frame";
import { Notice } from "./notice";
import { PasswordInput } from "./password-input";

type Errors = Partial<Record<"current" | "next" | "confirm", string>>;

const STRENGTH = [
  { label: "Too short", bar: "bg-neutral-200", text: "text-neutral-500" },
  { label: "Weak", bar: "bg-red-500", text: "text-red-600" },
  { label: "Fair", bar: "bg-amber-500", text: "text-amber-700" },
  { label: "Good", bar: "bg-lime-600", text: "text-lime-700" },
  { label: "Strong", bar: "bg-emerald-600", text: "text-emerald-700" },
] as const;

export function ChangePasswordView() {
  const params = useSearchParams();
  const uid = useId();
  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [current, setCurrent] = useState("");
  const [nextPw, setNextPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [caps, setCaps] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    authApi
      .me({ silent: true, signal: ctrl.signal })
      .then((s) => {
        setCsrfToken(s.csrfToken);
        setSession(s);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          window.location.replace(`/login?next=${encodeURIComponent("/change-password")}`);
          return;
        }
        setLoadError(err instanceof ApiError && err.isUnavailable ? "The IT-Desk server isn’t responding." : "We couldn’t load your account.");
      });
    return () => ctrl.abort();
  }, [attempt]);

  const ctx = session ? { email: session.user.email, name: session.user.name } : {};
  const problem = nextPw ? passwordProblem(nextPw, ctx) : null;
  const strength = nextPw.length < MIN_PASSWORD ? 0 : Math.max(1, passwordStrength(nextPw) - (problem ? 2 : 0));
  const forced = session?.mustChangePassword ?? false;
  const dest = session ? safeNext(params.get("next"), homeFor(session.user.role)) : "/";

  const checks = [
    { ok: nextPw.length >= MIN_PASSWORD, text: `At least ${MIN_PASSWORD} characters` },
    { ok: Boolean(nextPw) && !problem, text: "Not common or based on your name/email" },
    { ok: Boolean(nextPw) && nextPw !== current, text: "Different from your current password" },
  ];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || submitting) return;
    const errs: Errors = {};
    if (!current) errs.current = forced ? "Enter the temporary password you were given" : "Enter your current password";
    if (!nextPw) errs.next = "Choose a new password";
    else if (problem) errs.next = problem;
    else if (nextPw === current) errs.next = "Choose a password you haven’t just used";
    if (!errs.next && confirm !== nextPw) errs.confirm = "Passwords don’t match";
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = errs.current ? "current" : errs.next ? "new" : "confirm";
      document.getElementById(`${uid}-${first}`)?.focus();
      return;
    }
    setBanner(null);
    setSubmitting(true);
    try {
      const updated = await authApi.changePassword({ currentPassword: current, newPassword: nextPw });
      setCsrfToken(updated.csrfToken);
      setDone(true);
      window.setTimeout(() => window.location.assign(safeNext(params.get("next"), homeFor(updated.user.role))), 700);
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        if (err.status === 401 && err.code !== "invalid_credentials") {
          window.location.replace(`/login?reason=expired&next=${encodeURIComponent("/change-password")}`);
          return;
        }
        if (err.code === "invalid_credentials") {
          setErrors({ current: "That password isn’t right" });
          setCurrent("");
          document.getElementById(`${uid}-current`)?.focus();
          return;
        }
        if (err.status === 422 && err.fields) {
          setErrors({ current: err.fields.currentPassword, next: err.fields.newPassword ?? err.fields.password });
          if (!err.fields.currentPassword && !err.fields.newPassword && !err.fields.password) setBanner(err.message);
          return;
        }
        setBanner(err.isUnavailable ? "Can’t reach IT-Desk right now. Your password wasn’t changed. Try again in a moment." : err.message);
        return;
      }
      setBanner("Something went wrong. Your password wasn’t changed.");
    }
  };

  const signOut = async () => {
    try {
      await authApi.logout();
    } catch {
      /* the session is gone either way */
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load clears client state
    window.location.assign("/login?reason=signed_out");
  };

  return (
    <AuthFrame>
      <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent ring-1 ring-inset ring-accent-line">
        <KeyRound className="size-5" aria-hidden />
      </span>
      <h1 className="mt-5 text-[26px] font-semibold tracking-[-0.03em] text-neutral-900">
        {forced ? "Set your password" : "Change password"}
      </h1>
      <p className="mt-1.5 text-sm leading-6 text-neutral-500">
        {session ? (
          <>
            Signed in as <span className="font-medium text-neutral-800">{session.user.email}</span> · {ROLE_LABEL[session.user.role]}
          </>
        ) : (
          "Checking your session…"
        )}
      </p>

      <div className="mt-6 space-y-3" aria-live="polite">
        {forced && !done ? (
          <Notice tone="lock" title="A new password is required">
            You signed in with a temporary password from your admin. Choose your own to continue. Other sessions are signed out.
          </Notice>
        ) : null}
        {loadError ? (
          <Notice tone="offline" title="Can’t continue yet">
            {loadError}{" "}
            <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </Notice>
        ) : null}
        {banner ? <Notice tone="error">{banner}</Notice> : null}
        {done ? (
          <Notice tone="info" title="Password updated">
            Taking you to your workspace…
          </Notice>
        ) : null}
      </div>

      <form method="post" onSubmit={(e) => void submit(e)} noValidate className="mt-6 space-y-1" aria-busy={submitting}>
        {/* Lets password managers attach the new password to the right account. */}
        <input type="text" name="username" autoComplete="username" value={session?.user.email ?? ""} readOnly hidden />
        <Field id={`${uid}-current`} label={forced ? "Temporary password" : "Current password"} error={errors.current} hint={caps ? "Caps Lock is on" : undefined}>
          <PasswordInput
            id={`${uid}-current`}
            value={current}
            onChange={(v) => {
              setCurrent(v);
              if (errors.current) setErrors((x) => ({ ...x, current: undefined }));
            }}
            autoComplete="current-password"
            invalid={Boolean(errors.current)}
            disabled={!session || submitting || done}
            autoFocus
            onCapsLock={setCaps}
            describedBy={`${uid}-current-msg`}
          />
        </Field>
        <Field id={`${uid}-new`} label="New password" error={errors.next}>
          <PasswordInput
            id={`${uid}-new`}
            value={nextPw}
            onChange={(v) => {
              setNextPw(v);
              if (errors.next) setErrors((x) => ({ ...x, next: undefined }));
            }}
            autoComplete="new-password"
            invalid={Boolean(errors.next)}
            disabled={!session || submitting || done}
            onCapsLock={setCaps}
            describedBy={`${uid}-new-msg ${uid}-strength`}
          />
        </Field>

        <div id={`${uid}-strength`} className="-mt-1 mb-3 space-y-2.5">
          <div className="flex items-center gap-3">
            <div className="grid flex-1 grid-cols-4 gap-1" aria-hidden>
              {[1, 2, 3, 4].map((i) => (
                <span key={i} className={cn("h-1 rounded-full transition-colors duration-200", i <= strength ? STRENGTH[strength].bar : "bg-neutral-200")} />
              ))}
            </div>
            <span className={cn("w-12 text-right text-xs font-medium", STRENGTH[strength].text)}>{nextPw ? STRENGTH[strength].label : ""}</span>
          </div>
          <ul className="space-y-1 text-xs text-neutral-500">
            {checks.map((c) => (
              <li key={c.text} className={cn("flex items-center gap-1.5 transition-colors", c.ok && "text-emerald-700")}>
                <Check className={cn("size-3.5", c.ok ? "opacity-100" : "opacity-30")} aria-hidden />
                {c.text}
                <span className="sr-only">{c.ok ? "(met)" : "(not met)"}</span>
              </li>
            ))}
          </ul>
        </div>

        <Field id={`${uid}-confirm`} label="Confirm new password" error={errors.confirm}>
          <PasswordInput
            id={`${uid}-confirm`}
            value={confirm}
            onChange={(v) => {
              setConfirm(v);
              if (errors.confirm) setErrors((x) => ({ ...x, confirm: undefined }));
            }}
            autoComplete="new-password"
            invalid={Boolean(errors.confirm)}
            disabled={!session || submitting || done}
            describedBy={`${uid}-confirm-msg`}
          />
        </Field>

        <button
          type="submit"
          disabled={!session || submitting || done}
          className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[linear-gradient(180deg,var(--color-brand-500),var(--color-brand-600))] text-[15px] font-semibold text-white shadow-[0_1px_2px_rgb(58_18_6/0.25),inset_0_1px_0_rgb(255_255_255/0.18)] outline-none transition-opacity hover:bg-[linear-gradient(180deg,var(--color-brand-600),var(--color-brand-700))] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting || done ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {done ? "Updated" : submitting ? "Updating…" : forced ? "Set password & continue" : "Update password"}
        </button>
        <p className="pt-1 text-center text-xs text-neutral-400">
          {MIN_PASSWORD}–{MAX_PASSWORD} characters. Passphrases work well.
        </p>
      </form>

      <div className="mt-8 flex items-center justify-between border-t border-line pt-5 text-[13px]">
        {forced ? (
          <span className="text-neutral-500">Not you?</span>
        ) : (
          <a href={dest} className="font-medium text-neutral-600 hover:text-neutral-900">
            ← Back to workspace
          </a>
        )}
        <button type="button" onClick={() => void signOut()} className="inline-flex items-center gap-1.5 font-medium text-neutral-600 hover:text-neutral-900">
          <LogOut className="size-3.5" aria-hidden />
          Sign out
        </button>
      </div>
    </AuthFrame>
  );
}
