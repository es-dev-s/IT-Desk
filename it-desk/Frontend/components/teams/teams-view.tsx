"use client";

import { ArrowUpRight, Building2, RefreshCw, UserPlus, UserRoundX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Team } from "@/lib/schemas";
import { ROLE_LABEL } from "@/lib/session";
import { cn, pluralize } from "@/lib/utils";
import { useTeams } from "@/store/selectors";
import { useWorkspace } from "@/store/workspace-provider";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { CredentialDialog, type Credential } from "@/components/users/credential-dialog";
import { UserDialog, type UserDialogResult, type UserPrefill } from "@/components/users/user-dialog";
import { TeamBadge } from "./team-badge";

type LeadFilter = "all" | "no_lead" | "has_lead";

/** Admin: every team in the organisation, who leads it, and how full it is. */
export function TeamsView() {
  const router = useRouter();
  const teams = useTeams();
  const refresh = useWorkspace((s) => s.refresh);
  const selectTeam = useWorkspace((s) => s.selectTeam);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LeadFilter>("all");
  const [prefill, setPrefill] = useState<UserPrefill | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [reloading, setReloading] = useState(false);

  const reload = async () => {
    setReloading(true);
    try {
      await refresh();
    } finally {
      setReloading(false);
    }
  };

  // Counts and leads change as accounts are made elsewhere; pull a fresh copy on arrival.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stats = useMemo(() => {
    const led = teams.filter((t) => t.leads.length > 0).length;
    return {
      total: teams.length,
      led,
      unled: teams.length - led,
      people: teams.reduce((n, t) => n + t.memberCount, 0),
      occupied: teams.reduce((n, t) => n + t.seatsOccupied, 0),
      seats: teams.reduce((n, t) => n + t.seatsTotal, 0),
    };
  }, [teams]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return teams.filter(
      (t) =>
        (filter === "all" || (filter === "no_lead" ? t.leads.length === 0 : t.leads.length > 0)) &&
        (!q || `${t.name} ${t.code} ${t.location} ${t.leads.map((l) => l.name).join(" ")}`.toLowerCase().includes(q)),
    );
  }, [teams, query, filter]);

  const onDone = (r: UserDialogResult) => {
    setPrefill(null);
    if (r.kind === "created") {
      setCredential({ kind: "created", name: r.user.name, email: r.user.email, password: r.temporaryPassword });
      const team = teams.find((t) => t.id === r.user.teamId);
      toast.success(`${ROLE_LABEL[r.user.role]} account created`, { description: team ? `${r.user.name} now leads ${team.name}` : r.user.email });
    }
    void refresh();
  };

  const openTeam = (t: Team) => {
    void selectTeam(t.id);
    router.push(`/?teamId=${encodeURIComponent(t.id)}`);
  };

  const filterOptions: { value: LeadFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: stats.total },
    { value: "no_lead", label: "Needs a lead", count: stats.unled },
    { value: "has_lead", label: "Has a lead", count: stats.led },
  ];

  return (
    <>
      <h1 className="sr-only">Teams</h1>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Teams", value: stats.total, note: "Across the organisation" },
          { label: "With a lead", value: stats.led, note: `${pluralize(stats.unled, "team")} still need one` },
          { label: "Need a lead", value: stats.unled, note: "No team lead account yet", warn: stats.unled > 0 },
          { label: "Seats occupied", value: `${stats.occupied}/${stats.seats}`, note: `${pluralize(stats.people, "person", "people")} on rosters` },
        ].map((s) => (
          <div key={s.label} className={cn("rounded-card border px-4 py-3.5 shadow-card", s.warn ? "border-amber-200 bg-amber-50" : "border-line bg-white")}>
            <p className={cn("text-xs font-medium", s.warn ? "text-amber-800" : "text-neutral-500")}>{s.label}</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-[-0.03em] text-neutral-900" data-testid={s.label === "Teams" ? "teams-total" : undefined}>
              {s.value}
            </p>
            <p className="mt-0.5 truncate text-xs text-neutral-500">{s.note}</p>
          </div>
        ))}
      </div>

      <div role="group" aria-label="Team tools" className="mb-4 flex flex-wrap items-center gap-2">
        <SearchField size="md" className="min-w-[220px] flex-1 sm:max-w-80" value={query} onChange={setQuery} label="Search teams" placeholder="Team, code, lead or floor" />
        <Segmented size="md" className="max-w-full overflow-x-auto" label="Lead" value={filter} onChange={setFilter} options={filterOptions} />
        <div className="ml-auto flex items-center gap-2">
          <Button size="icon" variant="ghost" aria-label="Reload teams" onClick={() => void reload()} disabled={reloading}>
            <RefreshCw className={cn(reloading && "animate-spin")} aria-hidden />
          </Button>
          <Button variant="primary" onClick={() => setPrefill({ role: "team_lead" })} data-testid="teams-add-lead">
            <UserPlus aria-hidden />
            Add team lead
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden">
        {teams.length === 0 ? (
          <EmptyState icon={Building2} title="No teams yet" description="Teams come from the organisation catalogue. Run the seed to load them, then refresh." />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No teams match"
            description={filter === "no_lead" && !query ? "Every team has a lead. Nice." : "Try another search or filter."}
            action={
              query || filter !== "all" ? (
                <Button onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</Button>
              ) : undefined
            }
          />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-[13px]" data-testid="teams-table">
              <thead>
                <tr className="h-10 border-b border-line bg-subtle text-xs text-neutral-500 [&>th]:px-5 [&>th]:font-medium">
                  <th>Team</th>
                  <th>Lead</th>
                  <th className="w-[96px] text-right">People</th>
                  <th className="w-[180px]">Seats</th>
                  <th className="w-[210px]"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((t) => (
                  <TeamRow key={t.id} team={t} onAddLead={() => setPrefill({ role: "team_lead", teamId: t.id })} onOpen={() => openTeam(t)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-xs text-neutral-500">
        Each team has one lead. That lead signs in with a one-time password and sees only their team.
      </p>

      <UserDialog
        open={prefill !== null}
        onOpenChange={(open) => !open && setPrefill(null)}
        editing={null}
        prefill={prefill}
        teams={teams}
        onDone={onDone}
      />
      <CredentialDialog credential={credential} onClose={() => setCredential(null)} />
    </>
  );
}

function TeamRow({ team: t, onAddLead, onOpen }: { team: Team; onAddLead: () => void; onOpen: () => void }) {
  const pct = t.seatsTotal ? Math.round((t.seatsOccupied / t.seatsTotal) * 100) : 0;
  return (
    <tr className="h-16 transition-colors hover:bg-neutral-50/70 [&>td]:px-5" data-testid="team-row" data-team-id={t.id} data-team-name={t.name}>
      <td>
        <div className="flex min-w-0 items-center gap-3">
          <TeamBadge code={t.code} size="md" />
          <div className="min-w-0">
            <p className="truncate font-medium text-neutral-900">{t.name}</p>
            <p className="truncate text-xs text-neutral-500">{t.location}</p>
          </div>
        </div>
      </td>
      <td>
        {t.leads.length ? (
          <div className="flex min-w-0 items-center gap-2" data-testid="team-leads">
            <div className="flex -space-x-1.5">
              {t.leads.slice(0, 3).map((l) => (
                <Avatar key={l.id} name={l.name} size="xs" className="ring-2 ring-white" />
              ))}
            </div>
            <span className="min-w-0 truncate text-neutral-800">
              {t.leads.length <= 2 ? t.leads.map((l) => l.name).join(", ") : `${t.leads[0].name} +${t.leads.length - 1} more`}
            </span>
          </div>
        ) : (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-amber-50 px-2.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200" data-testid="team-no-lead">
            <UserRoundX className="size-3.5" aria-hidden />
            No lead yet
          </span>
        )}
      </td>
      <td className="tnum text-right text-neutral-700">{t.memberCount ? t.memberCount : <span className="text-neutral-400">0</span>}</td>
      <td>
        <div className="flex items-center gap-2.5" title={`${t.seatsOccupied} of ${t.seatsTotal} seats occupied`}>
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-neutral-100" aria-hidden>
            <div className={cn("h-full rounded-full", pct >= 90 ? "bg-amber-500" : "bg-accent")} style={{ width: `${pct}%` }} />
          </div>
          <span className="tnum text-neutral-700" data-testid="team-seats">
            {t.seatsOccupied}
            <span className="text-neutral-400">/{t.seatsTotal}</span>
          </span>
        </div>
      </td>
      <td>
        <div className="flex items-center justify-end gap-1">
          {t.leads.length === 0 ? (
            <Button size="sm" variant="secondary" onClick={onAddLead} data-testid="team-add-lead" aria-label={`Add team lead for ${t.name}`}>
              <UserPlus aria-hidden />
              Add team lead
            </Button>
          ) : null}
          <Button size="icon-sm" variant="ghost" onClick={onOpen} aria-label={`Open ${t.name} overview`} title="Open overview">
            <ArrowUpRight aria-hidden />
          </Button>
        </div>
      </td>
    </tr>
  );
}
