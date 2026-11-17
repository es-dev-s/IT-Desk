"use client";

import { Check, LayoutGrid, Map as MapIcon, Minus, Rows3, SearchX, UserPlus, UsersRound } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { compareSeats } from "@/lib/constants";
import type { ItStatus, RosterEntry } from "@/lib/schemas";
import { useCurrentTeam, useTeamMembers, useTeamsById, useTransfers } from "@/store/selectors";
import { useUI, type MemberSort, type MembersView as View } from "@/store/ui-store";
import { useWorkspace } from "@/store/workspace-provider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { SelectField } from "@/components/ui/select";
import { FilterRow, FiltersPopover, Toolbar, ToolbarDivider, useElementWidth } from "@/components/ui/toolbar";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BulkBar } from "./bulk-bar";
import { useSession } from "@/components/auth/session-provider";
import { TeamSwitcher } from "@/components/auth/team-switcher";
import { MemberList } from "./member-list";
import { SeatMap } from "./seat-map";
import { SeatTile } from "./seat-tile";

const statusOptions = [
  { value: "active", label: "Active" },
  { value: "resigned", label: "Resigned" },
  { value: "unknown", label: "Unknown" },
  { value: "all", label: "All" },
] as const;

const ignore = () => {};

const matchesQuery = (entry: RosterEntry, q: string) => {
  if (!q) return true;
  const searchable = "status" in entry
    ? `${entry.name} ${entry.seat ?? ""} ${entry.subGroup} ${entry.email} ${entry.employeeId}`
    : `${entry.name} ${entry.title} ${entry.email}`;
  return searchable.toLowerCase().includes(q);
};

const isLead = (entry: RosterEntry) => "status" in entry ? entry.isLead : true;

