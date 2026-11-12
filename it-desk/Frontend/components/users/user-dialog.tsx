"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { ApiError, adminApi, type UserInput } from "@/lib/api";
import type { ManagedUser, Team } from "@/lib/schemas";
import { ROLE_LABEL, type Role } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { TeamCombobox } from "@/components/teams/team-combobox";

const ROLE_HELP: Record<Role, string> = {
  team_lead: "Runs one team: members, floor plan, transfers and exits.",
  it: "Works the IT queue and moves devices for every team.",
  admin: "Manages accounts, adds and edits members on any team, sees everything.",
};
const ROLE_ORDER: Role[] = ["team_lead", "it", "admin"];

export const userFormSchema = z
  .object({
    name: z.string().trim().min(2, "Enter a full name (2–80 characters)").max(80, "Enter a full name (2–80 characters)"),
    email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid work email")).pipe(z.string().max(254)),
    title: z.string().trim().max(80, "Keep the title under 80 characters"),
    role: z.enum(["admin", "team_lead", "it"]),
    teamId: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.role === "team_lead" && !v.teamId) ctx.addIssue({ code: "custom", path: ["teamId"], message: "Choose the team this lead manages" });
  });

type Errors = Partial<Record<"name" | "email" | "title" | "role" | "teamId" | "form", string>>;

export type UserDialogResult =
  | { kind: "created"; user: ManagedUser; temporaryPassword: string }
  | { kind: "updated"; user: ManagedUser };

/** Starting values for a new account, e.g. "Add team lead" from the Teams view. */
export type UserPrefill = { role?: Role; teamId?: string };

export function UserDialog({
  open,
  onOpenChange,
  editing,
  teams,
  onDone,
  prefill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ManagedUser | null;
  teams: Team[];
  onDone: (result: UserDialogResult) => void;
  prefill?: UserPrefill | null;
}) {
  const prefillTeam = !editing && prefill?.teamId ? teams.find((t) => t.id === prefill.teamId) : undefined;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${editing.name}` : prefillTeam && prefill?.role === "team_lead" ? `Add a lead for ${prefillTeam.name}` : "Add a user"}
      description={editing ? "Changes apply at their next request. Role changes take effect immediately." : "They’ll get a temporary password and set their own on first sign-in."}
      className="max-w-[500px]"
    >
      {/* Keyed so each open starts from fresh state. */}
      {open ? (
        <UserForm
          key={editing?.id ?? `new-${prefill?.role ?? ""}-${prefill?.teamId ?? ""}`}
          editing={editing}
          prefill={editing ? null : (prefill ?? null)}
          teams={teams}
          onDone={onDone}
          onCancel={() => onOpenChange(false)}
        />
      ) : null}
    </Modal>
  );
}

function UserForm({
  editing,
  prefill,
  teams,
  onDone,
  onCancel,
}: {
  editing: ManagedUser | null;
  prefill: UserPrefill | null;
  teams: Team[];
  onDone: (result: UserDialogResult) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [role, setRole] = useState<Role>(editing?.role ?? prefill?.role ?? "team_lead");
  const [teamId, setTeamId] = useState(editing?.teamId ?? prefill?.teamId ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);

  const clear = (k: keyof Errors) => setErrors((e) => (e[k] || e.form ? { ...e, [k]: undefined, form: undefined } : e));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const parsed = userFormSchema.safeParse({ name, email, title, role, teamId });
    if (!parsed.success) {
      const errs: Errors = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0]) as keyof Errors;
        errs[k] ??= issue.message;
      }
      setErrors(errs);
      return;
    }
    if (parsed.data.role === "team_lead") {
      const taken = teams.find((t) => t.id === parsed.data.teamId)?.leads.some((l) => l.id !== editing?.id);
      if (taken) {
        setErrors({ teamId: "This team already has a Team Lead assigned." });
        return;
      }
    }
    const body: UserInput = { ...parsed.data, teamId: parsed.data.role === "team_lead" ? parsed.data.teamId : undefined };
    setSaving(true);
    setErrors({});
    try {
      if (editing) {
        const user = await adminApi.updateUser(editing.id, { ...body, expectedVersion: editing.version });
        onDone({ kind: "updated", user });
      } else {
        const res = await adminApi.createUser(body);
        onDone({ kind: "created", user: res.user, temporaryPassword: res.temporaryPassword });
      }
    } catch (err) {
      setSaving(false);
      if (err instanceof ApiError) {
        if (err.fields && Object.keys(err.fields).length) {
          setErrors({ ...(err.fields as Errors), form: undefined });
          return;
        }
        if (err.isUnavailable && !editing) {
          setErrors({ form: "The server didn’t answer. Check the user list before trying again, in case the account was created." });
          return;
        }
        setErrors({ form: err.message });
        return;
      }
      setErrors({ form: "Something went wrong. Please try again." });
    }
  };

  const selectedTeam = teams.find((t) => t.id === teamId);
  const otherLeads = selectedTeam ? selectedTeam.leads.filter((l) => l.id !== editing?.id) : [];
  const teamHint = !selectedTeam
    ? "Pick from every team — type to search by name or code."
    : otherLeads.length
      ? "This team already has a Team Lead assigned."
      : "This team has no lead yet.";

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex min-h-0 flex-1 flex-col">
      <ModalBody className="space-y-1">
        <fieldset className="mb-4">
          <legend className="text-[13px] font-medium text-neutral-800">Role</legend>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Role">
            {ROLE_ORDER.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={role === r}
                onClick={() => {
                  setRole(r);
                  clear("role");
                  clear("teamId");
                }}
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/35",
                  role === r ? "border-accent bg-accent-soft ring-1 ring-accent" : "border-line-strong bg-white hover:bg-neutral-50",
                )}
              >
                <span className={cn("block text-[13px] font-semibold", role === r ? "text-accent-ink" : "text-neutral-900")}>{ROLE_LABEL[r]}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 min-h-4 text-xs text-neutral-500">{errors.role ?? ROLE_HELP[role]}</p>
        </fieldset>

        <Field id="u-name" label="Full name" error={errors.name}>
          <input id="u-name" value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} autoComplete="off" maxLength={80} aria-invalid={Boolean(errors.name) || undefined} className={inputClass} autoFocus />
        </Field>
        <Field id="u-email" label="Work email" error={errors.email} hint={editing ? "Changing it changes their sign-in." : "This is their sign-in."}>
          <input id="u-email" type="email" inputMode="email" value={email} onChange={(e) => { setEmail(e.target.value); clear("email"); }} autoComplete="off" spellCheck={false} maxLength={254} aria-invalid={Boolean(errors.email) || undefined} className={inputClass} />
        </Field>
        <Field id="u-title" label="Job title" optional error={errors.title}>
          <input id="u-title" value={title} onChange={(e) => { setTitle(e.target.value); clear("title"); }} autoComplete="off" maxLength={80} aria-invalid={Boolean(errors.title) || undefined} className={inputClass} />
        </Field>
        {role === "team_lead" ? (
          <Field id="u-team" label="Team" error={errors.teamId} hint={teamHint}>
            <TeamCombobox
              id="u-team"
              label="Team"
              value={teamId}
              onChange={(v) => { setTeamId(v); clear("teamId"); }}
              teams={teams}
              invalid={Boolean(errors.teamId)}
              showLeads
              placeholder="Choose a team"
              testId="user-team"
            />
          </Field>
        ) : null}

        {errors.form ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800">
            {errors.form}
          </p>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving} data-testid="user-save">
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {editing ? "Save changes" : "Create account"}
        </Button>
      </ModalFooter>
    </form>
  );
}
