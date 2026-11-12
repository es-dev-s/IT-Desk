"use client";

import { Check, Hash, Loader2, Pencil, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, floorsApi } from "@/lib/api";
import { SEAT_CODE_RE, sequenceCodes, type NumberDirection } from "@/lib/floors";
import type { Floor, FloorElement } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWorkspaceApi } from "@/store/workspace-provider";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");
const clean = (v: string) =>
  v
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 16);

/** Save new numbers, refresh, and offer Undo (puts the old numbers back). */
function useSaveCodes(floor: Floor) {
  const api = useWorkspaceApi();
  const [busy, setBusy] = useState(false);
  const save = async (changes: { seatId: string; code: string }[], label: string) => {
    const before = new Map(floor.elements.filter((e) => e.kind === "seat").map((e) => [e.id, e.code ?? ""]));
    setBusy(true);
    try {
      const res = await floorsApi.setSeatCodes(floor.id, { changes });
      await api.getState().refresh();
      if (!res.changed.length) {
        toast.message("Nothing to change", { description: "Those seats already have these numbers." });
        return true;
      }
      const undo = res.changed.map((c) => ({ seatId: c.seatId, code: before.get(c.seatId) ?? c.code }));
      toast.success(label, {
        description: "Everyone sees the new number right away. Seats, people and history are unchanged.",
        duration: 10_000,
        action: {
          label: "Undo",
          onClick: () => {
            void floorsApi
              .setSeatCodes(floor.id, { changes: undo })
              .then(() => api.getState().refresh())
              .then(() => toast.success("Seat numbers restored"))
              .catch((e) => toast.error(errText(e)));
          },
        },
      });
      return true;
    } catch (e) {
      toast.error(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { save, busy };
}

/**
 * The seat number in the seat panel. The admin changes it in place (pencil,
 * double-click, or opened straight from a double-click on the plan) — no team
 * needed. Key it by seat id + code.
 */
export function SeatCodeEditor({
  floor,
  seat,
  editable,
  startEditing = false,
  onDone,
}: {
  floor: Floor;
  seat: FloorElement;
  editable: boolean;
  startEditing?: boolean;
  /** Called when the number field closes (saved or cancelled). */
  onDone?: () => void;
}) {
  const [editing, setEdit] = useState(editable && startEditing);
  const setEditing = (v: boolean) => {
    setEdit(v);
    if (!v) onDone?.();
  };
  const [value, setValue] = useState(seat.code ?? "");
  const input = useRef<HTMLInputElement>(null);
  const { save, busy } = useSaveCodes(floor);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const taken = useMemo(() => {
    const v = clean(value);
    return floor.elements.find((e) => e.kind === "seat" && e.id !== seat.id && e.code === v)?.code ?? null;
  }, [floor, seat.id, value]);
  const v = clean(value);
  const error = !v
    ? "Enter a number"
    : !SEAT_CODE_RE.test(v)
      ? "Use digits (letters and dashes also work), up to 16"
      : taken
        ? `Seat ${taken} already exists on this floor`
        : null;

  if (!editing) {
    return (
      <div className="group flex items-baseline gap-2">
        <span className="text-[12px] font-medium uppercase tracking-wide text-neutral-400">Seat</span>
        <p
          className={cn("tnum text-2xl font-semibold leading-none tracking-tight text-neutral-900", editable && "cursor-text")}
          onDoubleClick={editable ? () => setEditing(true) : undefined}
          title={editable ? "Double-click to change the number" : undefined}
          data-testid="seat-code"
        >
          {seat.code}
        </p>
        {editable ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="self-center rounded-md p-1 text-neutral-400 opacity-60 transition hover:bg-neutral-100 hover:text-neutral-700 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="Change seat number"
            title="Change seat number"
            data-testid="seat-code-edit"
          >
            <Pencil className="size-3.5" />
          </button>
        ) : null}
      </div>
    );
  }

  const submit = async () => {
    if (error) return;
    if (v === seat.code) return setEditing(false);
    if (await save([{ seatId: seat.id, code: v }], `Seat ${seat.code} is now ${v}`)) setEditing(false);
  };

  return (
    <form
      className="space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1">
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(clean(e.target.value))}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditing(false), setValue(seat.code ?? ""))}
          maxLength={16}
          inputMode="numeric"
          aria-label="Seat number"
          aria-invalid={Boolean(error)}
          className={cn(
            "tnum h-9 w-28 rounded-md border bg-white px-2.5 text-[17px] font-semibold tracking-tight outline-none transition focus:ring-2 focus:ring-accent/30",
            error ? "border-red-300" : "border-line focus:border-accent",
          )}
          data-testid="seat-code-input"
        />
        <Button type="submit" size="icon-xs" variant="primary" disabled={Boolean(error) || busy} aria-label="Save seat number" data-testid="seat-code-save">
          {busy ? <Loader2 className="animate-spin" /> : <Check />}
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" onClick={() => (setEditing(false), setValue(seat.code ?? ""))} aria-label="Cancel">
          <X />
        </Button>
      </div>
      <p className={cn("text-[11px]", error ? "text-red-600" : "text-neutral-500")} data-testid="seat-code-hint">
        {error ?? "Any number for this desk — no team needed. Enter to save, Esc to cancel."}
      </p>
    </form>
  );
}

