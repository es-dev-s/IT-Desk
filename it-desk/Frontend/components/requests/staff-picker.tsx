"use client";

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronsUpDown, Search, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { staffHue, type ITStaff } from "@/lib/it-staff";
import { cn } from "@/lib/utils";
import { useITStaff } from "@/store/it-staff-store";
import { Avatar } from "@/components/ui/avatar";
import { inputClass } from "@/components/ui/field";

/** Loads the active IT staff directory on first use. */
export function useStaffList() {
  const items = useITStaff((s) => s.items);
  const error = useITStaff((s) => s.error);
  const load = useITStaff((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return { staff: items ?? [], loading: items === null && !error, error };
}

const ANYONE = "";
/** Below this much room under the trigger the menu opens upward instead (search + ~3 rows). */
const MIN_BELOW = 232;

/**
 * "Assign to" picker for the IT staff directory: name + title with initials
 * avatars, searchable, keyboard friendly. Empty value = "Anyone in IT".
 */
export function StaffPicker({
  id,
  value,
  onChange,
  staff,
  loading = false,
  invalid = false,
  disabled = false,
  current,
  testId = "request-staff",
  className,
}: {
  id: string;
  value: string;
  onChange: (staffId: string) => void;
  staff: ITStaff[];
  loading?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  /** Shown when the value isn't in the active list any more (e.g. deactivated since). */
  current?: { name: string; title?: string | null } | null;
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Decided once per open: downward whenever it fits, upward only when the space
  // below is really too short and there is more above. Radix's own flip is off so
  // the menu never jumps sides while it is open; its height is capped to the room left.
  const [side, setSide] = useState<"bottom" | "top">("bottom");
  const selected = staff.find((s) => s.id === value) ?? (value && current ? { name: current.name, title: current.title ?? "" } : null);
  const q = query.trim().toLowerCase();
  const options = useMemo(() => {
    const people = staff.filter((s) => !q || `${s.name} ${s.title}`.toLowerCase().includes(q));
    return [...(q ? [] : [null]), ...people] as (ITStaff | null)[];
  }, [staff, q]);
  const cur = Math.min(active, Math.max(options.length - 1, 0));

  const choose = (s: ITStaff | null) => {
    onChange(s?.id ?? ANYONE);
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (disabled) return;
        if (o && triggerRef.current) {
          // Short on room below (e.g. trigger at the bottom of a scrolled dialog)? Bring it
          // up first so the menu can open downward instead of covering the form above.
          if (window.innerHeight - triggerRef.current.getBoundingClientRect().bottom < MIN_BELOW)
            triggerRef.current.scrollIntoView({ block: "center" });
          const r = triggerRef.current.getBoundingClientRect();
          const below = window.innerHeight - r.bottom;
          setSide(below >= MIN_BELOW || below >= r.top ? "bottom" : "top");
        }
        setOpen(o);
      }}
    >
      <div className={cn("relative", className)}>
        <Popover.Trigger
          ref={triggerRef}
          id={id}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={cn(inputClass, "flex h-10 items-center gap-2.5 pr-16 text-left disabled:cursor-not-allowed disabled:opacity-60")}
          data-testid={testId}
        >
          {selected ? (
            <>
              <Avatar name={selected.name} hue={staffHue(selected.name)} size="xs" />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[13px] font-medium text-neutral-900">{selected.name}</span>
                {selected.title ? <span className="block truncate text-[11px] text-neutral-500">{selected.title}</span> : null}
              </span>
            </>
          ) : (
            <>
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-500">
                <UsersRound className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[13px] font-medium text-neutral-700">Anyone in IT</span>
                <span className="block truncate text-[11px] text-neutral-400">{loading ? "Loading the IT team…" : "From the IT queue"}</span>
              </span>
            </>
          )}
          <ChevronsUpDown className="absolute right-2.5 size-4 text-neutral-400" aria-hidden />
        </Popover.Trigger>
        {selected && !disabled ? (
          <button
            type="button"
            aria-label="Assign to anyone in IT"
            onClick={() => choose(null)}
            className="absolute right-8 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-neutral-400 outline-none hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-accent/35"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align="start"
          sideOffset={6}
          avoidCollisions={false}
          collisionPadding={12}
          className="z-[70] flex max-h-[min(360px,calc(var(--radix-popover-content-available-height)-12px))] w-[var(--radix-popover-trigger-width)] min-w-[280px] flex-col rounded-xl bg-white p-1 shadow-pop outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
          data-testid={`${testId}-menu`}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" aria-hidden />
            <input
              role="combobox"
              aria-expanded
              aria-controls={`${id}-list`}
              aria-activedescendant={options.length ? `${id}-opt-${cur}` : undefined}
              aria-label="Search the IT team"
              className="h-9 w-full rounded-lg bg-transparent pl-8 pr-2 text-sm outline-none placeholder:text-neutral-400"
              placeholder="Search the IT team"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const next = (cur + (e.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(options.length, 1);
                  setActive(next);
                  listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (options.length) choose(options[cur]);
                }
              }}
            />
          </div>
          <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label="IT team" className="scrollbar-thin mt-1 max-h-72 min-h-0 flex-1 overflow-y-auto border-t border-line pt-1">
            {options.length === 0 ? (
              <li className="px-3 py-6 text-center text-[13px] text-neutral-500">{staff.length ? "No one matches" : "The IT staff list is empty"}</li>
            ) : (
              options.map((s, i) => {
                const isSel = s ? s.id === value : !value;
                return (
                  <li
                    key={s?.id ?? "anyone"}
                    id={`${id}-opt-${i}`}
                    role="option"
                    aria-selected={isSel}
                    data-index={i}
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(s)}
                    className={cn(
                      "flex h-12 cursor-default items-center gap-2.5 rounded-lg px-2 text-[13px]",
                      i === cur && "bg-neutral-900/[0.05]",
                      !s && "mb-1",
                    )}
                    data-testid={s ? `${testId}-option` : `${testId}-anyone`}
                  >
                    {s ? (
                      <Avatar name={s.name} hue={staffHue(s.name)} size="sm" />
                    ) : (
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-500">
                        <UsersRound className="size-4" aria-hidden />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-neutral-900">{s ? s.name : "Anyone in IT"}</span>
                      <span className="block truncate text-xs text-neutral-500">{s ? s.title || "IT" : "IT picks it up from the queue"}</span>
                    </span>
                    {s && s.open > 0 ? (
                      <span className="tnum shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500" title={`${s.open} open request${s.open === 1 ? "" : "s"}`}>
                        {s.open} open
                      </span>
                    ) : null}
                    {isSel ? <Check className="size-4 shrink-0 text-accent" aria-hidden /> : null}
                  </li>
                );
              })
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
