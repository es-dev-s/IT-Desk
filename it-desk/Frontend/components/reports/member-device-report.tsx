"use client";

import { useMemo, useState } from "react";
import { deviceName, exportHref, memberLabel, reportsApi, type MemberDeviceRow } from "@/lib/reports";
import { useTeams } from "@/store/selectors";
import { useSession } from "@/components/auth/session-provider";
import { SearchField } from "@/components/ui/search-field";
import { SelectField } from "@/components/ui/select";
import { Blank, ExportButton, ReportTable, useDebounced, useReport, type Column } from "./report-ui";

/**
 * Who sits where and which devices they hold, one row per device. Admins and
 * IT see every team (and can pick one); a team lead sees their own team.
 */
export function MemberDeviceReport() {
  const { session } = useSession();
  const lead = session.user.role === "team_lead";
  const teams = useTeams();
  const [teamId, setTeamId] = useState("all");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const filter = useMemo(() => ({ teamId: lead ? undefined : teamId, q }), [lead, teamId, q]);
  const { data, error, loading, retry } = useReport(JSON.stringify(filter), (signal) => reportsApi.members(filter, signal));

  const columns = useMemo<Column<MemberDeviceRow>[]>(() => {
    const cols: Column<MemberDeviceRow>[] = [
      { key: "member", title: "Member Name (ID)", cell: (r) => <span className="font-medium text-neutral-900">{memberLabel(r)}</span> },
      { key: "team", title: "Team", cell: (r) => r.teamName },
      {
        key: "seat",
        title: "Seat Number",
        cell: (r) =>
          r.seatCode ? (
            <>
              <span className="tnum font-medium">{r.seatCode}</span>
              {r.floorName ? <span className="text-neutral-500"> · {r.floorName}</span> : null}
            </>
          ) : (
            <span className="text-neutral-400">No seat</span>
          ),
      },
      { key: "device", title: "Device Name", cell: (r) => (r.deviceId ? deviceName(r) : <span className="text-neutral-400">No device</span>) },
      { key: "number", title: "Device Number", className: "whitespace-nowrap", cell: (r) => (r.assetTag ? <span className="tnum font-mono text-xs">{r.assetTag}</span> : <Blank />) },
    ];
    return lead ? cols.filter((c) => c.key !== "team") : cols;
  }, [lead]);

  return (
    <div className="space-y-4" data-testid="member-device-report">
      <h1 className="sr-only">Member &amp; device report</h1>
      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={search} onChange={setSearch} label="Search members and devices" placeholder="Search a member, seat or device" size="md" className="w-full sm:w-80" />
        {lead ? null : (
          <SelectField
            label="Team"
            prefix="Team"
            size="md"
            value={teamId}
            onValueChange={setTeamId}
            options={[{ value: "all", label: "All teams" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
          />
        )}
        <p className="tnum ml-auto text-xs text-neutral-500" data-testid="report-count" aria-live="polite">
          {data ? `${data.members} ${data.members === 1 ? "member" : "members"} · ${data.devices} ${data.devices === 1 ? "device" : "devices"}` : "Loading…"}
        </p>
        <ExportButton href={exportHref("members", filter)} disabled={!data || data.rows.length === 0} />
      </div>
      <ReportTable
        label="Member and device report"
        columns={columns}
        rows={data?.rows ?? null}
        rowKey={(r, i) => `${r.memberId}:${r.deviceId ?? i}`}
        loading={loading}
        error={error}
        onRetry={retry}
        empty={q ? "No member or device matches that search." : "No active members here yet."}
      />
    </div>
  );
}
