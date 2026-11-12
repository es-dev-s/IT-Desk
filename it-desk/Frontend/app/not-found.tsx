import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { Logo } from "@/components/shell/logo";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="flex flex-col items-center text-center">
        <Logo />
        <p className="mt-10 font-mono text-sm text-neutral-400">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">Page not found</h1>
        <p className="mt-1 text-sm text-neutral-500">This page doesn&apos;t exist in IT-Desk.</p>
        <Link href="/" className={buttonClass("primary", "md", "mt-6")}>Back to overview</Link>
      </div>
    </main>
  );
}
