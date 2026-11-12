import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginView } from "@/components/auth/login-view";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-white" />}>
      <LoginView />
    </Suspense>
  );
}
