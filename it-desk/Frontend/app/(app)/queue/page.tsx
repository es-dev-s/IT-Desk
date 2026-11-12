import type { Metadata } from "next";
import { RequirePermission } from "@/components/auth/forbidden";
import { QueueView } from "@/components/queue/queue-view";

/** Page content renders after the workspace is fetched from the API (WorkspaceGate shows the skeleton), so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "IT queue" };

export default function QueuePage() {
  return (
    <RequirePermission permission="transfers.advance">
      <QueueView />
    </RequirePermission>
  );
}
