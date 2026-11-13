import type { Metadata } from "next";
import { RequirePermission } from "@/components/auth/forbidden";
import { MemberDeviceReport } from "@/components/reports/member-device-report";

/** Rows are loaded from the API on the client (scoped to the signed-in role), so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Member & device report" };

export default function MemberDeviceReportPage() {
  return (
    <RequirePermission permission="reports.view">
      <MemberDeviceReport />
    </RequirePermission>
  );
}
