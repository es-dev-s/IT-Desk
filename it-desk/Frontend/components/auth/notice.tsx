import { CircleAlert, Info, LockKeyhole, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

const TONES = {
  error: { box: "border-red-200 bg-red-50 text-red-800", icon: CircleAlert, iconClass: "text-red-500" },
  lock: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: LockKeyhole, iconClass: "text-amber-600" },
  offline: { box: "border-line-strong bg-neutral-50 text-neutral-800", icon: WifiOff, iconClass: "text-neutral-500" },
  info: { box: "border-accent-line bg-accent-soft text-accent-ink", icon: Info, iconClass: "text-accent" },
} as const;

export type NoticeTone = keyof typeof TONES;

export function Notice({ tone, title, children, className }: { tone: NoticeTone; title?: string; children: React.ReactNode; className?: string }) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <div role={tone === "info" ? "status" : "alert"} className={cn("flex gap-3 rounded-xl border px-3.5 py-3 text-[13px] leading-5 animate-pop-in", t.box, className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", t.iconClass)} aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={title ? "mt-0.5" : undefined}>{children}</div>
      </div>
    </div>
  );
}
