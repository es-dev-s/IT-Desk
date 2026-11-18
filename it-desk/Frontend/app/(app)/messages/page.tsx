import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { RequirePermission } from "@/components/auth/forbidden";
import { MessagesView } from "@/components/messages/messages-view";
import { chatHref } from "@/lib/chat";

/** Content renders after the session and workspace load client-side, so this segment is not instant by design. */
export const instant = false;

export const metadata: Metadata = { title: "Messages" };

export default function MessagesPage({ searchParams }: PageProps<"/messages">) {
  return (
    <RequirePermission permission="requests.comment">
      <Suspense fallback={null}>
        <MessagesRoute searchParams={searchParams} />
      </Suspense>
    </RequirePermission>
  );
}

async function MessagesRoute({ searchParams }: Pick<PageProps<"/messages">, "searchParams">) {
  const { r } = await searchParams;
  if (typeof r === "string" && r) redirect(chatHref(r));
  return <MessagesView />;
}
