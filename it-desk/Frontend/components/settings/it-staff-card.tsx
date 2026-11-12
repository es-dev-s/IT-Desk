"use client";

import { Check, Loader2, PencilLine, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, adminApi } from "@/lib/api";
import type { ManagedUser } from "@/lib/schemas";
import { STAFF_LIMITS, itStaffApi, staffHue, type ITStaff } from "@/lib/it-staff";
import { cn } from "@/lib/utils";
import { useITStaff } from "@/store/it-staff-store";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { inputClass } from "@/components/ui/field";
import { SelectField } from "@/components/ui/select";

const NO_LOGIN = "__none__";

/**
 * Admin: the IT staff people can pick under "Assign to" when they request IT,
 * and the IT login (if any) each person signs in with to answer their chats.
 */
export function ITStaffCard() {
  const [list, setList] = useState<ITStaff[] | null>(null);
  const [itUsers, setItUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", title: "" });
  const [adding, setAdding] = useState({ name: "", title: "" });
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const reloadPicker = useITStaff((s) => s.load);

  const fetchList = async () => {
    try {
      setList(await itStaffApi.list({ all: true }));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t load the IT staff list.");
    }
  };
  useEffect(() => {
    let live = true;
    itStaffApi
      .list({ all: true })
      .then((l) => live && setList(l))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Couldn’t load the IT staff list."));
    adminApi
      .users()
      .then((u) => live && setItUsers(u.filter((x) => x.role === "it")))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const write = async (key: string, fn: () => Promise<ITStaff>, done: string) => {
    if (busy) return false;
    setBusy(key);
    setFieldErr({});
    try {
      await fn();
      toast.success(done);
      await fetchList();
      void reloadPicker({ force: true });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFieldErr(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [`${key}.${k}`, v])));
      toast.error("Couldn’t save", { description: err instanceof ApiError ? err.message : "Please try again." });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (adding.name.trim().length < STAFF_LIMITS.minName) return setFieldErr({ "add.name": "Enter a name" });
    const ok = await write("add", () => itStaffApi.create({ name: adding.name, title: adding.title }), `${adding.name.trim()} added`);
    if (ok) setAdding({ name: "", title: "" });
  };

  return (
    <Card data-testid="it-staff-card">
      <CardHeader
        title="IT staff"
        description="People requesters can pick under “Assign to”. Link someone’s IT login and they see the chats routed to them and reply as themselves."
      />
      {list && list.length ? (
        <div className="hidden items-center gap-3 border-t border-line bg-neutral-50/60 px-5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 sm:flex">
          <span className="w-7" />
          <span className="flex-1">Person</span>
          <span className="w-60">Login</span>
          <span className="w-[76px]" />
        </div>
      ) : null}
      <ul className="divide-y divide-line border-t border-line">
        {list === null ? (
          <li className="px-5 py-6 text-center text-[13px] text-neutral-500">{error ?? "Loading…"}</li>
        ) : (
          list.map((s) => {
            const isEditing = editing === s.id;
            return (
              <li key={s.id} className={cn("flex min-h-14 items-center gap-3 px-5 py-2.5", !s.active && "opacity-60")} data-testid="it-staff-row">
                <Avatar name={s.name} hue={staffHue(s.name)} size="sm" />
                {isEditing ? (
                  <form
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void write(s.id, () => itStaffApi.update(s.id, { name: draft.name, title: draft.title, expectedVersion: s.version }), "Saved").then(
                        (ok) => ok && setEditing(null),
                      );
                    }}
                  >
                    <input
                      aria-label="Name"
                      autoFocus
                      className={cn(inputClass, "h-8 min-w-40 flex-1")}
                      value={draft.name}
                      maxLength={STAFF_LIMITS.maxName}
                      aria-invalid={fieldErr[`${s.id}.name`] ? true : undefined}
                      title={fieldErr[`${s.id}.name`]}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    />
                    <input
                      aria-label="Title"
                      className={cn(inputClass, "h-8 min-w-40 flex-1")}
                      value={draft.title}
                      maxLength={STAFF_LIMITS.maxTitle}
                      placeholder="Title"
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    />
                    <Button type="submit" size="sm" variant="primary" disabled={Boolean(busy)} aria-label="Save">
                      {busy === s.id ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
                    </Button>
                    <Button size="sm" onClick={() => setEditing(null)} aria-label="Cancel editing">
                      <X aria-hidden />
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-neutral-900">{s.name}</span>
                      <span className="block truncate text-xs text-neutral-500">
                        {s.title || "IT"}
                        {s.open ? ` · ${s.open} open` : ""}
                        {!s.active ? " · Hidden from the picker" : ""}
                      </span>
                    </span>
                    <LoginControl
                      staff={s}
                      users={itUsers}
                      taken={new Set(list.flatMap((o) => (o.id !== s.id && o.login ? [o.login.userId] : [])))}
                      disabled={Boolean(busy)}
                      error={fieldErr[`${s.id}.userId`]}
                      onChange={(userId) =>
                        void write(
                          s.id,
                          () => itStaffApi.update(s.id, { userId, expectedVersion: s.version }),
                          userId ? `${s.name} can now sign in and reply` : `Login unlinked from ${s.name}`,
                        )
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${s.name}`}
                      onClick={() => {
                        setEditing(s.id);
                        setDraft({ name: s.name, title: s.title });
                      }}
                    >
                      <PencilLine aria-hidden />
                    </Button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={s.active}
                      aria-label={`${s.name} can be picked`}
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void write(s.id, () => itStaffApi.update(s.id, { active: !s.active, expectedVersion: s.version }), s.active ? `${s.name} hidden` : `${s.name} is back`)
                      }
                      className={cn(
                        "relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-60",
                        s.active ? "bg-accent" : "bg-neutral-200",
                      )}
                    >
                      <span className={cn("absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-xs transition-transform duration-200 ease-out", s.active && "translate-x-4")} />
                    </button>
                  </>
                )}
              </li>
            );
          })
        )}
      </ul>
      <form onSubmit={(e) => void add(e)} noValidate className="flex flex-wrap items-start gap-2 border-t border-line px-5 py-3">
        <div className="min-w-44 flex-1">
          <input
            aria-label="New person’s name"
            className={cn(inputClass, "h-8")}
            placeholder="Name"
            value={adding.name}
            maxLength={STAFF_LIMITS.maxName}
            aria-invalid={fieldErr["add.name"] ? true : undefined}
            onChange={(e) => {
              setAdding((a) => ({ ...a, name: e.target.value }));
              setFieldErr({});
            }}
          />
          {fieldErr["add.name"] ? <p className="mt-1 text-xs text-red-600" role="alert">{fieldErr["add.name"]}</p> : null}
        </div>
        <input
          aria-label="New person’s title"
          className={cn(inputClass, "h-8 min-w-44 flex-1")}
          placeholder="Title, e.g. Associate IT"
          value={adding.title}
          maxLength={STAFF_LIMITS.maxTitle}
          onChange={(e) => setAdding((a) => ({ ...a, title: e.target.value }))}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={Boolean(busy)}>
          {busy === "add" ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          Add
        </Button>
      </form>
    </Card>
  );
}

/** Which IT account this person signs in with ("No login" = directory only). */
function LoginControl({
  staff,
  users,
  taken,
  disabled,
  error,
  onChange,
}: {
  staff: ITStaff;
  users: ManagedUser[];
  taken: Set<string>;
  disabled: boolean;
  error?: string;
  onChange: (userId: string) => void;
}) {
  const current = staff.login?.userId ?? NO_LOGIN;
  const options = [
    { value: NO_LOGIN, label: "No login" },
    ...users.filter((u) => !taken.has(u.id) || u.id === current).map((u) => ({ value: u.id, label: u.email + (u.status === "disabled" ? " (disabled)" : "") })),
  ];
  // A linked account the users list didn't return (e.g. still loading).
  if (staff.login && !options.some((o) => o.value === staff.login!.userId)) options.push({ value: staff.login.userId, label: staff.login.email });
  return (
    <span className="hidden w-60 shrink-0 sm:block" data-testid="it-staff-login" title={error}>
      <span className={cn("block", disabled && "pointer-events-none opacity-60")}>
        <SelectField
          label={`Login for ${staff.name}`}
          value={current}
          options={options}
          className={cn("w-full", current === NO_LOGIN && "text-neutral-400 [&_span.font-medium]:font-normal", error && "border-red-400")}
          onValueChange={(v) => v !== current && onChange(v === NO_LOGIN ? "" : v)}
        />
      </span>
    </span>
  );
}
