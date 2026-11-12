import type { Metadata } from "next";
import { FloorsManage } from "@/components/floors/floors-manage";
import { RequirePermission } from "@/components/auth/forbidden";

/** Lists floors (drafts included) from the API on the client, so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Manage floors" };

export default function FloorsManagePage() {
  return (
    <RequirePermission permission="floors.manage">
      <FloorsManage />
    </RequirePermission>
  );
}
