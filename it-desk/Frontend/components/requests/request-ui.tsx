import {
  AppWindow,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  Cpu,
  Headphones,
  KeyRound,
  Laptop,
  Loader,
  MonitorX,
  Mouse,
  Package,
  TriangleAlert,
  WifiOff,
  XCircle,
} from "lucide-react";
import {
  CATEGORY_LABEL,
  KIND_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  type ITRequest,
  type IssueCategory,
  type RequestItem,
  type RequestKind,
  type RequestPriority,
  type RequestStatus,
} from "@/lib/requests";
import { cn } from "@/lib/utils";

export const KIND_ICON: Record<RequestKind, React.ComponentType<{ className?: string }>> = {
  laptop: Laptop,
  headphone: Headphones,
  mouse: Mouse,
  cpu: Cpu,
  other: Package,
};

export const CATEGORY_ICON: Record<IssueCategory, React.ComponentType<{ className?: string }>> = {
  hardware: MonitorX,
  network: WifiOff,
  software: AppWindow,
  access: KeyRound,
  other: CircleHelp,
};

export const ISSUE_ICON = TriangleAlert;
export const EQUIPMENT_ICON = Package;

/** Issue badge: amber "Issue" tag, category icon and the title. */
export function IssueChip({ request: r, className }: { request: Pick<ITRequest, "category" | "title">; className?: string }) {
  const Icon = r.category ? CATEGORY_ICON[r.category] : ISSUE_ICON;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)} data-testid="issue-chip">
      <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-amber-50 px-1.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
        <ISSUE_ICON className="size-3.5" aria-hidden />
        Issue
      </span>
      <span
        className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-line bg-white px-1.5 text-xs font-medium text-neutral-700"
        title={r.category ? `${CATEGORY_LABEL[r.category]}: ${r.title}` : r.title}
      >
        <Icon className="size-3.5 shrink-0 text-neutral-400" aria-hidden />
        <span className="truncate">{r.title}</span>
      </span>
    </span>
  );
}

/** What a request is about: item chips for equipment, the issue badge for issues. */
export function RequestWhat({ request: r, className, max }: { request: ITRequest; className?: string; max?: number }) {
  return r.type === "issue" ? <IssueChip request={r} className={className} /> : <ItemChips items={r.items} max={max} className={className} />;
}

const STATUS_STYLE: Record<RequestStatus, { className: string; icon: React.ComponentType<{ className?: string }> }> = {
  open: { className: "bg-accent-soft text-accent-ink ring-accent/20", icon: CircleDot },
  in_progress: { className: "bg-sky-50 text-sky-800 ring-sky-600/15", icon: Loader },
  resolved: { className: "bg-emerald-50 text-emerald-700 ring-emerald-600/15", icon: CircleCheck },
  cancelled: { className: "bg-neutral-100 text-neutral-600 ring-neutral-500/15", icon: XCircle },
  rejected: { className: "bg-red-50 text-red-700 ring-red-600/15", icon: Ban },
};

export function RequestStatusPill({ status, className }: { status: RequestStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span
      className={cn("inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium ring-1 ring-inset", s.className, className)}
      data-status={status}
    >
      <Icon className="size-3.5" aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

const PRIORITY_BAR: Record<RequestPriority, string> = {
  low: "bg-emerald-500",
  normal: "bg-amber-400",
  high: "bg-red-400",
  urgent: "bg-red-800",
};
const PRIORITY_TEXT: Record<RequestPriority, string> = {
  low: "text-emerald-700",
  normal: "text-amber-700",
  high: "text-red-500",
  urgent: "text-red-800",
};

/** One colour bar per priority: low green, normal yellow, high light red, urgent dark red. */
export function PriorityLabel({ priority, className, compact = false }: { priority: RequestPriority; className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium", PRIORITY_TEXT[priority], className)} title={`${PRIORITY_LABEL[priority]} priority`}>
      <span className="inline-flex h-3.5 w-7 shrink-0 items-center" aria-hidden>
        <span className={cn("h-1.5 w-full rounded-full", PRIORITY_BAR[priority])} />
      </span>
      <span className={cn(compact && "sr-only")}>{PRIORITY_LABEL[priority]}</span>
    </span>
  );
}

/** Item chips: icon, name (or the "other" description) and quantity. */
export function ItemChips({ items, className, max }: { items: RequestItem[]; className?: string; max?: number }) {
  const shown = max ? items.slice(0, max) : items;
  const rest = items.length - shown.length;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      {shown.map((it) => {
        const Icon = KIND_ICON[it.kind];
        const name = it.kind === "other" && it.description ? it.description : KIND_LABEL[it.kind];
        return (
          <span
            key={it.kind}
            className="inline-flex h-6 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md border border-line bg-white px-1.5 text-xs font-medium text-neutral-700"
            title={it.kind === "other" ? `Other: ${it.description}` : undefined}
          >
            <Icon className="size-3.5 shrink-0 text-neutral-400" aria-hidden />
            <span className="truncate">{name}</span>
            {it.quantity > 1 ? <span className="tnum shrink-0 text-neutral-400">×{it.quantity}</span> : null}
          </span>
        );
      })}
      {rest > 0 ? <span className="shrink-0 text-xs font-medium text-neutral-400" title={`${rest} more`}>+{rest}</span> : null}
    </span>
  );
}

export function UnassignedLabel() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-neutral-400">
      <CircleDashed className="size-4" aria-hidden />
      Unassigned
    </span>
  );
}
