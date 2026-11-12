"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import {
  Ban,
  CircleCheck,
  KeyRound,
  Lock,
  LogOut,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { onLive } from "@/lib/live-bus";
import { toast } from "sonner";
import { ApiError, adminApi } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { ManagedUser } from "@/lib/schemas";
import { ROLE_LABEL, type Role } from "@/lib/session";
import { cn, pluralize } from "@/lib/utils";
import { useTeams, useTeamsById } from "@/store/selectors";
import { useWorkspace } from "@/store/workspace-provider";
import { TeamBadge } from "@/components/teams/team-badge";
import { useSession } from "@/components/auth/session-provider";
import { RoleBadge } from "@/components/auth/role-badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { menuContentClass, menuItemClass, menuItemDangerClass, menuSeparatorClass } from "@/components/ui/menu";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { CredentialDialog, type Credential } from "./credential-dialog";
import { UserDialog, type UserDialogResult } from "./user-dialog";

type RoleFilter = "all" | Role;
type Confirm =
  | { kind: "delete" | "disable" | "revoke" | "reset"; user: ManagedUser }
  | null;

const CONFIRM_COPY: Record<NonNullable<Confirm>["kind"], { title: string; body: (u: ManagedUser) => string; cta: string; danger: boolean }> = {
  reset: {
    title: "Reset password?",
    body: (u) => `${u.name} will be signed out everywhere and must sign in with a new temporary password, then choose their own.`,
    cta: "Reset password",
    danger: false,
  },
  disable: {
    title: "Disable account?",
    body: (u) => `${u.name} is signed out immediately and can’t sign in until you enable the account again. Their history is kept.`,
    cta: "Disable",
    danger: true,
  },
  revoke: {
    title: "Sign out everywhere?",
    body: (u) => `Ends all ${pluralize(u.activeSessions, "active session")} for ${u.name}. They can sign in again right away.`,
    cta: "Sign out sessions",
    danger: false,
  },
  delete: {
    title: "Delete account?",
    body: (u) => `This permanently removes ${u.name}’s sign-in. Transfers they created keep their name. This can’t be undone; disabling is usually enough.`,
    cta: "Delete account",
    danger: true,
  },
};

function isLocked(u: ManagedUser, now: number) {
  return u.lockedUntil !== null && new Date(u.lockedUntil).getTime() > now;
}

