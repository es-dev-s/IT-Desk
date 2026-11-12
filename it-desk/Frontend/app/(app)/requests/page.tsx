import type { Metadata } from "next";
import { RequirePermission } from "@/components/auth/forbidden";
import { RequestsView } from "@/components/requests/requests-view";

/** Content renders after the session and workspace load client-side, so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Requests" };

export default function RequestsPage() {
  return (
    <RequirePermission permission="requests.view">
      <RequestsView />
    </RequirePermission>
  );
}
