import type { Metadata } from "next";
import { RequirePermission } from "@/components/auth/forbidden";
import { TeamsView } from "@/components/teams/teams-view";

/** Lead summaries and counts are refreshed client-side after the session is confirmed, so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Teams" };

export default function TeamsPage() {
  return (
    <RequirePermission permission="users.manage">
      <TeamsView />
    </RequirePermission>
  );
}
