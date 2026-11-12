"use client";

import {
  ArrowLeft,
  Armchair,
  Ban,
  Cloud,
  CloudOff,
  DoorOpen,
  Eraser,
  Eye,
  Keyboard,
  Loader2,
  MousePointer2,
  Redo2,
  RefreshCw,
  Rocket,
  RotateCcw,
  Rows3,
  Square,
  SquareDashed,
  Type,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { floorsApi } from "@/lib/api";
import { autoNumber, facingRowsTemplate, validateLayout } from "@/lib/floors";
import { formatTimeAgo } from "@/lib/format";
import { onLive } from "@/lib/live-bus";
import type { FloorElement, FloorSummary } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { Button, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, inputClass } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { useOccupancy, useTeamColors, useTeamsById } from "@/store/selectors";
import { FloorCanvas, type FloorCanvasHandle } from "../floor-canvas";
import { useZoneAction } from "../zone-action";
import { addSeats, blocked, eraseAt, fitGrid, intersects, lineCells, make, rectOf, stepCells, topAt, type Cell } from "./geometry";
import { Inspector } from "./inspector";
import { useBuilderDoc, type Doc } from "./use-builder-doc";

type Tool = "select" | "seat" | "row" | "block" | "door" | "label" | "room" | "void" | "erase";
const TOOLS: {
  id: Tool;
  label: string;
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
}[] = [
  {
    id: "select",
    label: "Select",
    key: "V",
    icon: MousePointer2,
    hint: "Click, Shift-click or drag a box",
  },
  {
    id: "seat",
    label: "Seat",
    key: "S",
    icon: Armchair,
    hint: "Click or drag to paint desks",
  },
  {
    id: "row",
    label: "Seat row",
    key: "R",
    icon: Rows3,
    hint: "Drag a straight row of desks",
  },
  {
    id: "block",
    label: "Block / aisle",
    key: "B",
    icon: Square,
    hint: "Drag an area (desk block, aisle)",
  },
  {
    id: "door",
    label: "Door",
    key: "D",
    icon: DoorOpen,
    hint: "Click to place a door",
  },
  {
    id: "label",
    label: "Label",
    key: "L",
    icon: Type,
    hint: "Click to add text (Washroom, Server…)",
  },
  {
    id: "room",
    label: "Room",
    key: "M",
    icon: SquareDashed,
    hint: "Drag a meeting room or enclosed area",
  },
  {
    id: "void",
    label: "Void",
    key: "X",
    icon: Ban,
    hint: "Drag an unusable area (pillar, shaft)",
  },
  {
    id: "erase",
    label: "Eraser",
    key: "E",
    icon: Eraser,
    hint: "Click or drag to remove",
  },
];
const RECT: Partial<Record<Tool, FloorElement["kind"]>> = {
  block: "block",
  room: "room",
  void: "void",
};

type Drag = { tool: Tool; a: Cell; b: Cell; last: Cell; additive: boolean };

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Admin floor builder: paint the layout, number seats, paint team zones, publish. */
export function FloorBuilder({ floorId }: { floorId: string }) {
  const b = useBuilderDoc(floorId);
  const { doc } = b;
  const [meta, setMeta] = useState<FloorSummary | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [focusLabel, setFocusLabel] = useState(0);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const canvas = useRef<FloorCanvasHandle>(null);
  const teams = useTeamsById();
  const colors = useTeamColors();
  const occ = useOccupancy();
  const zone = useZoneAction();

  const loadMeta = useCallback(async () => {
    try {
      const all = await floorsApi.list();
      setMeta(all.find((f) => f.id === floorId) ?? null);
    } catch {
      /* the header just shows less */
    }
  }, [floorId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void loadMeta();
    return onLive("floor", () => void loadMeta());
  }, [loadMeta]);

  const els = useMemo(() => doc?.elements ?? [], [doc]);
  const issues = useMemo(() => (doc ? validateLayout(doc.cols, doc.rows, doc.elements, (id) => Boolean(teams[id])) : {}), [doc, teams]);
  const selection = useMemo(() => els.filter((e) => sel.has(e.id)), [els, sel]);
  const problems = Object.keys(issues).length;
  const seatCount = els.filter((e) => e.kind === "seat").length;

  // Drop selection entries that no longer exist (undo, erase).
  useEffect(() => {
    if (selection.length !== sel.size) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prune stale ids
      setSel(new Set(selection.map((e) => e.id)));
    }
  }, [selection, sel]);

  const editSel = useCallback(
    (ids: ReadonlySet<string>, fn: (e: FloorElement) => FloorElement) =>
      b.change((d) => ({
        ...d,
        elements: d.elements.map((e) => (ids.has(e.id) ? fn(e) : e)),
      })),
    [b],
  );
  const deleteSel = useCallback(() => {
    if (!sel.size) return;
    const ids = sel;
    b.change((d) => ({
      ...d,
      elements: d.elements.filter((e) => !ids.has(e.id)),
    }));
    setSel(new Set());
  }, [b, sel]);
  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (!doc || !sel.size) return;
      const ids = sel;
      const moved = doc.elements.filter((e) => ids.has(e.id)).map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
      if (moved.some((e) => e.x < 0 || e.y < 0 || e.x + e.w > doc.cols || e.y + e.h > doc.rows)) return;
      if (moved.some((m) => blocked(doc.elements, m, ids))) {
        toast.message("Something is in the way", { id: "nudge" });
        return;
      }
      const byId = new Map(moved.map((m) => [m.id, m]));
      b.change((d) => ({
        ...d,
        elements: d.elements.map((e) => byId.get(e.id) ?? e),
      }));
    },
    [b, doc, sel],
  );

  /* ---------- pointer tools ---------- */

  const begin = (c: Cell, e: React.PointerEvent) => {
    if (!doc) return;
    const d: Drag = {
      tool,
      a: c,
      b: c,
      last: c,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
    };
    if (tool === "seat") b.change((x) => ({ ...x, elements: addSeats(x.elements, [c], x.cols, x.rows) }), "stroke");
    else if (tool === "erase") b.change((x) => ({ ...x, elements: eraseAt(x.elements, [c]) }), "stroke");
    else if (tool === "door" || tool === "label") {
      const el = make(tool, c.x, c.y, {
        label: tool === "door" ? "Door" : "Label",
      });
      if (tool === "door" && blocked(els, el)) {
        toast.message("A door needs an empty cell (or a room's edge)", {
          id: "place",
        });
        return;
      }
      b.change((x) => ({ ...x, elements: [...x.elements, el] }));
      setSel(new Set([el.id]));
      if (tool === "label") setFocusLabel((n) => n + 1);
      return;
    }
    dragRef.current = d;
    setDrag(d);
  };
  const move = (c: Cell) => {
    const d = dragRef.current;
    if (!d || (c.x === d.last.x && c.y === d.last.y)) return;
    const path = stepCells(d.last, c);
    const next = { ...d, b: c, last: c };
    dragRef.current = next;
    if (d.tool === "seat") b.change((x) => ({ ...x, elements: addSeats(x.elements, path, x.cols, x.rows) }), "stroke");
    else if (d.tool === "erase") b.change((x) => ({ ...x, elements: eraseAt(x.elements, path) }), "stroke");
    setDrag(next);
  };
  const end = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    b.endStroke();
    if (!d || !doc) return;
    if (d.tool === "select") {
      const click = d.a.x === d.b.x && d.a.y === d.b.y;
      if (click) {
        const hit = topAt(els, d.a.x, d.a.y);
        setSel((s) => {
          if (!hit) return d.additive ? s : new Set();
          if (!d.additive) return new Set([hit.id]);
          const n = new Set(s);
          if (n.has(hit.id)) n.delete(hit.id);
          else n.add(hit.id);
          return n;
        });
      } else {
        const r = rectOf(d.a, d.b);
        const inside = els.filter(
          (e) => intersects(e, r) && (e.kind === "seat" || (e.x >= r.x && e.y >= r.y && e.x + e.w <= r.x + r.w && e.y + e.h <= r.y + r.h)),
        );
        setSel((s) => new Set([...(d.additive ? s : []), ...inside.map((e) => e.id)]));
      }
    } else if (d.tool === "row") {
      b.change((x) => ({
        ...x,
        elements: addSeats(x.elements, lineCells(d.a, d.b), x.cols, x.rows),
      }));
    } else if (RECT[d.tool]) {
      const kind = RECT[d.tool] as FloorElement["kind"];
      const r = rectOf(d.a, d.b);
      const el = make(kind, r.x, r.y, {
        w: r.w,
        h: r.h,
        label: kind === "room" ? "Meeting room" : "",
      });
      if (blocked(els, el)) {
        toast.message("That area overlaps something — erase it first or drag over empty cells", { id: "place" });
        return;
      }
      b.change((x) => ({ ...x, elements: [...x.elements, el] }));
      if (kind === "room") {
        setSel(new Set([el.id]));
        setFocusLabel((n) => n + 1);
      }
    }
  };

  /* ---------- publish ---------- */

  const ensureSaved = useCallback(async () => {
    for (let i = 0; i < 20 && !b.isClean(); i++) {
      await b.flush();
      if (!b.isClean()) await new Promise((r) => setTimeout(r, 150));
    }
    if (!b.isClean()) throw new Error("Couldn’t save the draft — check your connection and try again.");
  }, [b]);

  /** Throw away unpublished changes: the draft becomes the live layout again. */
  const discard = async () => {
    setDiscarding(true);
    try {
      await b.flush();
      await floorsApi.discardDraft(floorId);
      await b.reload();
      await loadMeta();
      setSel(new Set());
      setDiscardOpen(false);
      toast.success("Changes discarded — back to the live layout");
      setTimeout(() => canvas.current?.fit(), 50);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn’t discard the changes");
    } finally {
      setDiscarding(false);
    }
  };

  const publish = () => {
    if (!doc || problems || !seatCount) return;
    void zone.execute({
      title: `Publish ${meta?.name ?? "floor"}`,
      done: `${meta?.name ?? "Floor"} is live`,
      noUndo: true,
      run: async ({ onConflict, dryRun }) => {
        await ensureSaved();
        const r = await floorsApi.publish(floorId, {
          expectedDraftVersion: b.draftVersion(),
          onConflict,
          dryRun,
        });
        return {
          id: "",
          dryRun: r.dryRun,
          seatsChanged: r.added + r.removed + r.changed,
          affected: r.affected,
          floors: [floorId],
        };
      },
      onDone: () => {
        void loadMeta();
        void b.reload();
      },
    });
  };

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector("[role=dialog]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) b.redo();
        else b.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        b.redo();
      } else if (mod && k === "a") {
        e.preventDefault();
        setSel(new Set(els.map((x) => x.id)));
      } else if (mod && k === "s") {
        e.preventDefault();
        void b.flush();
      } else if (mod && e.key === "Enter") {
        e.preventDefault();
        publish();
      } else if (mod) {
        return;
      } else if (e.key === "Escape") {
        if (sel.size) setSel(new Set());
        else setTool("select");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSel();
      } else if (e.key.startsWith("Arrow") && sel.size) {
        e.preventDefault();
        const n = e.shiftKey ? 5 : 1;
        nudge(e.key === "ArrowLeft" ? -n : e.key === "ArrowRight" ? n : 0, e.key === "ArrowUp" ? -n : e.key === "ArrowDown" ? n : 0);
      } else if (e.key === "?") {
        setKeysOpen(true);
      } else {
        const t = TOOLS.find((x) => x.key.toLowerCase() === k);
        if (t) setTool(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ---------- render ---------- */

  if (b.loadError)
    return (
      <EmptyState
        icon={CloudOff}
        title="Couldn’t open this floor"
        description={b.loadError}
        action={
          <Link href="/floors/manage" className={buttonClass("secondary", "md")}>
            Back to floors
          </Link>
        }
      />
    );
  if (!doc) return <Skeleton className="h-[60dvh] rounded-xl" />;

  const status = !meta
    ? null
    : meta.status === "draft"
      ? "Draft — not visible yet"
      : b.isClean() && !meta.hasUnpublishedChanges
        ? "Live"
        : "Live · unpublished changes";
  const overlay = (cs: number) => {
    if (!drag || drag.tool === "seat" || drag.tool === "erase") return null;
    if (drag.tool === "row") {
      const cells = lineCells(drag.a, drag.b);
      return cells.map((c) => (
        <div
          key={`${c.x},${c.y}`}
          className="pointer-events-none absolute rounded-md border-2 border-dashed border-accent bg-accent/10"
          style={{
            left: c.x * cs + 3,
            top: c.y * cs + 3,
            width: cs - 6,
            height: cs - 6,
          }}
        />
      ));
    }
    const r = rectOf(drag.a, drag.b);
    return (
      <div
        className={cn(
          "pointer-events-none absolute rounded-md border-2",
          drag.tool === "select" ? "border-accent bg-accent/10" : "border-dashed border-orange-400 bg-orange-100/50",
        )}
        style={{
          left: r.x * cs,
          top: r.y * cs,
          width: r.w * cs,
          height: r.h * cs,
        }}
      >
        {drag.tool !== "select" ? (
          <span className="absolute -top-5 left-0 rounded bg-neutral-900 px-1 text-[10px] text-white">
            {r.w}×{r.h}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid="floor-builder">
      <header className="flex flex-wrap items-center gap-2">
        <Link href="/floors/manage" className={buttonClass("ghost", "icon-sm")} aria-label="Back to floors">
          <ArrowLeft />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold text-neutral-900" data-testid="builder-title">
            {meta?.name ?? "Floor"}
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-neutral-500">
            {status ? <span data-testid="builder-status">{status}</span> : null}
            <SaveBadge state={b.save.state} at={b.save.at} error={b.save.error} onReload={() => void b.reload()} />
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Tip label="Undo (⌘Z)">
            <Button variant="ghost" size="icon-sm" onClick={b.undo} disabled={!b.canUndo} aria-label="Undo" data-testid="builder-undo">
              <Undo2 />
            </Button>
          </Tip>
          <Tip label="Redo (⇧⌘Z)">
            <Button variant="ghost" size="icon-sm" onClick={b.redo} disabled={!b.canRedo} aria-label="Redo" data-testid="builder-redo">
              <Redo2 />
            </Button>
          </Tip>
          <Tip label="Keyboard shortcuts (?)">
            <Button variant="ghost" size="icon-sm" onClick={() => setKeysOpen(true)} aria-label="Keyboard shortcuts">
              <Keyboard />
            </Button>
          </Tip>
        </div>
        {meta?.status === "published" && status !== "Live" ? (
          <Tip label="Go back to the live layout">
            <Button variant="ghost" size="md" onClick={() => setDiscardOpen(true)} data-testid="discard-draft">
              <RotateCcw /> Discard
            </Button>
          </Tip>
        ) : null}
        {meta?.status === "published" ? (
          <Link href={`/floors?floor=${floorId}`} className={buttonClass("secondary", "md")}>
            <Eye /> View live
          </Link>
        ) : null}
        <Button
          variant="primary"
          onClick={publish}
          disabled={problems > 0 || !seatCount || zone.busy !== null || b.save.state === "conflict"}
          title={problems ? "Fix the problems listed on the right first" : !seatCount ? "Add at least one seat" : "Publish (⌘↵)"}
          data-testid="publish-floor"
        >
          {zone.busy ? <Loader2 className="animate-spin" /> : <Rocket />} Publish
        </Button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-2">
          <div className="relative">
            <FloorCanvas
              ref={canvas}
              label={meta?.name ?? "Floor"}
              cols={doc.cols}
              rows={doc.rows}
              elements={doc.elements}
              colors={colors}
              teamName={(id) => teams[id]?.name ?? "Unknown team"}
              occupant={(id) => occ.get(id)}
              selected={sel}
              invalid={issues}
              mode="edit"
              noHoverCard
              onGridPointerDown={begin}
              onGridPointerMove={move}
              onGridPointerUp={end}
              overlay={overlay}
              testId="builder-canvas"
              hug={false}
              maxHeight="calc(100dvh - 15rem)"
              className={cn(tool === "select" ? "cursor-default" : "cursor-crosshair")}
            />
            <nav
              aria-label="Tools"
              className="scrollbar-none absolute bottom-3 left-3 z-20 flex max-w-[calc(100%-11rem)] items-center gap-0.5 overflow-x-auto rounded-full border border-black/[0.07] bg-white/90 p-1 shadow-[0_2px_10px_rgb(0_0_0/0.08)] backdrop-blur-md"
              data-testid="builder-palette"
            >
              {TOOLS.map((t) => (
                <Tip key={t.id} label={`${t.label} (${t.key}) — ${t.hint}`} side="top">
                  <button
                    type="button"
                    onClick={() => setTool(t.id)}
                    aria-pressed={tool === t.id}
                    aria-label={t.label}
                    data-tool={t.id}
                    className={cn(
                      "relative flex size-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-black/[0.05] hover:text-neutral-900",
                      tool === t.id && "bg-neutral-900 text-white hover:bg-neutral-800 hover:text-white",
                    )}
                  >
                    <t.icon className="size-4" />
                    <span className="sr-only">{t.key}</span>
                  </button>
                </Tip>
              ))}
            </nav>
          </div>
          <p className="text-[12px] text-neutral-500" data-testid="builder-hint">
            <span className="font-medium text-neutral-700">{TOOLS.find((t) => t.id === tool)?.label}:</span> {TOOLS.find((t) => t.id === tool)?.hint}.
            {tool === "select" ? " Assign the selection to a team on the right." : null}
          </p>
        </div>

        <Inspector
          doc={doc}
          selection={selection}
          colors={colors}
          issues={issues}
          focusLabel={focusLabel}
          onEdit={editSel}
          onDelete={deleteSel}
          onSelect={(ids) => {
            setTool("select");
            setSel(new Set(ids));
          }}
          onDoc={(fn) => b.change(fn)}
          onRenumber={() =>
            b.change((d) => ({
              ...d,
              elements: autoNumber(d.seatPrefix, d.elements, true),
            }))
          }
          onFit={() => b.change((d) => ({ ...d, ...fitGrid(d.elements) }))}
          onTemplate={() => setTemplateOpen(true)}
          onIssue={(id) => {
            const el = els.find((e) => e.id === id);
            if (!el) return;
            setTool("select");
            setSel(new Set([id]));
            canvas.current?.reveal(el.x, el.y);
          }}
        />
      </div>

      <Modal
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard unpublished changes?"
        description="The layout goes back to what everyone sees now. Live zones, seat numbers and seated people stay as they are."
      >
        <ModalFooter>
          <Button variant="ghost" onClick={() => setDiscardOpen(false)}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={() => void discard()} disabled={discarding} data-testid="discard-confirm">
            {discarding ? <Loader2 className="animate-spin" /> : null} Discard changes
          </Button>
        </ModalFooter>
      </Modal>

      <TemplateDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        replacing={els.length > 0}
        onApply={(n) => {
          const t = facingRowsTemplate(n);
          b.change((d: Doc) => ({
            ...d,
            cols: Math.max(t.cols, 4),
            rows: t.rows,
            elements: t.elements,
          }));
          setSel(new Set());
          setTemplateOpen(false);
          setTimeout(() => canvas.current?.fit(), 50);
        }}
      />
      <ShortcutsDialog open={keysOpen} onOpenChange={setKeysOpen} />
      {zone.dialog}
    </div>
  );
}

function SaveBadge({ state, at, error, onReload }: { state: string; at: string | null; error?: string; onReload: () => void }) {
  if (state === "saving" || state === "dirty")
    return (
      <span className="inline-flex items-center gap-1" data-testid="save-state" data-state="saving">
        <Loader2 className="size-3 animate-spin" /> Saving draft…
      </span>
    );
  if (state === "conflict")
    return (
      <span className="inline-flex items-center gap-1 text-amber-700" data-testid="save-state" data-state="conflict">
        Changed in another window.
        <button type="button" onClick={onReload} className="inline-flex items-center gap-0.5 font-medium underline">
          <RefreshCw className="size-3" /> Reload
        </button>
      </span>
    );
  if (state === "error")
    return (
      <span className="inline-flex items-center gap-1 text-red-600" data-testid="save-state" data-state="error">
        <CloudOff className="size-3" /> {error ?? "Not saved"} — retrying on your next change
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1" data-testid="save-state" data-state="saved">
      <Cloud className="size-3" /> Draft saved
      {at ? ` ${formatTimeAgo(at)}` : ""}
    </span>
  );
}

function TemplateDialog({
  open,
  onOpenChange,
  replacing,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  replacing: boolean;
  onApply: (n: number) => void;
}) {
  const [n, setN] = useState("17");
  const v = Number(n);
  const ok = Number.isInteger(v) && v >= 1 && v <= 60;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Start from template"
      description={`Two facing rows of desks around a centre block, with a door.${replacing ? " This replaces the current layout (you can undo)." : ""}`}
    >
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onApply(v);
        }}
      >
        <ModalBody>
          <Field id="tpl-n" label="Desks per row" error={ok ? undefined : "1–60"} hint={ok ? `${v * 2} seats` : undefined}>
            <input id="tpl-n" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value)} className={inputClass} autoFocus data-testid="template-n" />
          </Field>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ok} data-testid="template-apply">
            {replacing ? "Replace layout" : "Use template"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

const SHORTCUTS: [string, string[]][] = [
  ...TOOLS.map((t) => [t.label, [t.key]] as [string, string[]]),
  ["Undo", ["⌘", "Z"]],
  ["Redo", ["⇧", "⌘", "Z"]],
  ["Select everything", ["⌘", "A"]],
  ["Add to / remove from selection", ["⇧", "click"]],
  ["Delete selection", ["⌫"]],
  ["Nudge selection (5 cells)", ["←↑→↓", "⇧"]],
  ["Clear selection / back to Select", ["Esc"]],
  ["Save now", ["⌘", "S"]],
  ["Publish", ["⌘", "↵"]],
  ["Pan", ["Space", "drag"]],
  ["Zoom", ["⌘", "scroll"]],
];

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts">
      <ModalBody>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[13px]" data-testid="builder-shortcuts">
          {SHORTCUTS.map(([what, keys]) => (
            <div key={what} className="contents">
              <dt className="text-neutral-600">{what}</dt>
              <dd className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </ModalBody>
    </Modal>
  );
}