const DIRECTIONS: { id: NumberDirection; label: string }[] = [
  { id: "ltr", label: "Left → right" },
  { id: "rtl", label: "Right → left" },
  { id: "ttb", label: "Top → bottom" },
];

/** Bulk renumber the selected seats: plain numbers from a start, in a direction, with a preview. Key it by the selection. */
export function RenumberSeats({ floor, seats }: { floor: Floor; seats: readonly FloorElement[] }) {
  const firstCode = useMemo(() => [...seats].sort((a, b) => a.y - b.y || a.x - b.x)[0]?.code ?? "", [seats]);
  const [start, setStart] = useState(() => {
    const m = /(\d+)$/.exec(firstCode);
    return m ? String(Number(m[1])) : "1";
  });
  const [direction, setDirection] = useState<NumberDirection>("ltr");
  const { save, busy } = useSaveCodes(floor);

  const n = Number.parseInt(start, 10);
  const plan = useMemo(() => (Number.isFinite(n) && n >= 0 ? sequenceCodes(seats, { start: n, direction }) : []), [seats, n, direction]);
  const mine = new Set(plan.map((p) => p.seatId));
  const clash = plan.find((p) => floor.elements.some((e) => e.kind === "seat" && !mine.has(e.id) && e.code === p.code));
  const bad = plan.find((p) => !SEAT_CODE_RE.test(p.code));
  const error = !plan.length
    ? "Enter a start number"
    : bad
      ? `${bad.code} is not a valid seat number`
      : clash
        ? `Seat ${clash.code} is already used by another desk`
        : null;
  const preview = plan.length > 3 ? `${plan[0].code}, ${plan[1].code} … ${plan[plan.length - 1].code}` : plan.map((p) => p.code).join(", ");

  return (
    <section className="space-y-2 rounded-xl border border-line bg-neutral-50/60 px-3 py-2.5" data-testid="renumber">
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-neutral-500">
        <Hash className="size-3.5" aria-hidden /> Number these seats
      </h3>
      <label className="flex items-center gap-2 text-[12px] text-neutral-500">
        Start at
        <input
          value={start}
          onChange={(e) => setStart(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          className="tnum h-8 w-20 rounded-md border border-line bg-white px-2 text-[13px] font-medium text-neutral-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
          data-testid="renumber-start"
        />
      </label>
      <div className="inline-flex rounded-lg bg-neutral-100 p-0.5" role="radiogroup" aria-label="Numbering direction">
        {DIRECTIONS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={direction === d.id}
            onClick={() => setDirection(d.id)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium transition",
              direction === d.id ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800",
            )}
            data-testid={`renumber-${d.id}`}
          >
            {d.label}
          </button>
        ))}
      </div>
      <p className={cn("text-[12px]", error ? "text-red-600" : "text-neutral-500")} data-testid="renumber-preview">
        {error ?? `Seats ${preview}`}
      </p>
      <Button
        size="sm"
        disabled={Boolean(error) || busy}
        onClick={() => void save(plan, `${plan.length} ${plan.length === 1 ? "seat" : "seats"} renumbered`)}
        data-testid="renumber-apply"
      >
        {busy ? <Loader2 className="animate-spin" /> : null}
        Renumber {plan.length} {plan.length === 1 ? "seat" : "seats"}
      </Button>
    </section>
  );
}