export function MembersView() {
  const team = useCurrentTeam();
  const all = useTeamMembers();
  const teams = useTeamsById();
  const unrosteredLeads = useWorkspace((s) => s.unrosteredLeads);
  const selectedTeamId = useWorkspace((s) => s.requestedTeamId ?? s.currentTeamId);
  const selectTeam = useWorkspace((s) => s.selectTeam);
  const f = useUI(useShallow((s) => s.members));
  const setMembers = useUI((s) => s.setMembers);
  const toggle = useUI((s) => s.toggleSelected);
  const setSelection = useUI((s) => s.setSelection);
  const clear = useUI((s) => s.clearSelection);
  const reset = useUI((s) => s.resetMemberFilters);
  const { can, session } = useSession();
  const isAdmin = session.user.role === "admin";
  const defaultStatus = isAdmin && team ? "all" : "active";
  const status = f.status ?? defaultStatus;
  // Admins see the floor read-only: no selection, no bulk bar.
  const selectable = can("transfers.create") || can("exits.create");
  const onToggle = selectable ? toggle : ignore;
  const canManage = can("members.manage");
  const openMemberDialog = useUI((s) => s.openMemberDialog);
  const [toolbarRef, toolbarWidth] = useElementWidth<HTMLDivElement>();

  const transfers = useTransfers();
  /** Members with an open (not yet completed) transfer → its IT stage. */
  const pending = useMemo(() => {
    const map = new Map<string, ItStatus>();
    for (const t of transfers) if (t.itStatus !== "completed") for (const mv of t.moves) map.set(mv.memberId, t.itStatus);
    return map;
  }, [transfers]);

  /** Sub-groups come from the roster itself (no hard-coded list). */
  const subGroups = useMemo(() => [...new Set(all.map((m) => m.subGroup))].sort((a, b) => a.localeCompare(b)), [all]);
  const subGroup = subGroups.includes(f.subGroup) ? f.subGroup : "all";
  const roster = useMemo(
    () => isAdmin ? [...all, ...unrosteredLeads.filter((lead) => !team || lead.teamId === team.id)] : all,
    [all, isAdmin, team, unrosteredLeads],
  );

  const counts = useMemo(() => {
    const c = { all: roster.length, active: 0, resigned: 0, unknown: 0 };
    for (const entry of roster) c["status" in entry ? entry.status : "active"] += 1;
    return c;
  }, [roster]);

  const filtered = useMemo(() => {
    const q = f.query.trim().toLowerCase();
    return roster
      .filter((entry) => {
        const entryStatus = "status" in entry ? entry.status : "active";
        const matchesGroup = subGroup === "all" || ("subGroup" in entry && entry.subGroup === subGroup);
        return (status === "all" || entryStatus === status) && matchesGroup && matchesQuery(entry, q);
      })
      .sort((a, b) => {
        const leadsFirst = Number(isLead(b)) - Number(isLead(a));
        const bySeat = f.sort === "seat" ? compareSeats("seat" in a ? a.seat : null, "seat" in b ? b.seat : null) : 0;
        return leadsFirst || bySeat || a.name.localeCompare(b.name);
      });
  }, [roster, f.query, f.sort, status, subGroup]);

  const active = useMemo(() => all.filter((m) => m.status === "active"), [all]);
  const mapMatches = useMemo(() => {
    const q = f.query.trim().toLowerCase();
    return new Set(active.filter((m) => (subGroup === "all" || m.subGroup === subGroup) && matchesQuery(m, q)).map((m) => m.id));
  }, [active, f.query, subGroup]);

  const selectedIds = Object.keys(f.selected).filter((id) => active.some((m) => m.id === id));
  const scope = f.view === "map" ? active.filter((m) => mapMatches.has(m.id)) : filtered.filter((m) => "status" in m && m.status === "active");
  const allChecked = scope.length > 0 && scope.every((m) => f.selected[m.id]);
  const someChecked = !allChecked && scope.some((m) => f.selected[m.id]);
  const visible = filtered.slice(0, f.visible);

  const isMap = f.view === "map";
  const teamOff = isAdmin && selectedTeamId !== "";
  const statusOff = !isMap && status !== defaultStatus;
  const groupOff = subGroup !== "all";
  const sortOff = !isMap && f.sort !== "seat";
  const filterCount = Number(teamOff) + Number(groupOff) + Number(sortOff);
  const statusInline = (toolbarWidth ?? 0) >= 920;
  const clearTeam = () => {
    if (teamOff) void selectTeam("");
  };

  return (
    <>
      <h1 className="sr-only">Members</h1>

      {/* One-row toolbar. Status sits inline on wide containers and moves into Filters below 920px. */}
      <Toolbar ref={toolbarRef} label="Member tools" className="mb-6">
        <SearchField
          size="md"
          className="min-w-0 flex-1 @min-[920px]:max-w-72"
          value={f.query}
          onChange={(query) => setMembers({ query })}
          label="Search members"
          placeholder={toolbarWidth !== null && toolbarWidth < 600 ? "Search" : "Name, seat or group"}
        />
        {isMap ? null : (
          <Segmented
            size="md"
            className="hidden @min-[920px]:inline-flex"
            label="Status"
            value={status}
            onChange={(status) => setMembers({ status })}
            options={statusOptions.map((o) => ({ ...o, count: counts[o.value] }))}
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <FiltersPopover
            labelClassName="@max-[480px]:sr-only"
            canReset={statusOff || filterCount > 0}
            onReset={() => {
              setMembers({ status: null, subGroup: "all", sort: "seat" });
              clearTeam();
            }}
            tiers={[
              { value: Number(statusOff) + filterCount, className: "grid @min-[920px]:hidden" },
              { value: filterCount, className: "hidden @min-[920px]:grid" },
            ]}
          >
            {isAdmin ? (
              <FilterRow label="Team">
                <TeamSwitcher className="min-w-0" size="md" label="Filter members by team" testId="member-team-filter" singleChevron />
              </FilterRow>
            ) : null}
            {isMap || statusInline ? null : (
              <FilterRow label="Status">
                <SelectField
                  size="md"
                  className="w-full"
                  label="Status"
                  value={status}
                  onValueChange={(status) => setMembers({ status: status as NonNullable<typeof f.status> })}
                  options={statusOptions.map((o) => ({ value: o.value, label: `${o.label} · ${counts[o.value]}` }))}
                />
              </FilterRow>
            )}
            <FilterRow label="Group">
              <SelectField
                size="md"
                className="w-full"
                label="Sub-group"
                value={subGroup}
                onValueChange={(subGroup) => setMembers({ subGroup })}
                options={[{ value: "all", label: "All groups" }, ...subGroups.map((g) => ({ value: g, label: g }))]}
              />
            </FilterRow>
            {isMap ? null : (
              <FilterRow label="Sort by">
                <SelectField
                  size="md"
                  className="w-full"
                  label="Sort"
                  value={f.sort}
                  onValueChange={(sort) => setMembers({ sort: sort as MemberSort })}
                  options={[
                    { value: "seat", label: "Seat number" },
                    { value: "name", label: "Name" },
                  ]}
                />
              </FilterRow>
            )}
          </FiltersPopover>
          {selectable ? (
          <Tip label={allChecked || someChecked ? "Clear selection" : `Select all ${scope.length} shown`}>
            <button
              type="button"
              role="checkbox"
              aria-checked={someChecked ? "mixed" : allChecked}
              aria-label="Select all shown"
              disabled={scope.length === 0}
              onClick={() => (allChecked || someChecked ? clear() : setSelection([...selectedIds, ...scope.map((m) => m.id)]))}
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-lg border bg-white shadow-xs outline-none transition-colors duration-150",
                "focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-50",
                allChecked || someChecked ? "border-accent-line bg-accent-soft" : "border-line-strong hover:bg-neutral-50",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-4 place-items-center rounded-[4px] border transition-colors",
                  allChecked || someChecked ? "border-accent bg-accent text-white" : "border-neutral-300 bg-white",
                )}
              >
                {someChecked ? <Minus className="size-3" strokeWidth={3} /> : allChecked ? <Check className="size-3" strokeWidth={3} /> : null}
              </span>
            </button>
          </Tip>
          ) : null}
          <ToolbarDivider />
          <Segmented<View>
            size="md"
            label="View"
            collapseLabels
            value={f.view}
            onChange={(view) => setMembers({ view })}
            options={[
              { value: "grid", label: "Seats", icon: LayoutGrid },
              { value: "list", label: "List", icon: Rows3 },
              { value: "map", label: "Floor", icon: MapIcon },
            ]}
          />
          {canManage ? (
            <>
              <ToolbarDivider />
              <Button variant="primary" onClick={() => openMemberDialog()} data-testid="member-add" aria-label="Add member">
                <UserPlus aria-hidden />
                <span className="@max-[600px]:sr-only">Add member</span>
              </Button>
            </>
          ) : null}
        </div>
      </Toolbar>

      {f.view === "map" ? (
        <SeatMap teamId={team?.id ?? ""} members={active} matches={mapMatches} selected={f.selected} onToggle={onToggle} />
      ) : roster.length === 0 ? (
        <div className="rounded-card border border-line bg-white" data-testid="members-empty-team">
          <EmptyState
            icon={UsersRound}
            title={team ? `No one on ${team.name} yet` : "No one here yet"}
            description={
              canManage
                ? "Add the first person with their desk and devices, or bring people in with a transfer. Their zone seats are all free."
                : "People join this team when they’re added or transferred in."
            }
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {canManage ? (
                  <Button size="sm" variant="primary" onClick={() => openMemberDialog()} data-testid="member-add-empty">
                    <UserPlus aria-hidden />
                    Add the first member
                  </Button>
                ) : null}
                <Button size="sm" onClick={() => setMembers({ view: "map" })}>
                  Open floor plan
                </Button>
              </div>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-card border border-line bg-white">
          <EmptyState
            icon={SearchX}
            title="No members match"
            description="Try a different name or seat, or clear the filters."
            action={
              <Button size="sm" onClick={() => {
                reset();
                clearTeam();
              }}>
                Clear filters
              </Button>
            }
          />
        </div>
      ) : f.view === "grid" ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 max-sm:grid-cols-2 max-sm:gap-3">
          {visible.map((m) => (
            <li key={m.id}>
              <SeatTile
                entry={m}
                teamName={teams[m.teamId]?.name}
                selected={Boolean(f.selected[m.id])}
                selecting={selectedIds.length > 0}
                pending={pending.get(m.id)}
                onToggle={onToggle}
                selectable={selectable}
              />
            </li>
          ))}
        </ul>
      ) : (
        <MemberList members={visible} selected={f.selected} onToggle={onToggle} selectable={selectable} />
      )}

      {f.view !== "map" && filtered.length > visible.length ? (
        <div className="mt-8 flex flex-col items-center gap-2">
          <Button onClick={() => setMembers({ visible: f.visible + 24 })}>Show more</Button>
          <p className="tnum text-xs text-neutral-500">
            {visible.length} of {filtered.length}
          </p>
        </div>
      ) : null}

      <BulkBar ids={selectedIds} />
    </>
  );
}
