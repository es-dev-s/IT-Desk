import type { Metadata } from "next";
import { Suspense } from "react";
import { RequirePermission } from "@/components/auth/forbidden";
import { MessagesView } from "@/components/messages/messages-view";

/** Content renders after the session and workspace load client-side, so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Messages" };

export default function MessagesPage() {
  return (
    <RequirePermission permission="requests.comment">
      <Suspense fallback={null}>
        <MessagesView />
      </Suspense>
    </RequirePermission>
  );
}
