import type { Metadata } from "next";
import { OverviewView } from "@/components/overview/overview-view";
import { HomeRoute } from "@/components/auth/forbidden";

/** Page content renders after the workspace is fetched from the API (WorkspaceGate shows the skeleton), so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <HomeRoute>
      <OverviewView />
    </HomeRoute>
  );
}
