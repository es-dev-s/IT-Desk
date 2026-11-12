"use client";

import { Check, LayoutGrid, Map as MapIcon, Minus, Rows3, SearchX, UserPlus, UsersRound } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { compareSeats } from "@/lib/constants";
import type { ItStatus, Member } from "@/lib/schemas";
import { useCurrentTeam, useTeamMembers, useTransfers } from "@/store/selectors";
import { useUI, type MemberSort, type MembersView as View } from "@/store/ui-store";
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

const matchesQuery = (m: Member, q: string) =>
  !q || `${m.name} ${m.seat ?? ""} ${m.subGroup} ${m.email} ${m.employeeId}`.toLowerCase().includes(q);

export function MembersView() {
  const team = useCurrentTeam();
  const all = useTeamMembers();
  const f = useUI(useShallow((s) => s.members));
  const setMembers = useUI((s) => s.setMembers);
  const toggle = useUI((s) => s.toggleSelected);
  const setSelection = useUI((s) => s.setSelection);
  const clear = useUI((s) => s.clearSelection);
  const reset = useUI((s) => s.resetMemberFilters);
  const { can } = useSession();
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

  const counts = useMemo(() => {
    const c = { all: all.length, active: 0, resigned: 0, unknown: 0 };
    for (const m of all) c[m.status] += 1;
    return c;
  }, [all]);

  const filtered = useMemo(() => {
    const q = f.query.trim().toLowerCase();
    return all
      .filter((m) => (f.status === "all" || m.status === f.status) && (f.subGroup === "all" || m.subGroup === f.subGroup) && matchesQuery(m, q))
      .sort((a, b) => (f.sort === "name" ? a.name.localeCompare(b.name) : compareSeats(a.seat, b.seat) || a.name.localeCompare(b.name)));
  }, [all, f.query, f.status, f.subGroup, f.sort]);

  const active = useMemo(() => all.filter((m) => m.status === "active"), [all]);
  const mapMatches = useMemo(() => {
    const q = f.query.trim().toLowerCase();
    return new Set(active.filter((m) => (f.subGroup === "all" || m.subGroup === f.subGroup) && matchesQuery(m, q)).map((m) => m.id));
  }, [active, f.query, f.subGroup]);

  const selectedIds = Object.keys(f.selected).filter((id) => active.some((m) => m.id === id));
  const scope = f.view === "map" ? active.filter((m) => mapMatches.has(m.id)) : filtered.filter((m) => m.status === "active");
  const allChecked = scope.length > 0 && scope.every((m) => f.selected[m.id]);
  const someChecked = !allChecked && scope.some((m) => f.selected[m.id]);
  const visible = filtered.slice(0, f.visible);

  const isMap = f.view === "map";
  const statusOff = !isMap && f.status !== "active";
  const groupOff = f.subGroup !== "all";
  const sortOff = !isMap && f.sort !== "seat";
  const statusInline = (toolbarWidth ?? 0) >= 920;

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
            value={f.status}
            onChange={(status) => setMembers({ status })}
            options={statusOptions.map((o) => ({ ...o, count: counts[o.value] }))}
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <FiltersPopover
            labelClassName="@max-[480px]:sr-only"
            canReset={statusOff || groupOff || sortOff}
            onReset={() => setMembers({ status: "active", subGroup: "all", sort: "seat" })}
            tiers={[
              { value: +statusOff + +groupOff + +sortOff, className: "grid @min-[920px]:hidden" },
              { value: +groupOff + +sortOff, className: "hidden @min-[920px]:grid" },
            ]}
          >
            {isMap || statusInline ? null : (
              <FilterRow label="Status">
                <SelectField
                  size="md"
                  className="w-full"
                  label="Status"
                  value={f.status}
                  onValueChange={(status) => setMembers({ status: status as typeof f.status })}
                  options={statusOptions.map((o) => ({ value: o.value, label: `${o.label} · ${counts[o.value]}` }))}
                />
              </FilterRow>
            )}
            <FilterRow label="Group">
              <SelectField
                size="md"
                className="w-full"
                label="Sub-group"
                value={f.subGroup}
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
      ) : all.length === 0 ? (
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
              <Button size="sm" onClick={reset}>
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
                member={m}
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
