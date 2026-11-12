import type { Metadata } from "next";
import { Suspense } from "react";
import { FloorsView } from "@/components/floors/floors-view";
import { RequirePermission } from "@/components/auth/forbidden";

/** Page content renders after the workspace is fetched from the API (WorkspaceGate shows the skeleton), so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Floors" };

export default function FloorsPage() {
  return (
    <RequirePermission permission="floor.view">
      <Suspense>
        <FloorsView />
      </Suspense>
    </RequirePermission>
  );
}
