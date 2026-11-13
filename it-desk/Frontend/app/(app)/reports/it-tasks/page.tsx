import type { Metadata } from "next";
import { RequirePermission } from "@/components/auth/forbidden";
import { ITTaskReport } from "@/components/reports/it-task-report";

/** Rows are loaded from the API on the client (scoped to the signed-in role), so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "IT task report" };

export default function ITTaskReportPage() {
  return (
    <RequirePermission permission="reports.view">
      <ITTaskReport />
    </RequirePermission>
  );
}
