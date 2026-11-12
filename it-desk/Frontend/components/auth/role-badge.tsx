import { ROLE_LABEL, type Role } from "@/lib/session";
import { cn } from "@/lib/utils";

const TONE: Record<Role, string> = {
  admin: "bg-neutral-900 text-white",
  team_lead: "bg-accent-soft text-accent-ink ring-1 ring-inset ring-accent/15",
  it: "bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-600/15",
};

export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold tracking-[0.01em]", TONE[role], className)}>
      {ROLE_LABEL[role]}
    </span>
  );
}
