import type { Metadata } from "next";
import { FloorBuilder } from "@/components/floors/builder/floor-builder";
import { RequirePermission } from "@/components/auth/forbidden";

/** The draft is loaded from the API on the client, so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Edit floor layout" };

export default async function FloorEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="floors.manage">
      <FloorBuilder floorId={id} />
    </RequirePermission>
  );
}
