"use client";

import { AlertTriangle, ArrowRight, CircleCheck, Hand, LifeBuoy, Loader2, Plus, RefreshCw, Eye, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { formatRelative } from "@/lib/format";
import {
  CATEGORY_LABEL,
  EMPTY_REQUEST_FORM,
  PRIORITY_LABEL,
  REQUEST_PRIORITIES,
  isClosed,
  requestsApi,
  type ITRequest,
  type RequestStatus,
  type RequestType,
} from "@/lib/requests";
import { cn, pluralize } from "@/lib/utils";
import { useTeams } from "@/store/selectors";
import { useWorkspace } from "@/store/workspace-provider";
import { useRequests } from "@/store/requests-store";
import { useSession } from "@/components/auth/session-provider";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { SelectField } from "@/components/ui/select";
import { TeamCombobox } from "@/components/teams/team-combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { FilterRow, FiltersPopover, Toolbar } from "@/components/ui/toolbar";
import { Tip } from "@/components/ui/tooltip";
import { ItQueueSwitch } from "./it-queue-switch";
import { PriorityLabel, RequestStatusPill, RequestWhat, UnassignedLabel } from "./request-ui";
import { staffHue } from "@/lib/it-staff";
import { NewDot } from "@/components/realtime/ack";
import { useRequestAction } from "./use-request-action";

type View = "active" | "open" | "in_progress" | "resolved" | "closed" | "all";
const VIEWS: { value: View; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
const inView = (s: RequestStatus, v: View) =>
  v === "all" ||
  (v === "active" ? s === "open" || s === "in_progress" : v === "closed" ? s === "cancelled" || s === "rejected" : s === v);

const PRIORITY_RANK = Object.fromEntries(REQUEST_PRIORITIES.map((p, i) => [p, REQUEST_PRIORITIES.length - i])) as Record<string, number>;
const ORG = "__org";

export function RequestsView() {
  const { session, can } = useSession();
  const isIt = can("requests.fulfil");
  const isAdmin = session.user.role === "admin";
  const canCreate = can("requests.create");
  const teams = useTeams();
  const { items, error, loading, load, openDialog, openDetail } = useRequests();

  const [view, setView] = useState<View>("active");
  const [query, setQuery] = useState("");
  const [assignee, setAssignee] = useState<"any" | "mine" | "unassigned">("any");
  const focus = useWorkspace((s) => s.currentTeamId);
  const [team, setTeam] = useState(focus || "all");
  // The sidebar's team in focus drives the Team filter (adjusted during render, not in an effect).
  const [seenFocus, setSeenFocus] = useState(focus);
  if (seenFocus !== focus) {
    setSeenFocus(focus);
    setTeam(focus || "all");
  }
  // IT has no Team filter of its own, so it follows the sidebar directly.
  const teamFilter = isAdmin ? team : session.user.role === "team_lead" ? "all" : focus || "all";
  const [type, setType] = useState<"all" | RequestType>("all");
  const [sort, setSort] = useState<"newest" | "priority">(isIt ? "priority" : "newest");

  const all = useMemo(() => items ?? [], [items]);
  const scoped = useMemo(
    () =>
      all.filter((r) => {
        if (isIt && assignee === "mine" && r.assigneeId !== session.user.id) return false;
        if (isIt && assignee === "unassigned" && r.assigneeId) return false;
        if (teamFilter !== "all" && (teamFilter === ORG ? r.teamId !== null : r.teamId !== teamFilter)) return false;
        if (type !== "all" && r.type !== type) return false;
        return true;
      }),
    [all, isIt, assignee, teamFilter, type, session.user.id],
  );
  const counts = useMemo(() => {
    const c: Record<View, number> = { active: 0, open: 0, in_progress: 0, resolved: 0, closed: 0, all: 0 };
    for (const r of scoped) for (const v of VIEWS) if (inView(r.status, v.value)) c[v.value] += 1;
    return c;
  }, [scoped]);
  const unassigned = useMemo(() => all.filter((r) => !isClosed(r.status) && !r.assigneeId).length, [all]);
  const mine = useMemo(() => all.filter((r) => !isClosed(r.status) && r.assigneeId === session.user.id).length, [all, session.user.id]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scoped
      .filter((r) => inView(r.status, view))
      .filter(
        (r) =>
          !q ||
          `${r.ticket} ${r.notes} ${r.requesterName} ${r.forMemberName ?? ""} ${r.assigneeName ?? ""} ${r.staffName ?? ""} ${r.teamName ?? ""} ${r.items.map((i) => `${i.kind} ${i.description}`).join(" ")} ${r.type === "issue" ? `issue ${r.title} ${r.device} ${r.category ? CATEGORY_LABEL[r.category] : ""}` : ""}`
            .toLowerCase()
            .includes(q),
      )
      .sort((a, b) =>
        sort === "priority"
          ? PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.createdAt.localeCompare(b.createdAt)
          : b.createdAt.localeCompare(a.createdAt),
      );
  }, [scoped, view, query, sort]);

  const filtersActive =
    +(sort !== (isIt ? "priority" : "newest")) + +(isIt ? assignee !== "any" : isAdmin ? team !== "all" : false) + +(type !== "all");
  const resetFilters = () => {
    setAssignee("any");
    setTeam("all");
    setType("all");
    setSort(isIt ? "priority" : "newest");
  };

  const assigneeOptions = [
    { value: "any", label: "Anyone" },
    { value: "mine", label: `Assigned to me · ${mine}` },
    { value: "unassigned", label: `Unassigned · ${unassigned}` },
  ];
  const teamExtras = [
    { value: "all", label: "All teams" },
    { value: ORG, label: "Organisation-wide", hint: "Requests not tied to a team" },
  ];
  const typeOptions = [
    { value: "all", label: "Requests and issues" },
    { value: "equipment", label: "Equipment only" },
    { value: "issue", label: "Issues only" },
  ];
  const sortOptions = [
    { value: "newest", label: "Newest first" },
    { value: "priority", label: "Priority first" },
  ];

  const stats: { label: string; value: number; onClick: () => void; active: boolean; tone?: "accent" }[] = isIt
    ? [
        { label: "Unassigned", value: unassigned, onClick: () => { setView("active"); setAssignee("unassigned"); }, active: view === "active" && assignee === "unassigned", tone: unassigned ? "accent" : undefined },
        { label: "Assigned to me", value: mine, onClick: () => { setView("active"); setAssignee("mine"); }, active: view === "active" && assignee === "mine" },
        { label: "In progress", value: all.filter((r) => r.status === "in_progress").length, onClick: () => { setView("in_progress"); setAssignee("any"); }, active: view === "in_progress" && assignee === "any" },
        { label: "Resolved", value: all.filter((r) => r.status === "resolved").length, onClick: () => { setView("resolved"); setAssignee("any"); }, active: view === "resolved" && assignee === "any" },
      ]
    : (["open", "in_progress", "resolved", "closed"] as const).map((v) => ({
        label: VIEWS.find((x) => x.value === v)!.label,
        value: counts[v],
        onClick: () => setView(v),
        active: view === v,
      }));

  const loadingFirst = items === null && !error;

  return (
    <>
      <h1 className="sr-only">IT requests</h1>

      {isIt ? (
        <div className="mb-5 flex items-center gap-3">
          <ItQueueSwitch value="requests" />
          <p className="hidden text-[13px] text-neutral-500 md:block">Equipment asks and reported issues from admins and team leads.</p>
        </div>
      ) : (
        <div className="mb-5 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-neutral-500">
              Ask IT for a laptop, headset, mouse, CPU or anything else, or report an issue like a broken laptop or no network. Track
              everything here.
            </p>
          </div>
          {canCreate ? (
            <>
              <Button className="shrink-0" onClick={() => openDialog({ ...EMPTY_REQUEST_FORM, type: "issue" })} data-testid="requests-new-issue">
                <TriangleAlert aria-hidden />
                <span className="max-sm:sr-only">Report issue</span>
              </Button>
              <Button variant="primary" className="shrink-0" onClick={() => openDialog()} data-testid="requests-new">
                <Plus aria-hidden />
                New request
              </Button>
            </>
          ) : null}
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={s.onClick}
            className={cn(
              "rounded-card border bg-white px-4 py-3.5 text-left shadow-card outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/35",
              s.active ? "border-accent-line ring-1 ring-accent-line" : "border-line",
            )}
          >
            <span className={cn("text-xs font-medium", s.tone === "accent" ? "text-accent-ink" : "text-neutral-500")}>{s.label}</span>
            {loadingFirst ? (
              <Skeleton className="mt-2 h-6 w-10" />
            ) : (
              <span className="tnum mt-1 block text-2xl font-semibold tracking-[-0.03em] text-neutral-900">{s.value}</span>
            )}
          </button>
        ))}
      </div>

      {/* One-row toolbar: status inline from 760px; the secondary filter inline from 1040px. */}
      <Toolbar label="Request tools" className="mb-4">
        <SearchField
          size="md"
          className="min-w-0 flex-1 @min-[760px]:max-w-72"
          value={query}
          onChange={setQuery}
          label="Search requests"
          placeholder="Ticket, person, item, issue or note"
        />
        <Segmented
          size="md"
          className="hidden @min-[760px]:inline-flex"
          label="Status"
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ ...v, count: v.value === "all" ? undefined : counts[v.value] }))}
        />
        {isIt ? (
          <SelectField
            size="md"
            className="ml-auto hidden @min-[1040px]:inline-flex"
            label="Assignee"
            value={assignee}
            onValueChange={(v) => setAssignee(v as typeof assignee)}
            options={assigneeOptions}
          />
        ) : isAdmin ? (
          <TeamCombobox
            variant="toolbar"
            size="md"
            className="ml-auto hidden w-56 @min-[1040px]:inline-flex"
            label="Team"
            value={team}
            onChange={setTeam}
            teams={teams}
            extras={teamExtras}
            testId="requests-team"
          />
        ) : null}
        <div className={cn("flex shrink-0 items-center gap-2", !(isIt || isAdmin) ? "ml-auto" : "ml-auto @min-[1040px]:ml-0")}>
          <FiltersPopover
            labelClassName="@max-[480px]:sr-only"
            canReset={filtersActive > 0}
            onReset={resetFilters}
            tiers={[{ value: filtersActive + +(view !== "active"), className: "grid @min-[760px]:hidden" }, { value: filtersActive, className: "hidden @min-[760px]:grid" }]}
          >
            <div className="@min-[760px]:hidden">
              <FilterRow label="Status">
                <SelectField
                  size="md"
                  className="w-full"
                  label="Status"
                  value={view}
                  onValueChange={(v) => setView(v as View)}
                  options={VIEWS.map((v) => ({ value: v.value, label: v.value === "all" ? v.label : `${v.label} · ${counts[v.value]}` }))}
                />
              </FilterRow>
            </div>
            {isIt ? (
              <FilterRow label="Assignee">
                <SelectField size="md" className="w-full" label="Assignee" value={assignee} onValueChange={(v) => setAssignee(v as typeof assignee)} options={assigneeOptions} />
              </FilterRow>
            ) : isAdmin ? (
              <FilterRow label="Team">
                <TeamCombobox variant="toolbar" size="md" className="w-full" label="Team" value={team} onChange={setTeam} teams={teams} extras={teamExtras} testId="requests-team-filter" />
              </FilterRow>
            ) : null}
            <FilterRow label="Type">
              <SelectField size="md" className="w-full" label="Type" value={type} onValueChange={(v) => setType(v as typeof type)} options={typeOptions} />
            </FilterRow>
            <FilterRow label="Sort">
              <SelectField size="md" className="w-full" label="Sort" value={sort} onValueChange={(v) => setSort(v as typeof sort)} options={sortOptions} />
            </FilterRow>
          </FiltersPopover>
          <Tip label="Refresh">
            <Button size="icon" aria-label="Refresh requests" onClick={() => void load(session.user.id)} disabled={loading}>
              <RefreshCw className={cn(loading && "animate-spin")} aria-hidden />
            </Button>
          </Tip>
        </div>
      </Toolbar>

      <Card className="overflow-hidden">
        {loadingFirst ? (
          <TableSkeleton />
        ) : error && items === null ? (
          <EmptyState
            icon={AlertTriangle}
            title="Couldn’t load requests"
            description={error}
            action={
              <Button onClick={() => void load(session.user.id)}>
                <RefreshCw aria-hidden />
                Try again
              </Button>
            }
          />
        ) : rows.length ? (
          <RequestTable rows={rows} isIt={isIt} isAdmin={isAdmin} onOpen={openDetail} />
        ) : (
          <EmptyState
            icon={LifeBuoy}
            title={query ? "Nothing matches that search" : all.length === 0 ? (isIt ? "No requests yet" : "You haven’t asked IT for anything yet") : "Nothing here"}
            description={
              query
                ? "Try a ticket number, a name or an item."
                : all.length === 0
                  ? isIt
                    ? "Requests from admins and team leads land here."
                    : "Need a laptop or headset, or is something broken? Send a request or report an issue and IT will pick it up."
                  : "Try another status or filter."
            }
            action={
              canCreate && !query && all.length === 0 ? (
                <Button variant="primary" onClick={() => openDialog()}>
                  <Plus aria-hidden />
                  Request IT
                </Button>
              ) : undefined
            }
          />
        )}
      </Card>
      {rows.length ? (
        <p className="tnum mt-3 text-xs text-neutral-500">
          {pluralize(rows.length, "request")} · sorted by {sort === "priority" ? "priority" : "newest"}
          {error ? <span className="text-amber-700"> · showing cached data ({error})</span> : null}
        </p>
      ) : null}
    </>
  );
}

