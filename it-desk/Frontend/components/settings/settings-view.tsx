"use client";

import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { toFieldErrors, type FieldErrors } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { BellRing, KeyRound, Volume2 } from "lucide-react";
import { playChime } from "@/lib/chime";
import { ConnectionIndicator } from "@/components/realtime/notification-bell";
import { formatDateTime } from "@/lib/format";
import { useCurrentTeam, useUser } from "@/store/selectors";
import { useSession } from "@/components/auth/session-provider";
import { RoleBadge } from "@/components/auth/role-badge";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";
import { Button, buttonClass } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, inputClass } from "@/components/ui/field";
import { ITStaffCard } from "./it-staff-card";

const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(80, "Keep it under 80 characters"),
  title: z.string().trim().max(80, "Keep it under 80 characters"),
});

/** Labels only; on/off state is stored per user in PostgreSQL. */
const NOTIFY = [
  { id: "scheduled", label: "IT schedules a device move" },
  { id: "moved", label: "Devices arrive at the new desk" },
  { id: "incoming", label: "Someone is transferred into the team" },
  { id: "digest", label: "Weekly summary email" },
];

export function SettingsView() {
  const user = useUser();
  const team = useCurrentTeam();
  const { session, refresh } = useSession();
  const [form, setForm] = useState({ name: user.name, title: user.title });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const api = useWorkspaceApi();
  const notify = useWorkspace((s) => s.notifications);
  const dirty = form.name !== user.name || form.title !== user.title;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = profileSchema.safeParse(form);
    if (!parsed.success) return setErrors(toFieldErrors(parsed.error));
    setErrors({});
    setSaving(true);
    // The sign-in email is managed by an admin; it is sent back unchanged.
    const result = await api.getState().updateProfile({ ...parsed.data, email: user.email });
    setSaving(false);
    if (result.ok) {
      void refresh();
      toast.success("Profile saved");
      return;
    }
    if (result.fields) setErrors(result.fields);
    toast.error("Couldn’t save your profile", { description: result.error });
  };

  const toggle = async (id: string) => {
    const result = await api.getState().setNotification(id, !notify[id]);
    if (!result.ok) toast.error("Couldn’t update notifications", { description: result.error });
  };

  return (
    <div className="max-w-3xl">
      <h1 className="sr-only">Settings</h1>
      <div className="space-y-6">
        <Card>
          <CardHeader title="Profile" />
          <form onSubmit={(e) => void save(e)} noValidate className="border-t border-line">
            <div className="grid gap-x-4 px-5 pt-5 sm:grid-cols-2">
              {(["name", "title"] as const).map((k) => (
                <Field key={k} id={`p-${k}`} label={k === "name" ? "Full name" : "Title"} error={errors[k]} optional={k === "title"}>
                  <input
                    id={`p-${k}`}
                    value={form[k]}
                    onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                    aria-invalid={Boolean(errors[k])}
                    className={inputClass}
                  />
                </Field>
              ))}
              <Field id="p-email" label="Sign-in email" hint="Ask an admin to change your sign-in email" error={errors.email}>
                <input id="p-email" value={user.email} readOnly className={cn(inputClass, "bg-subtle text-neutral-500")} />
              </Field>
              {user.role === "team_lead" && team ? (
                <Field id="p-team" label="Team" hint={team.location}>
                  <input id="p-team" value={team.name} readOnly className={cn(inputClass, "bg-subtle text-neutral-500")} />
                </Field>
              ) : (
                <Field id="p-scope" label="Access" hint={user.role === "admin" ? "Every team, plus user management" : "Device moves for every team"}>
                  <input id="p-scope" value={user.role === "admin" ? "Organization-wide" : "IT operations"} readOnly className={cn(inputClass, "bg-subtle text-neutral-500")} />
                </Field>
              )}
            </div>
            <div className="flex justify-end border-t border-line px-5 py-3">
              <Button type="submit" variant="dark" size="sm" disabled={saving || !dirty} aria-busy={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </Card>
        <Card>
          <CardHeader
            title="Security"
            description="Your role and password"
            action={<RoleBadge role={session.user.role} />}
          />
          <div className="flex flex-col gap-4 border-t border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-[13px]">
              <p className="font-medium text-neutral-900">Password</p>
              <p className="tnum mt-0.5 text-neutral-500">
                This session ends {formatDateTime(session.expiresAt)}, or after {Math.round(session.idleTimeoutSeconds / 60)} minutes of inactivity.
              </p>
            </div>
            <Link href="/change-password" className={buttonClass("secondary", "sm")}>
              <KeyRound aria-hidden />
              Change password
            </Link>
          </div>
        </Card>
        {session.user.role === "admin" ? <ITStaffCard /> : null}
        <Card>
          <CardHeader title="Live alerts" description="In-app, the moment something happens" action={<ConnectionIndicator />} />
          <ul className="divide-y divide-line border-t border-line">
            <li className="flex min-h-14 items-center justify-between gap-4 px-5 py-3">
              <span className="flex min-w-0 items-start gap-3">
                <BellRing className="mt-0.5 size-4 shrink-0 text-neutral-400" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[13px] text-neutral-800">Bell, toasts and unread count in the tab title</span>
                  <span className="block text-xs text-neutral-500">
                    {session.user.role === "it" ? "Every new transfer and IT request, plus replies from requesters." : "When IT sees your transfer or request, and every update after that."}
                  </span>
                </span>
              </span>
              <span className="shrink-0 text-xs font-medium text-neutral-500">Always on</span>
            </li>
            <li className="flex min-h-14 items-center justify-between gap-4 px-5 py-3">
              <span className="flex min-w-0 items-start gap-3">
                <Volume2 className="mt-0.5 size-4 shrink-0 text-neutral-400" aria-hidden />
                <span className="min-w-0">
                  <span id="n-liveSound" className="block text-[13px] text-neutral-800">Play a sound for new alerts</span>
                  <span className="block text-xs text-neutral-500">A soft chime, once per alert even with several tabs open.</span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={() => playChime()} className="text-xs font-medium text-accent-ink hover:underline">
                  Test
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(notify.liveSound)}
                  aria-labelledby="n-liveSound"
                  onClick={() => void toggle("liveSound")}
                  data-testid="live-sound"
                  className={cn(
                    "relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent/35",
                    notify.liveSound ? "bg-accent" : "bg-neutral-200",
                  )}
                >
                  <span className={cn("absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-xs transition-transform duration-200 ease-out", notify.liveSound && "translate-x-4")} />
                </button>
              </span>
            </li>
          </ul>
        </Card>
        <Card>
          <CardHeader title="Notifications" description="Sent to your work email" />
          <ul className="divide-y divide-line border-t border-line">
            {NOTIFY.map((n) => (
              <li key={n.id} className="flex h-14 items-center justify-between gap-4 px-5">
                <span id={`n-${n.id}`} className="text-[13px] text-neutral-800">{n.label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(notify[n.id])}
                  aria-labelledby={`n-${n.id}`}
                  onClick={() => void toggle(n.id)}
                  className={cn(
                    "relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent/35",
                    notify[n.id] ? "bg-accent" : "bg-neutral-200",
                  )}
                >
                  <span className={cn("absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-xs transition-transform duration-200 ease-out", notify[n.id] && "translate-x-4")} />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
