"use client";

import { Printer } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDate } from "@/lib/format";
import { exportHref, reportsApi, TASK_STATUS_LABEL, type ITTaskRow, type TaskReportFilter } from "@/lib/reports";
import { cn } from "@/lib/utils";
import { useTeams } from "@/store/selectors";
import { useSession } from "@/components/auth/session-provider";
import { TeamCombobox } from "@/components/teams/team-combobox";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/field";
import { SearchField } from "@/components/ui/search-field";
import { SelectField } from "@/components/ui/select";
import { Blank, ExportButton, ReportTable, useDebounced, useReport, type Column } from "./report-ui";

const STATUS_OPTIONS = [
  { value: "all", label: "All tasks" },
  { value: "completed", label: "Completed" },
  { value: "open", label: "Not completed" },
];

const ALL_TEAMS = [{ value: "all", label: "All teams" }];
const EMPTY_RANGE = { startDate: "", endDate: "" };
const formatDay = (day: string) => formatDate(`${day}T00:00:00Z`);

/**
 * Tasks assigned to IT members: when each was assigned and completed, who it
 * was for and what was done. An IT account only sees its own tasks, a team
 * lead only their team's, an admin all of them.
 */
export function ITTaskReport() {
  const { session } = useSession();
  const role = session.user.role;
  const teams = useTeams();
  const [teamId, setTeamId] = useState("all");
  const [itMember, setItMember] = useState("all");
  const [status, setStatus] = useState<NonNullable<TaskReportFilter["status"]>>("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(EMPTY_RANGE);
  const [range, setRange] = useState(EMPTY_RANGE);
  const q = useDebounced(search);
  const filter = useMemo<TaskReportFilter>(
    () => ({
      teamId: role === "team_lead" ? undefined : teamId,
      itMember: role === "it" ? undefined : itMember,
      status,
      q,
      ...range,
    }),
    [role, teamId, itMember, status, q, range],
  );
  const { data: latest, currentData: data, error, loading, retry } = useReport(JSON.stringify(filter), (signal) => reportsApi.itTasks(filter, signal));
  const staff = latest?.staff ?? [];
  const rangeLabel = range.startDate ? `${formatDay(range.startDate)} to ${formatDay(range.endDate)}` : "All dates";
  const count = data ? `${data.rows.length} ${data.rows.length === 1 ? "task" : "tasks"} · ${data.completed} completed` : "";

  const columns = useMemo<Column<ITTaskRow>[]>(() => {
    const cols: Column<ITTaskRow>[] = [
      { key: "assigned", title: "Assigned Date", className: "whitespace-nowrap", cell: (r) => <span className="tnum">{formatDate(r.assignedAt)}</span> },
      {
        key: "completed",
        title: "Completed Date",
        className: "whitespace-nowrap",
        cell: (r) => (r.completedAt ? <span className="tnum">{formatDate(r.completedAt)}</span> : <Blank />),
      },
      { key: "member", title: "Team Member Name", cell: (r) => <span className="font-medium text-neutral-900">{r.memberName}</span> },
      { key: "team", title: "Team", cell: (r) => r.teamName || <Blank /> },
      { key: "it", title: "IT Member", cell: (r) => r.itMember || <Blank /> },
      { key: "ticket", title: "Request", className: "whitespace-nowrap", cell: (r) => <span className="tnum font-mono text-xs">{r.ticket}</span> },
      {
        key: "status",
        title: "Status",
        className: "whitespace-nowrap",
        cell: (r) => <span className={cn(r.status === "resolved" ? "text-emerald-700" : "text-amber-700")}>{TASK_STATUS_LABEL[r.status]}</span>,
      },
      { key: "task", title: "Task Description", className: "min-w-72", cell: (r) => r.description },
    ];
    return cols.filter((c) => !(role === "team_lead" && c.key === "team") && !(role === "it" && c.key === "it"));
  }, [role]);

  return (
    <div className="it-task-report space-y-4" data-testid="it-task-report">
      <h1 className="sr-only print:not-sr-only print:text-lg print:font-semibold">IT task report</h1>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <SearchField value={search} onChange={setSearch} label="Search tasks" placeholder="Search a member, device or request" size="md" className="w-full sm:w-80" />
        {role === "team_lead" ? null : (
          <TeamCombobox
            label="Team"
            prefix="Team"
            variant="toolbar"
            className="max-w-full"
            value={teamId}
            onChange={setTeamId}
            teams={teams}
            extras={ALL_TEAMS}
            testId="task-report-team-filter"
          />
        )}
        {role === "it" ? null : (
          <SelectField
            label="IT member"
            prefix="IT member"
            size="md"
            value={staff.some((s) => s.id === itMember) ? itMember : "all"}
            onValueChange={setItMember}
            options={[{ value: "all", label: "Everyone" }, ...staff.map((s) => ({ value: s.id, label: s.name }))]}
          />
        )}
        <SelectField label="Status" size="md" value={status} onValueChange={(v) => setStatus(v as typeof status)} options={STATUS_OPTIONS} />
        <p className="tnum ml-auto text-xs text-neutral-500" data-testid="report-count" aria-live="polite">
          {count || (loading ? "Loading…" : "Report unavailable")}
        </p>
        <Button onClick={() => window.print()} disabled={!data}>
          <Printer aria-hidden /> Print
        </Button>
        <ExportButton href={exportHref("it-tasks", filter)} disabled={!data || data.rows.length === 0} />
      </div>
      <form
        aria-label="Date range filter"
        className="flex flex-wrap items-end gap-2 print:hidden"
        onSubmit={(event) => {
          event.preventDefault();
          setRange(draft);
        }}
      >
        <label className="grid gap-1 text-xs font-medium text-neutral-600">
          Start Date
          <input
            type="date"
            className={inputClass}
            required
            min="0001-01-01"
            max={draft.endDate || "9999-12-31"}
            value={draft.startDate}
            onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium text-neutral-600">
          End Date
          <input
            type="date"
            className={inputClass}
            required
            min={draft.startDate || "0001-01-01"}
            max="9999-12-31"
            value={draft.endDate}
            onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
          />
        </label>
        <Button type="submit" variant="primary" disabled={draft.startDate === range.startDate && draft.endDate === range.endDate}>
          Apply dates
        </Button>
        {range.startDate || draft.startDate || draft.endDate ? (
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(EMPTY_RANGE);
              setRange(EMPTY_RANGE);
            }}
          >
            Clear dates
          </Button>
        ) : null}
      </form>
      <p className="text-xs text-neutral-500 print:hidden" aria-live="polite">
        <span className="font-medium text-neutral-700">{rangeLabel}</span>
        {" · Matches tasks assigned or completed in the range (Nepal Time)."}
        {role === "it" ? " Showing the tasks assigned to you." : ""}
      </p>
      <p className="hidden text-xs text-neutral-700 print:block">
        {rangeLabel} (Nepal Time){count ? ` · ${count}` : ""}
      </p>
      <ReportTable
        label="IT task report"
        columns={columns}
        rows={data?.rows ?? null}
        rowKey={(r) => r.requestId}
        loading={loading}
        error={error}
        onRetry={retry}
        minWidth={980}
        empty={q || status !== "all" || teamId !== "all" || itMember !== "all" || range.startDate ? "No task matches these filters." : role === "it" ? "No tasks are assigned to you yet." : "No tasks have been assigned to IT yet."}
      />
    </div>
  );
}