export function UsersView() {
  const { session } = useSession();
  const teams = useTeams();
  const teamsById = useTeamsById();
  // Team lead summaries live in the workspace snapshot; refresh it after account changes.
  const refreshTeams = useWorkspace((s) => s.refresh);
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [role, setRole] = useState<RoleFilter>("all");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ open: boolean; editing: ManagedUser | null }>({ open: false, editing: null });
  const [credential, setCredential] = useState<Credential | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setReloading(true);
    try {
      const list = await adminApi.users();
      setUsers(list);
      setLoadError(null);
      setNow(Date.now());
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Couldn’t load accounts.";
      setLoadError(message);
      if (users !== null) toast.error("Couldn’t refresh accounts", { description: message });
    } finally {
      setReloading(false);
    }
  }, [users]);

  // Live: another admin (or this one in another tab) changed an account, or a
  // session came or went. Resync silently, coalescing bursts; a newer response wins.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seq = 0;
    const silent = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const mine = ++seq;
        adminApi.users().then(
          (list) => {
            if (mine !== seq) return;
            setUsers(list);
            setLoadError(null);
            setNow(Date.now());
          },
          () => {
            // Background resync: keep showing what we have.
          },
        );
      }, 250);
    };
    const offUser = onLive("user", silent);
    const offTeam = onLive("team", silent);
    return () => {
      offUser();
      offTeam();
      if (timer) clearTimeout(timer);
      seq++;
    };
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    adminApi.users(ctrl.signal).then(
      (list) => {
        setUsers(list);
        setNow(Date.now());
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setLoadError(err instanceof ApiError ? err.message : "Couldn’t load accounts.");
      },
    );
    return () => ctrl.abort();
  }, []);

  const counts = useMemo(() => {
    const c = { all: 0, admin: 0, team_lead: 0, it: 0, disabled: 0, locked: 0, pending: 0 };
    for (const u of users ?? []) {
      c.all++;
      c[u.role]++;
      if (u.status === "disabled") c.disabled++;
      if (isLocked(u, now)) c.locked++;
      if (u.mustChangePassword && u.status === "active") c.pending++;
    }
    return c;
  }, [users, now]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const order: Record<Role, number> = { admin: 0, team_lead: 1, it: 2 };
    return (users ?? [])
      .filter((u) => role === "all" || u.role === role)
      .filter((u) => !q || `${u.name} ${u.email} ${u.title} ${u.teamId ? (teamsById[u.teamId]?.name ?? "") : ""}`.toLowerCase().includes(q))
      .sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
  }, [users, role, query, teamsById]);

  const upsert = (u: ManagedUser) =>
    setUsers((list) => {
      if (!list) return [u];
      const i = list.findIndex((x) => x.id === u.id);
      if (i === -1) return [...list, u];
      const next = list.slice();
      next[i] = u;
      return next;
    });

  const onDialogDone = (r: UserDialogResult) => {
    upsert(r.user);
    void refreshTeams();
    setDialog({ open: false, editing: null });
    if (r.kind === "created") {
      setCredential({ kind: "created", name: r.user.name, email: r.user.email, password: r.temporaryPassword });
      toast.success(`${ROLE_LABEL[r.user.role]} account created`, { description: r.user.email });
    } else {
      toast.success("Account updated", { description: r.user.email });
    }
  };

  const fail = (err: unknown, fallback: string) => {
    if (err instanceof ApiError) {
      if (err.code === "stale_user" || err.status === 404) void load();
      toast.error(fallback, { description: err.message });
    } else toast.error(fallback);
  };

  const run = async (c: NonNullable<Confirm>) => {
    const u = c.user;
    setBusy((b) => ({ ...b, [u.id]: true }));
    setConfirm(null);
    try {
      switch (c.kind) {
        case "reset": {
          const res = await adminApi.resetPassword(u.id);
          upsert(res.user);
          setCredential({ kind: "reset", name: res.user.name, email: res.user.email, password: res.temporaryPassword });
          break;
        }
        case "disable":
          upsert(await adminApi.setEnabled(u.id, false));
          void refreshTeams();
          toast.success(`${u.name} disabled`, { description: "Signed out of every session." });
          break;
        case "revoke":
          upsert(await adminApi.revokeSessions(u.id));
          toast.success(`Signed ${u.name} out everywhere`);
          break;
        case "delete":
          await adminApi.deleteUser(u.id);
          setUsers((list) => list?.filter((x) => x.id !== u.id) ?? null);
          void refreshTeams();
          toast.success(`${u.name} deleted`);
          break;
      }
    } catch (err) {
      fail(err, `Couldn’t ${CONFIRM_COPY[c.kind].cta.toLowerCase()}`);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[u.id];
        return next;
      });
    }
  };

  const enable = async (u: ManagedUser) => {
    setBusy((b) => ({ ...b, [u.id]: true }));
    try {
      upsert(await adminApi.setEnabled(u.id, true));
      void refreshTeams();
      toast.success(`${u.name} enabled`);
    } catch (err) {
      fail(err, "Couldn’t enable");
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[u.id];
        return next;
      });
    }
  };

  const roleOptions: { value: RoleFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.all },
    { value: "team_lead", label: "Team leads", count: counts.team_lead },
    { value: "it", label: "IT", count: counts.it },
    { value: "admin", label: "Admins", count: counts.admin },
  ];

  return (
    <>
      <h1 className="sr-only">Users</h1>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Accounts", value: counts.all, note: `${counts.team_lead} leads · ${counts.it} IT · ${counts.admin} admin` },
          { label: "Awaiting first sign-in", value: counts.pending, note: "Still on a temporary password" },
          { label: "Locked out", value: counts.locked, note: "Too many failed attempts", warn: counts.locked > 0 },
          { label: "Disabled", value: counts.disabled, note: "Can’t sign in" },
        ].map((s) => (
          <div key={s.label} className={cn("rounded-card border px-4 py-3.5 shadow-card", s.warn ? "border-amber-200 bg-amber-50" : "border-line bg-white")}>
            <p className={cn("text-xs font-medium", s.warn ? "text-amber-800" : "text-neutral-500")}>{s.label}</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-[-0.03em] text-neutral-900">{users ? s.value : "–"}</p>
            <p className="mt-0.5 truncate text-xs text-neutral-500">{s.note}</p>
          </div>
        ))}
      </div>

      <div role="group" aria-label="User tools" className="mb-4 flex flex-wrap items-center gap-2">
        <SearchField size="md" className="min-w-[220px] flex-1 sm:max-w-80" value={query} onChange={setQuery} label="Search users" placeholder="Name, email or team" />
        <Segmented size="md" className="max-w-full overflow-x-auto" label="Role" value={role} onChange={setRole} options={roleOptions} />
        <div className="ml-auto flex items-center gap-2">
          <Button size="icon" variant="ghost" aria-label="Reload users" onClick={() => void load()} disabled={reloading}>
            <RefreshCw className={cn(reloading && "animate-spin")} aria-hidden />
          </Button>
          <Button variant="primary" onClick={() => setDialog({ open: true, editing: null })} data-testid="add-user">
            <UserPlus aria-hidden />
            Add user
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden">
        {users === null && !loadError ? (
          <div className="divide-y divide-line" aria-busy>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex h-16 items-center gap-3 px-5">
                <Skeleton className="size-8 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="ml-auto h-5 w-20 rounded-full" />
              </div>
            ))}
          </div>
        ) : loadError && users === null ? (
          <EmptyState
            icon={Users}
            title="Couldn’t load accounts"
            description={loadError}
            action={<Button onClick={() => void load()}>Try again</Button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title={query || role !== "all" ? "No accounts match" : "No accounts yet"} description={query || role !== "all" ? "Try another search or role." : "Add a team lead or IT account to get started."} />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-[13px]" data-testid="users-table">
              <thead>
                <tr className="h-10 border-b border-line bg-subtle text-xs text-neutral-500 [&>th]:px-5 [&>th]:font-medium">
                  <th>User</th>
                  <th className="w-[112px]">Role</th>
                  <th>Team</th>
                  <th className="w-[150px]">Status</th>
                  <th className="w-[140px]">Last sign-in</th>
                  <th className="w-[88px] text-right">Sessions</th>
                  <th className="w-[60px]"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((u) => {
                  const self = u.id === session.user.id;
                  const locked = isLocked(u, now);
                  const team = u.teamId ? teamsById[u.teamId] : undefined;
                  return (
                    <tr key={u.id} className={cn("h-16 transition-colors hover:bg-neutral-50/70 [&>td]:px-5", u.status === "disabled" && "[&>td:not(:last-child)]:opacity-55")} data-testid="user-row" data-email={u.email}>
                      <td>
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar name={u.name} size="sm" />
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 truncate font-medium text-neutral-900">
                              {u.name}
                              {self ? <span className="rounded bg-neutral-100 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">You</span> : null}
                            </p>
                            <p className="truncate text-xs text-neutral-500">
                              {u.email}
                              {u.title ? ` · ${u.title}` : ""}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td><RoleBadge role={u.role} /></td>
                      <td className="text-neutral-700">
                        {team ? (
                          <span className="inline-flex min-w-0 items-center gap-2">
                            <TeamBadge code={team.code} size="xs" />
                            <span className="truncate">{team.name}</span>
                          </span>
                        ) : (
                          <span className="text-neutral-400">{u.role === "it" ? "All teams (IT)" : u.role === "admin" ? "Organization" : "—"}</span>
                        )}
                      </td>
                      <td>
                        {u.status === "disabled" ? (
                          <StatusPill tone="neutral" icon={Ban}>Disabled</StatusPill>
                        ) : locked ? (
                          <StatusPill tone="amber" icon={Lock} title={`Locked until ${formatDateTime(u.lockedUntil!)}`}>Locked</StatusPill>
                        ) : u.mustChangePassword ? (
                          <StatusPill tone="sky" icon={KeyRound}>Temp password</StatusPill>
                        ) : (
                          <StatusPill tone="green" icon={CircleCheck}>Active</StatusPill>
                        )}
                      </td>
                      <td className="tnum text-neutral-600" title={u.lastLoginAt ? formatDateTime(u.lastLoginAt) : undefined}>
                        {u.lastLoginAt ? formatRelative(u.lastLoginAt) : <span className="text-neutral-400">Never</span>}
                      </td>
                      <td className="tnum text-right text-neutral-700">{u.activeSessions}</td>
                      <td className="text-right">
                        <RowMenu
                          user={u}
                          self={self}
                          busy={Boolean(busy[u.id])}
                          onEdit={() => setDialog({ open: true, editing: u })}
                          onEnable={() => void enable(u)}
                          onConfirm={(kind) => setConfirm({ kind, user: u })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-xs text-neutral-500">
        There’s no self sign-up. Only admins create accounts; new users get a one-time password and must set their own at first sign-in.
      </p>

      <UserDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        editing={dialog.editing}
        teams={teams}
        onDone={onDialogDone}
      />
      <CredentialDialog credential={credential} onClose={() => setCredential(null)} />
      <Modal
        open={confirm !== null}
        onOpenChange={(open) => (open ? null : setConfirm(null))}
        title={confirm ? CONFIRM_COPY[confirm.kind].title : ""}
        description={confirm ? CONFIRM_COPY[confirm.kind].body(confirm.user) : undefined}
      >
        <ModalBody className="py-2">
          {confirm ? (
            <div className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
              <Avatar name={confirm.user.name} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-neutral-900">{confirm.user.name}</p>
                <p className="truncate text-xs text-neutral-500">{confirm.user.email}</p>
              </div>
              <RoleBadge role={confirm.user.role} className="ml-auto" />
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          {confirm ? (
            <Button variant={CONFIRM_COPY[confirm.kind].danger ? "danger" : "dark"} onClick={() => void run(confirm)} data-testid="confirm-action">
              {CONFIRM_COPY[confirm.kind].cta}
            </Button>
          ) : null}
        </ModalFooter>
      </Modal>
    </>
  );
}

const PILL = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  sky: "bg-sky-50 text-sky-800 ring-sky-600/15",
  neutral: "bg-neutral-100 text-neutral-600 ring-neutral-500/15",
} as const;

function StatusPill({ tone, icon: Icon, title, children }: { tone: keyof typeof PILL; icon: React.ComponentType<{ className?: string }>; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium ring-1 ring-inset", PILL[tone])}>
      <Icon className="size-3.5" />
      {children}
    </span>
  );
}

function RowMenu({
  user,
  self,
  busy,
  onEdit,
  onEnable,
  onConfirm,
}: {
  user: ManagedUser;
  self: boolean;
  busy: boolean;
  onEdit: () => void;
  onEnable: () => void;
  onConfirm: (kind: NonNullable<Confirm>["kind"]) => void;
}) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${user.name}`} disabled={busy} data-testid="user-actions">
          {busy ? <RefreshCw className="animate-spin" aria-hidden /> : <MoreHorizontal aria-hidden />}
        </Button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={6} className={menuContentClass}>
          <DM.Item className={menuItemClass} onSelect={onEdit}>
            <Pencil aria-hidden />
            Edit details
          </DM.Item>
          <DM.Item className={menuItemClass} onSelect={() => onConfirm("reset")}>
            <KeyRound aria-hidden />
            Reset password
          </DM.Item>
          <DM.Item className={menuItemClass} disabled={user.activeSessions === 0} onSelect={() => onConfirm("revoke")}>
            <LogOut aria-hidden />
            Sign out everywhere
          </DM.Item>
          <DM.Separator className={menuSeparatorClass} />
          {user.status === "disabled" ? (
            <DM.Item className={menuItemClass} onSelect={onEnable}>
              <CircleCheck aria-hidden />
              Enable account
            </DM.Item>
          ) : (
            <DM.Item className={cn(menuItemClass, menuItemDangerClass)} disabled={self} onSelect={() => onConfirm("disable")}>
              <Ban aria-hidden />
              {self ? "Disable (not yourself)" : "Disable account"}
            </DM.Item>
          )}
          <DM.Item className={cn(menuItemClass, menuItemDangerClass)} disabled={self} onSelect={() => onConfirm("delete")}>
            <Trash2 aria-hidden />
            Delete account
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
