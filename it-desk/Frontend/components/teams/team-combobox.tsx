"use client";

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronsUpDown, Search, UserRoundX } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type { Team } from "@/lib/schemas";
import { cn, pluralize } from "@/lib/utils";
import { inputClass } from "@/components/ui/field";
import { TeamBadge } from "./team-badge";

/** A non-team choice listed above the teams, e.g. "All teams" or "Organisation-wide". */
export type TeamExtraOption = { value: string; label: string; hint?: string };

export function leadSummary(team: Team): string {
  const names = team.leads.length ? team.leads.map((l) => l.name) : team.leadName ? [team.leadName] : [];
  if (names.length === 0) return "";
  return names.length <= 2 ? names.join(" & ") : `${names[0]} +${names.length - 1}`;
}

/**
 * Searchable team picker: type to filter by name, code or lead; arrow keys and
 * Enter to choose. Scales to any number of teams (the org has 24).
 *
 * - variant="field": full-width form control (user dialog, request dialog)
 * - variant="toolbar": compact trigger for filters and the team switcher
 */
export function TeamCombobox({
  teams,
  value,
  onChange,
  label,
  placeholder = "Choose a team",
  extras = [],
  variant = "field",
  size = "md",
  invalid,
  id,
  className,
  showLeads = false,
  meta,
  prefix,
  testId = "team-combobox",
  disabled,
}: {
  teams: Team[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  extras?: TeamExtraOption[];
  variant?: "field" | "toolbar";
  size?: "sm" | "md";
  invalid?: boolean;
  id?: string;
  className?: string;
  /** Show each team's lead (or a "no lead yet" hint) and head-count. */
  showLeads?: boolean;
  /** Extra right-aligned detail per team (e.g. free seats). */
  meta?: (team: Team) => React.ReactNode;
  prefix?: string;
  testId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId().replace(/:/g, "");
  const listId = `${uid}-list`;

  const q = query.trim().toLowerCase();
  type Row = { kind: "extra"; option: TeamExtraOption } | { kind: "team"; team: Team };
  const rows = useMemo<Row[]>(() => {
    const ex = extras.filter((o) => !q || o.label.toLowerCase().includes(q)).map((option) => ({ kind: "extra" as const, option }));
    const ts = teams
      .filter((t) => !q || `${t.name} ${t.code} ${t.leads.map((l) => l.name).join(" ")}`.toLowerCase().includes(q))
      .map((team) => ({ kind: "team" as const, team }));
    return [...ex, ...ts];
  }, [extras, teams, q]);
  const current = Math.min(active, Math.max(rows.length - 1, 0));

  const selectedTeam = teams.find((t) => t.id === value) ?? null;
  const selectedExtra = selectedTeam ? null : (extras.find((o) => o.value === value) ?? null);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
    setActive(0);
  };
  const rowValue = (r: Row) => (r.kind === "team" ? r.team.id : r.option.value);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      const i = rows.findIndex((r) => rowValue(r) === value);
      setActive(i === -1 ? 0 : i);
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-index="${Math.max(i, 0)}"]`)?.scrollIntoView({ block: "nearest" }));
    } else {
      setQuery("");
    }
  };

  const triggerClass =
    variant === "field"
      ? cn(inputClass, "relative flex items-center gap-2 pr-9 text-left")
      : cn(
          size === "md" ? "h-9" : "h-8",
          "relative inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-line-strong bg-white pl-2 pr-8 text-left text-[13px] text-neutral-800 shadow-xs outline-none transition-colors duration-150 hover:bg-neutral-50",
          "focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/15",
        );

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        id={id}
        role="combobox"
        aria-label={label}
        aria-controls={open ? listId : undefined}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className={cn(triggerClass, invalid && "border-red-400", "disabled:cursor-not-allowed disabled:opacity-60", className)}
        data-testid={testId}
        data-value={value}
      >
        {prefix ? <span className="shrink-0 text-neutral-500">{prefix}</span> : null}
        {selectedTeam ? (
          <>
            <TeamBadge code={selectedTeam.code} size={variant === "field" ? "sm" : "xs"} />
            <span className="min-w-0 truncate font-medium text-neutral-900">{selectedTeam.name}</span>
          </>
        ) : selectedExtra ? (
          <span className={cn("min-w-0 truncate font-medium", variant === "toolbar" && "pl-1")}>{selectedExtra.label}</span>
        ) : (
          <span className={cn("min-w-0 truncate text-neutral-400", variant === "toolbar" && "pl-1")}>{placeholder}</span>
        )}
        <ChevronsUpDown className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "z-[70] w-[var(--radix-popover-trigger-width)] rounded-xl bg-white p-1 shadow-pop outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in",
            showLeads ? "min-w-[320px]" : "min-w-[260px]",
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" aria-hidden />
            <input
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-activedescendant={rows[current] ? `${uid}-opt-${current}` : undefined}
              className="h-9 w-full rounded-lg bg-transparent pl-8 pr-14 text-sm outline-none placeholder:text-neutral-400"
              placeholder="Search teams, codes or leads"
              value={query}
              data-testid={`${testId}-search`}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                listRef.current?.scrollTo({ top: 0 });
              }}
              onKeyDown={(e) => {
                const n = rows.length;
                const move = (next: number) => {
                  setActive(next);
                  listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
                };
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (n) move((current + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
                } else if (e.key === "Home" || e.key === "End") {
                  if (!n) return;
                  e.preventDefault();
                  move(e.key === "Home" ? 0 : n - 1);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (rows[current]) choose(rowValue(rows[current]));
                }
              }}
            />
            <span className="tnum pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400">
              {q ? `${rows.filter((r) => r.kind === "team").length}/${teams.length}` : pluralize(teams.length, "team")}
            </span>
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="scrollbar-thin mt-1 max-h-72 overflow-y-auto border-t border-line pt-1">
            {rows.length === 0 ? (
              <li className="px-3 py-6 text-center text-[13px] text-neutral-500">
                {teams.length ? <>No team matches “{query.trim()}”</> : "No teams yet"}
              </li>
            ) : (
              rows.map((r, i) => {
                const v = rowValue(r);
                const selected = v === value;
                const isFirstTeam = r.kind === "team" && i > 0 && rows[i - 1].kind === "extra";
                return (
                  <li
                    key={`${r.kind}-${v}`}
                    id={`${uid}-opt-${i}`}
                    role="option"
                    aria-selected={selected}
                    data-index={i}
                    data-value={v}
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(v)}
                    className={cn(
                      "flex cursor-default items-center gap-2.5 rounded-md px-2 text-[13px]",
                      r.kind === "team" && showLeads ? "min-h-11 py-1.5" : "h-9",
                      i === current && "bg-neutral-900/[0.05]",
                      isFirstTeam && "mt-1 border-t border-line pt-1",
                    )}
                    data-testid={`${testId}-option`}
                  >
                    {r.kind === "extra" ? (
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-neutral-800">{r.option.label}</span>
                        {r.option.hint ? <span className="block truncate text-xs text-neutral-500">{r.option.hint}</span> : null}
                      </span>
                    ) : (
                      <>
                        <TeamBadge code={r.team.code} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-neutral-900">{r.team.name}</span>
                          {showLeads ? <LeadLine team={r.team} /> : null}
                        </span>
                        {meta ? <span className="tnum shrink-0 text-xs text-neutral-500">{meta(r.team)}</span> : null}
                      </>
                    )}
                    <Check className={cn("size-4 shrink-0 text-accent", !selected && "invisible")} aria-hidden />
                  </li>
                );
              })
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LeadLine({ team }: { team: Team }) {
  const lead = leadSummary(team);
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs">
      {lead ? (
        <span className="truncate text-neutral-500">Lead: {lead}</span>
      ) : (
        <span className="inline-flex items-center gap-1 truncate text-amber-700">
          <UserRoundX className="size-3 shrink-0" aria-hidden />
          No lead yet
        </span>
      )}
      <span className="shrink-0 text-neutral-300" aria-hidden>·</span>
      <span className="tnum shrink-0 text-neutral-500">{team.memberCount ? pluralize(team.memberCount, "person", "people") : "No people"}</span>
    </span>
  );
}
