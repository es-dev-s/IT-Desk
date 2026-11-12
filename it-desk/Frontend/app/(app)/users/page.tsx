import type { Metadata } from "next";
import { RequirePermission } from "@/components/auth/forbidden";
import { UsersView } from "@/components/users/users-view";

/** Account data is fetched client-side after the session is confirmed, so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Users" };

export default function UsersPage() {
  return (
    <RequirePermission permission="users.manage">
      <UsersView />
    </RequirePermission>
  );
}
