import type { Metadata } from "next";
import { MembersView } from "@/components/members/members-view";
import { RequirePermission } from "@/components/auth/forbidden";

/** Page content renders after the workspace is fetched from the API (WorkspaceGate shows the skeleton), so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Members" };

export default function MembersPage() {
  return (
    <RequirePermission permission="floor.view">
      <MembersView />
    </RequirePermission>
  );
}
