import { Suspense } from "react";
import { Providers } from "@/components/providers";
import { SessionProvider } from "@/components/auth/session-provider";
import { AppShell } from "@/components/shell/app-shell";
import { ShellSkeleton, WorkspaceGate } from "@/components/shell/workspace-gate";
import { RouteGuard } from "@/components/auth/route-guard";
import { requireSession, requireRouteAccess } from "@/lib/server-session";
import { WorkspaceStoreProvider } from "@/store/workspace-provider";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Providers>
      {/* The session is request-specific: resolve it inside Suspense so the shell streams immediately. */}
      <Suspense fallback={<ShellSkeleton />}>
        <AuthenticatedApp>{children}</AuthenticatedApp>
      </Suspense>
    </Providers>
  );
}

async function AuthenticatedApp({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  // Routes the role can't open go to its home before anything renders.
  if (session) await requireRouteAccess(session);
  return (
    <SessionProvider initial={session}>
      <WorkspaceStoreProvider>
        <WorkspaceGate>
          <AppShell>
            <RouteGuard>{children}</RouteGuard>
          </AppShell>
        </WorkspaceGate>
      </WorkspaceStoreProvider>
    </SessionProvider>
  );
}