function RequestTable({ rows, isIt, isAdmin, onOpen }: { rows: ITRequest[]; isIt: boolean; isAdmin: boolean; onOpen: (id: string) => void }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-[13px]" data-testid="requests-table">
        <thead>
          <tr className="h-10 border-b border-line bg-subtle text-xs font-medium text-neutral-500 [&>th]:px-4 [&>th]:font-medium [&>th:first-child]:pl-5 [&>th:last-child]:pr-5">
            <th className="w-[34%]">Request</th>
            <th>{isAdmin || isIt ? "Raised by" : "Raised by / for"}</th>
            <th className="w-[92px]">Priority</th>
            <th className="w-[124px]">Status</th>
            <th className="w-[150px]">Assignee</th>
            <th className={cn(isIt ? "w-[178px]" : "w-[96px]", "text-right")}>{isIt ? "" : "Updated"}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr
              key={r.id}
              tabIndex={0}
              onClick={() => onOpen(r.id)}
              onKeyDown={(e) => (e.key === "Enter" && e.target === e.currentTarget ? onOpen(r.id) : null)}
              className="h-[60px] cursor-default outline-none transition-colors duration-150 hover:bg-neutral-50 focus-visible:bg-accent-soft/50 [&>td]:px-4 [&>td:first-child]:pl-5 [&>td:last-child]:pr-5"
              data-testid="request-row"
              data-ticket={r.ticket}
              data-status={r.status}
            >
              <td className="max-w-0">
                <div className="flex items-center gap-2">
                  {isIt && r.status === "open" && !r.acknowledgement ? <NewDot /> : null}
                  <span className="tnum shrink-0 font-mono text-xs font-medium text-neutral-500">{r.ticket}</span>
                  <RequestWhat request={r} max={2} className="min-w-0 flex-nowrap overflow-hidden" />
                </div>
                <p className="mt-0.5 truncate text-xs text-neutral-500">{r.notes}</p>
              </td>
              <td className="max-w-0">
                <span className="flex items-center gap-2">
                  <Avatar name={r.requesterName} size="xs" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-neutral-900">{r.requesterName}</span>
                    <span className="block truncate text-xs text-neutral-500">
                      {r.forMemberName ? `For ${r.forMemberName}` : r.teamName ?? "Organisation-wide"}
                      {r.forMemberName && r.teamCode ? ` · ${r.teamCode}` : ""}
                    </span>
                  </span>
                </span>
              </td>
              <td>
                <PriorityLabel priority={r.priority} compact />
                <span className="sr-only">{PRIORITY_LABEL[r.priority]} priority</span>
              </td>
              <td>
                <span className="inline-flex items-center gap-1.5">
                  <RequestStatusPill status={r.status} />
                  {r.acknowledgement && !isClosed(r.status) ? (
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-700" title={`Seen by ${r.acknowledgement.byName}`} data-testid="row-seen">
                      <Eye className="size-3" aria-hidden />
                      <span className="sr-only">Seen by {r.acknowledgement.byName}</span>
                    </span>
                  ) : !isIt && r.status === "open" ? (
                    <span className="relative grid size-5 shrink-0 place-items-center" title="Waiting for IT" data-testid="row-waiting">
                      <span className="absolute size-2 animate-ping rounded-full bg-accent-strong opacity-40 [animation-duration:1.8s] motion-reduce:hidden" aria-hidden />
                      <span className="relative size-1.5 rounded-full bg-accent" aria-hidden />
                      <span className="sr-only">Waiting for IT</span>
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="max-w-0">
                {r.assigneeName ? (
                  <span className="flex items-center gap-2">
                    <Avatar name={r.assigneeName} size="xs" />
                    <span className="min-w-0">
                      <span className="block truncate text-neutral-700">{r.assigneeName}</span>
                      {r.staffName && r.staffName !== r.assigneeName ? (
                        <span className="block truncate text-xs text-neutral-500" title="IT staff it was routed to">
                          for {r.staffName}
                        </span>
                      ) : null}
                    </span>
                  </span>
                ) : r.staffName ? (
                  <span className="flex items-center gap-2" data-testid="row-staff">
                    <Avatar name={r.staffName} hue={staffHue(r.staffName)} size="xs" />
                    <span className="min-w-0">
                      <span className="block truncate text-neutral-700">{r.staffName}</span>
                      {r.staffTitle ? <span className="block truncate text-xs text-neutral-500">{r.staffTitle}</span> : null}
                    </span>
                  </span>
                ) : isClosed(r.status) ? (
                  <span className="text-neutral-400">—</span>
                ) : (
                  <UnassignedLabel />
                )}
              </td>
              <td className="text-right">
                {isIt ? (
                  <QuickAction request={r} />
                ) : (
                  <span className="tnum text-xs text-neutral-500">{formatRelative(r.updatedAt)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One-click next step for IT, right in the row. Everything else lives in the detail sheet. */
function QuickAction({ request: r }: { request: ITRequest }) {
  const { session } = useSession();
  const { pending, run } = useRequestAction();
  const mineOrFree = !r.assigneeId || r.assigneeId === session.user.id;
  const action =
    r.status === "open" && !r.acknowledgement && mineOrFree
      ? { key: "ack", label: "Acknowledge", icon: Eye, fn: () => requestsApi.acknowledge(r.id, { expectedVersion: r.version }), done: `${r.ticket} acknowledged · in progress` }
      : r.status === "open" && !r.assigneeId
      ? { key: "claim", label: "Claim", icon: Hand, fn: () => requestsApi.assign(r.id, { assigneeId: "me", expectedVersion: r.version }), done: `${r.ticket} claimed` }
      : r.status === "open" && mineOrFree
        ? { key: "start", label: "Start", icon: ArrowRight, fn: () => requestsApi.move(r.id, { status: "in_progress", expectedVersion: r.version }), done: `${r.ticket} in progress` }
        : r.status === "in_progress" && mineOrFree
          ? { key: "resolve", label: "Resolve", icon: CircleCheck, fn: () => requestsApi.move(r.id, { status: "resolved", expectedVersion: r.version }), done: `${r.ticket} resolved` }
          : null;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="tnum hidden text-xs text-neutral-400 xl:inline">{formatRelative(r.updatedAt)}</span>
      {action ? (
        <Button
          size="sm"
          variant={action.key === "claim" || action.key === "ack" ? "primary" : "secondary"}
          disabled={Boolean(pending)}
          onClick={(e) => {
            e.stopPropagation();
            void run(action.key, r.ticket, action.fn, () => action.done);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          data-testid={`row-${action.key}`}
        >
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <action.icon aria-hidden />}
          {action.label}
        </Button>
      ) : null}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading requests">
      <div className="h-10 border-b border-line bg-subtle" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-[60px] items-center gap-4 border-b border-line px-5 last:border-b-0">
          <Skeleton className="h-4 w-[30%]" />
          <Skeleton className="h-4 w-[18%]" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
