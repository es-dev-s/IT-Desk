import { ArrowLeftRight, Laptop, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

const POINTS = [
  { icon: ShieldCheck, title: "Role-based access", text: "Admins, team leads and IT each see exactly what their job needs." },
  { icon: ArrowLeftRight, title: "Moves without the spreadsheet", text: "Seats, teams and approvals in one place, with undo." },
  { icon: Laptop, title: "Every device accounted for", text: "IT works one queue from request to completed." },
];

/** 4×6 seat grid motif: a few desks lit, like a floor plan seen from above. */
const LIT = new Set([1, 6, 8, 13, 15, 20, 22]);

function WhiteLogo() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-white text-brand-600 shadow-[0_1px_2px_rgb(0_0_0/0.12)]">
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
          <rect x="2.5" y="3" width="4.5" height="4.5" rx="1.2" fill="currentColor" />
          <rect x="9" y="3" width="4.5" height="4.5" rx="1.2" fill="currentColor" opacity="0.45" />
          <rect x="2.5" y="9.5" width="4.5" height="4.5" rx="1.2" fill="currentColor" opacity="0.45" />
          <rect x="9" y="9.5" width="4.5" height="4.5" rx="1.2" fill="currentColor" />
        </svg>
      </span>
      <span className="text-base font-semibold tracking-[-0.02em] text-white">IT-Desk</span>
    </span>
  );
}

/** Split sign-in layout: brand panel (desktop) + focused form column. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside
        className="relative hidden overflow-hidden bg-brand-600 p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16"
        aria-label="About IT-Desk"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_0%_0%,var(--color-brand-500)_0%,transparent_60%),radial-gradient(90%_70%_at_100%_100%,var(--color-brand-800)_0%,transparent_65%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 top-1/2 grid -translate-y-1/2 rotate-[-8deg] grid-cols-4 gap-3 opacity-90"
        >
          {Array.from({ length: 24 }, (_, i) => (
            <span
              key={i}
              className={
                LIT.has(i)
                  ? "size-14 rounded-xl bg-white/90 shadow-[0_8px_24px_-8px_rgb(58_18_6/0.5)]"
                  : "size-14 rounded-xl bg-white/[0.07] ring-1 ring-inset ring-white/15"
              }
            />
          ))}
        </div>

        <div className="relative">
          <WhiteLogo />
        </div>

        <div className="relative max-w-md">
          <p className="text-[13px] font-medium uppercase tracking-[0.16em] text-brand-100">Internal workspace</p>
          <h2 className="mt-3 text-[34px] font-semibold leading-[1.12] tracking-[-0.03em] text-balance">
            Every move, seat and device, accounted for.
          </h2>
          <ul className="mt-10 space-y-5">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/12 ring-1 ring-inset ring-white/20">
                  <Icon className="size-[18px]" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="mt-0.5 block text-[13px] leading-5 text-brand-100">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-brand-100/90">Access is invitation-only. Accounts are issued by your IT-Desk administrator.</p>
      </aside>

      <section className="relative flex min-h-dvh flex-col bg-[radial-gradient(80%_50%_at_50%_0%,var(--color-brand-50),transparent_70%)] lg:bg-white">
        <div className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>
      </section>
    </main>
  );
}
