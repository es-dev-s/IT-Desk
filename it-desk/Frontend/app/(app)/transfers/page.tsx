import type { Metadata } from "next";
import { TransfersView } from "@/components/transfers/transfers-view";
import { RequirePermission } from "@/components/auth/forbidden";

/** Page content renders after the workspace is fetched from the API (WorkspaceGate shows the skeleton), so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Transfers" };

export default function TransfersPage() {
  return (
    <RequirePermission permission="transfers.view">
      <TransfersView />
    </RequirePermission>
  );
}
