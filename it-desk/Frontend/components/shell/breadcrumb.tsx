"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import type { Crumb } from "@/lib/nav";
import { cn } from "@/lib/utils";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/**
 * Topbar breadcrumb. Ancestors are muted links; the current page is plain text in
 * foreground weight. On phones only the current page shows, so the bar never wraps.
 */
export function Breadcrumb({ crumbs, className }: { crumbs: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex h-8 min-w-0 items-center gap-1 text-[13px] leading-none">
        {crumbs.map((c, i) => {
          const current = i === crumbs.length - 1;
          const Icon = c.icon;
          return (
            <Fragment key={`${i}-${c.label}`}>
              {i > 0 ? (
                <li aria-hidden className="shrink-0 text-neutral-300 max-sm:hidden">
                  <ChevronRight className="size-3.5" strokeWidth={2.25} />
                </li>
              ) : null}
              <li className={cn("flex min-w-0 items-center", !current && "max-sm:hidden")}>
                {current ? (
                  <span aria-current="page" className="flex min-w-0 items-center gap-2 px-1.5 font-medium text-neutral-900">
                    {Icon ? <Icon className="size-4 shrink-0 text-neutral-400" aria-hidden /> : null}
                    <span className="truncate">{c.label}</span>
                  </span>
                ) : (
                  <Link
                    href={c.href ?? "/"}
                    className="group flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-neutral-500 outline-none transition-colors duration-150 hover:bg-accent-soft hover:text-accent-ink focus-visible:ring-2 focus-visible:ring-accent/35"
                  >
                    {i === 0 ? (
                      <span
                        aria-hidden
                        className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-neutral-900/[0.06] text-[9px] font-semibold tracking-wide text-neutral-600 transition-colors duration-150 group-hover:bg-accent-muted group-hover:text-accent-ink"
                      >
                        {initials(c.label)}
                      </span>
                    ) : null}
                    <span className="truncate max-w-[22ch]">{c.label}</span>
                  </Link>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
