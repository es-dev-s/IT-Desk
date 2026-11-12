import type { Metadata } from "next";
import { Suspense } from "react";
import { ChangePasswordView } from "@/components/auth/change-password-view";

export const metadata: Metadata = { title: "Change password", robots: { index: false, follow: false } };

export default function ChangePasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-white" />}>
      <ChangePasswordView />
    </Suspense>
  );
}
