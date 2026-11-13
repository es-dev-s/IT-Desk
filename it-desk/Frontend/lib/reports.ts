import { z } from "zod";
import { API_BASE_URL, request } from "./api";

/* ----------------------------------------------------------------------------
 * Reports: spreadsheet-shaped, read-only. The API scopes every report to the
 * signed-in role (a lead's own team; an IT account's own tasks), so the filters
 * here only ever narrow what the server already allows.
 * ------------------------------------------------------------------------- */

const iso = z.iso.datetime({ offset: true });

export const memberDeviceRowSchema = z.object({
  memberId: z.string(),
  memberName: z.string(),
  employeeId: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  seatCode: z.string().nullable(),
  floorName: z.string().nullable(),
  deviceId: z.string().nullable(),
  deviceKind: z.string(),
  deviceModel: z.string(),
  assetTag: z.string(),
});
export type MemberDeviceRow = z.infer<typeof memberDeviceRowSchema>;

export const memberDeviceReportSchema = z.object({
  rows: z.array(memberDeviceRowSchema),
  members: z.number().int().min(0),
  devices: z.number().int().min(0),
  generatedAt: iso,
});
export type MemberDeviceReport = z.infer<typeof memberDeviceReportSchema>;

export const TASK_STATUSES = ["open", "in_progress", "resolved"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { open: "Assigned", in_progress: "In progress", resolved: "Completed" };

export const itTaskRowSchema = z.object({
  requestId: z.string(),
  ticket: z.string(),
  type: z.string(),
  status: z.enum(TASK_STATUSES),
  assignedAt: iso,
  completedAt: iso.nullable(),
  staffId: z.string().nullable(),
  itMember: z.string(),
  teamId: z.string().nullable(),
  teamName: z.string(),
  memberName: z.string(),
  description: z.string(),
});
export type ITTaskRow = z.infer<typeof itTaskRowSchema>;

export const itTaskReportSchema = z.object({
  rows: z.array(itTaskRowSchema),
  /** IT members the caller may filter by (empty for IT accounts: they only see their own). */
  staff: z.array(z.object({ id: z.string(), name: z.string() })),
  completed: z.number().int().min(0),
  generatedAt: iso,
});
export type ITTaskReport = z.infer<typeof itTaskReportSchema>;

export type MemberReportFilter = { teamId?: string; q?: string };
export type TaskReportFilter = { teamId?: string; itMember?: string; status?: "all" | "completed" | "open"; q?: string };

function query(f: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    const value = v?.trim();
    if (value && value !== "all") p.set(k, value);
  }
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export const reportsApi = {
  members: (f: MemberReportFilter, signal?: AbortSignal) => request(`/reports/members${query(f)}`, { schema: memberDeviceReportSchema, signal }),
  itTasks: (f: TaskReportFilter, signal?: AbortSignal) => request(`/reports/it-tasks${query(f)}`, { schema: itTaskReportSchema, signal }),
};

/** Excel download of exactly what the filters show. Dates are written in the viewer's timezone. */
export function exportHref(report: "members" | "it-tasks", f: Record<string, string | undefined>) {
  return `${API_BASE_URL}/api/v1/reports/${report}${query({ ...f, format: "xlsx", utcOffset: String(-new Date().getTimezoneOffset()) })}`;
}

/** "Name (ID)", or just the name when no employee id is on file. */
export const memberLabel = (r: Pick<MemberDeviceRow, "memberName" | "employeeId">) => (r.employeeId ? `${r.memberName} (${r.employeeId})` : r.memberName);

const KIND_LABEL: Record<string, string> = { cpu: "CPU" };
export function deviceName(r: Pick<MemberDeviceRow, "deviceKind" | "deviceModel">) {
  const kind = KIND_LABEL[r.deviceKind] ?? (r.deviceKind ? r.deviceKind[0].toUpperCase() + r.deviceKind.slice(1) : "");
  if (!r.deviceModel) return kind;
  return kind ? `${r.deviceModel} (${kind})` : r.deviceModel;
}
