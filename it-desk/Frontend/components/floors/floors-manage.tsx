"use client";

import { Building2, Copy, Eye, Loader2, Lock, MoreHorizontal, PencilLine, PencilRuler, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as DM from "@radix-ui/react-dropdown-menu";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, floorsApi } from "@/lib/api";
import { formatTimeAgo } from "@/lib/format";
import { GRID_HINT, gridSizeSchema } from "@/lib/floors";
import type { FloorSummary } from "@/lib/schemas";
import { onLive } from "@/lib/live-bus";
import { cn } from "@/lib/utils";
import { Button, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, inputClass } from "@/components/ui/field";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useFloorLayoutLocked, useTeamColors, useTeamsById } from "@/store/selectors";
import { useWorkspaceApi } from "@/store/workspace-provider";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

/** Admin: every floor (drafts too) with stats, plus create, duplicate, rename and delete. */
export function FloorsManage() {
  const router = useRouter();
  const ws = useWorkspaceApi();
  const locked = useFloorLayoutLocked();
  const [floors, setFloors] = useState<FloorSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FloorSummary | null>(null);
  const [copying, setCopying] = useState<FloorSummary | null>(null);
  const [deleting, setDeleting] = useState<FloorSummary | null>(null);

  const load = useCallback(
    () =>
      floorsApi.list().then(setFloors, (e: unknown) => {
        toast.error(errText(e));
        setFloors((f) => f ?? []);
      }),
    [],
  );
  useEffect(() => {
    void load();
    return onLive("floor", () => void load());
  }, [load]);

  const changed = async () => {
    await Promise.all([load(), ws.getState().refresh()]);
  };

  const totals = (floors ?? []).reduce((t, f) => ({ seats: t.seats + f.stats.seats, used: t.used + f.stats.occupied, zoned: t.zoned + f.stats.zoned }), {
    seats: 0,
    used: 0,
    zoned: 0,
  });

  return (
    <>
      <h1 className="sr-only">Manage floors</h1>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-neutral-500" data-testid="floors-totals">
            {floors
              ? `${floors.length} ${floors.length === 1 ? "floor" : "floors"} · ${totals.seats} seats · ${totals.used} taken · ${totals.seats - totals.zoned} not in a zone`
              : "Loading floors…"}
          </p>
        </div>
        <Link href="/floors" className={buttonClass("secondary", "md")}>
          <Eye /> View floors
        </Link>
        {locked ? null : (
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-floor">
            <Plus /> New floor
          </Button>
        )}
      </div>
      {locked ? (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-neutral-50 px-3 py-2 text-[13px] text-neutral-600" data-testid="layout-locked">
          <Lock className="size-4 shrink-0 text-neutral-400" aria-hidden />
          Floor layouts are locked. You can still rename floors, edit team zones and seat numbers, and seat people.
        </p>
      ) : null}

      {floors === null ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : floors.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No floors yet"
          description={
            locked
              ? "Floor layouts are locked, so new floors can’t be created here."
              : "Start from a template — two facing rows of desks around a centre block, with a door — and adjust it in the builder."
          }
          action={
            locked ? undefined : (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New floor
              </Button>
            )
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="floors-list">
          {floors.map((f) => (
            <FloorCard key={f.id} floor={f} onEdit={() => setEditing(f)} onCopy={() => setCopying(f)} onDelete={() => setDeleting(f)} />
          ))}
        </ul>
      )}

      <NewFloorDialog
        open={creating}
        onOpenChange={setCreating}
        nextLevel={Math.max(0, ...(floors ?? []).map((f) => f.level)) + 1}
        onCreated={(f) => {
          setCreating(false);
          void changed();
          router.push(`/floors/${f.id}/edit`);
        }}
      />
      <DetailsDialog floor={editing} onClose={() => setEditing(null)} onSaved={() => void changed()} />
      <DuplicateDialog
        floor={copying}
        onClose={() => setCopying(null)}
        onDone={(f) => {
          void changed();
          router.push(`/floors/${f.id}/edit`);
        }}
      />
      <DeleteDialog floor={deleting} onClose={() => setDeleting(null)} onDone={() => void changed()} />
    </>
  );
}

function FloorCard({ floor: f, onEdit, onCopy, onDelete }: { floor: FloorSummary; onEdit: () => void; onCopy: () => void; onDelete: () => void }) {
  const teams = useTeamsById();
  const colors = useTeamColors();
  const locked = useFloorLayoutLocked();
  const pct = f.stats.seats ? Math.round((f.stats.occupied / f.stats.seats) * 100) : 0;
  const zones = Object.entries(f.stats.byTeam).sort((a, b) => b[1] - a[1]);
  const status =
    f.status === "draft"
      ? { label: "Draft", cls: "bg-neutral-100 text-neutral-700" }
      : f.hasUnpublishedChanges && !locked
        ? { label: "Unpublished changes", cls: "bg-amber-100 text-amber-800" }
        : { label: "Live", cls: "bg-emerald-50 text-emerald-700" };
  return (
    <li className="flex flex-col rounded-xl border border-line bg-white p-4 shadow-xs" data-testid="floor-card" data-floor={f.name}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-neutral-900">{f.name}</h2>
          <p className="text-[12px] text-neutral-500">
            Level {f.level} · {f.stats.seats} {f.stats.seats === 1 ? "seat" : "seats"} · {f.cols}×{f.rows} grid · updated {formatTimeAgo(f.updatedAt)}
          </p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", status.cls)} data-testid="floor-status">
          {status.label}
        </span>
        <DM.Root>
          <DM.Trigger className={buttonClass("ghost", "icon-xs", "-mr-1")} aria-label={`More actions for ${f.name}`}>
            <MoreHorizontal />
          </DM.Trigger>
          <DM.Portal>
            <DM.Content align="end" sideOffset={4} className="z-50 min-w-44 rounded-xl border border-line bg-white p-1 shadow-overlay">
              <MenuItem onSelect={onEdit} icon={PencilLine} label="Rename & details" />
              {locked ? null : <MenuItem onSelect={onCopy} icon={Copy} label="Duplicate" />}
              <DM.Separator className="my-1 h-px bg-line" />
              <MenuItem onSelect={onDelete} icon={Trash2} label="Delete" danger />
            </DM.Content>
          </DM.Portal>
        </DM.Root>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Mini label="Seats" value={f.stats.seats} />
        <Mini label="Taken" value={f.stats.occupied} />
        <Mini label="Teams" value={zones.length} />
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-100" aria-label={`${pct}% taken`}>
        <div className="h-full rounded-full bg-neutral-900" style={{ width: `${pct}%` }} />
      </div>
      {zones.length ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {zones.slice(0, 6).map(([id, n]) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-neutral-600">
              <span className="size-1.5 rounded-full" style={{ background: colors[id]?.fill }} aria-hidden />
              {teams[id]?.name ?? "Unknown"} {n}
            </span>
          ))}
          {zones.length > 6 ? <span className="px-1 text-[11px] text-neutral-400">+{zones.length - 6}</span> : null}
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-neutral-400">No team zones yet</p>
      )}

      <div className="mt-auto flex gap-2 pt-4">
        {locked ? null : (
          <Link href={`/floors/${f.id}/edit`} className={buttonClass("secondary", "sm", "flex-1")} data-testid="floor-edit">
            <PencilRuler /> Edit layout
          </Link>
        )}
        {f.status === "published" ? (
          <Link href={`/floors?floor=${f.id}`} className={buttonClass(locked ? "secondary" : "ghost", "sm", locked ? "flex-1" : undefined)}>
            <Eye /> View
          </Link>
        ) : locked ? (
          <p className="flex items-center gap-1.5 text-[12px] text-neutral-400">
            <Lock className="size-3.5" aria-hidden /> Draft — layouts are locked
          </p>
        ) : null}
      </div>
    </li>
  );
}

function MenuItem({
  onSelect,
  icon: Icon,
  label,
  danger,
}: {
  onSelect: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  danger?: boolean;
}) {
  return (
    <DM.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-neutral-100",
        danger ? "text-red-600" : "text-neutral-800",
      )}
    >
      <Icon className="size-4" />
      {label}
    </DM.Item>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-neutral-50 py-1.5">
      <div className="text-[15px] font-semibold tabular-nums text-neutral-900">{value}</div>
      <div className="text-[11px] text-neutral-500">{label}</div>
    </div>
  );
}

function NewFloorDialog({
  open,
  onOpenChange,
  nextLevel,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  nextLevel: number;
  onCreated: (f: FloorSummary) => void;
}) {
  const [name, setName] = useState("");
  const [level, setLevel] = useState(String(nextLevel));
  const [start, setStart] = useState<"template" | "blank">("template");
  const [perRow, setPerRow] = useState("12");
  const [cols, setCols] = useState("24");
  const [rows, setRows] = useState("10");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setLevel(String(nextLevel));
      setErrors({});
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = "Give the floor a name";
    const lv = Number(level);
    if (!Number.isInteger(lv) || lv < -5 || lv > 200) errs.level = "A whole number";
    const n = Number(perRow);
    if (start === "template" && (!Number.isInteger(n) || n < 1 || n > 60)) errs.templateSeats = "1–60 desks per row";
    const grid = gridSizeSchema.safeParse({ cols, rows });
    if (start === "blank" && !grid.success) for (const i of grid.error.issues) errs[String(i.path[0])] ??= i.message;
    if (Object.keys(errs).length) return setErrors(errs);
    setBusy(true);
    try {
      const f = await floorsApi.create({
        name: name.trim(),
        level: lv,
        sortOrder: lv,
        seatPrefix: "",
        ...(start === "template" ? { template: "facing-rows" as const, templateSeats: n } : { cols: Number(cols), rows: Number(rows) }),
      });
      toast.success(`${f.name} created`, { description: "Adjust the layout, paint team zones, then publish." });
      onCreated(f);
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="New floor" description="It starts as a draft; nobody sees it until you publish.">
      <form onSubmit={submit} className="contents" data-testid="new-floor-dialog">
        <ModalBody className="space-y-1">
          <Field id="nf-name" label="Name" error={errors.name}>
            <input
              id="nf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              maxLength={60}
              placeholder="e.g. Level 4"
              autoFocus
              autoComplete="off"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="nf-level" label="Level" error={errors.level}>
              <input id="nf-level" inputMode="numeric" value={level} onChange={(e) => setLevel(e.target.value)} className={inputClass} />
            </Field>
            <p className="self-end pb-2 text-[12px] text-neutral-500">Seats are numbered 1, 2, 3… automatically; you can change any number later.</p>
          </div>
          <div className="pb-3">
            <Segmented
              label="Start from"
              value={start}
              onChange={setStart}
              options={[
                { value: "template", label: "Template" },
                { value: "blank", label: "Blank grid" },
              ]}
            />
          </div>
          {start === "template" ? (
            <Field
              id="nf-seats"
              label="Desks per row"
              error={errors.templateSeats}
              hint={`Two facing rows of ${Number(perRow) || 0} around a centre block, with a door.`}
            >
              <input
                id="nf-seats"
                inputMode="numeric"
                value={perRow}
                onChange={(e) => setPerRow(e.target.value)}
                className={inputClass}
                data-testid="template-seats"
              />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field id="nf-cols" label="Columns" error={errors.cols} hint={GRID_HINT.cols}>
                <input id="nf-cols" inputMode="numeric" value={cols} onChange={(e) => setCols(e.target.value)} className={inputClass} />
              </Field>
              <Field id="nf-rows" label="Rows" error={errors.rows} hint={GRID_HINT.rows}>
                <input id="nf-rows" inputMode="numeric" value={rows} onChange={(e) => setRows(e.target.value)} className={inputClass} />
              </Field>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy} data-testid="create-floor">
            {busy ? <Loader2 className="animate-spin" /> : null} Create & open builder
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function DetailsDialog({ floor, onClose, onSaved }: { floor: FloorSummary | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [level, setLevel] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [for_, setFor] = useState<string | null>(null);
  if ((floor?.id ?? null) !== for_) {
    setFor(floor?.id ?? null);
    if (floor) {
      setName(floor.name);
      setLevel(String(floor.level));
      setNotes(floor.notes);
      setErrors({});
    }
  }
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!floor) return;
    setBusy(true);
    try {
      const lv = Number(level);
      await floorsApi.update(floor.id, { name: name.trim(), level: lv, notes: notes.trim(), expectedVersion: floor.version });
      toast.success("Saved");
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={floor !== null} onOpenChange={(o) => !o && onClose()} title="Floor details">
      <form onSubmit={save} className="contents">
        <ModalBody className="space-y-1">
          <Field id="fd-name" label="Name" error={errors.name}>
            <input id="fd-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} maxLength={60} autoComplete="off" />
          </Field>
          <Field id="fd-level" label="Level" error={errors.level} hint="Floors are listed highest level first.">
            <input id="fd-level" inputMode="numeric" value={level} onChange={(e) => setLevel(e.target.value)} className={inputClass} />
          </Field>
          <Field id="fd-notes" label="Notes" optional error={errors.notes}>
            <input id="fd-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} maxLength={200} autoComplete="off" />
          </Field>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null} Save
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function DuplicateDialog({ floor, onClose, onDone }: { floor: FloorSummary | null; onClose: () => void; onDone: (f: FloorSummary) => void }) {
  const [name, setName] = useState("");
  const [keepZones, setKeepZones] = useState<"yes" | "no">("no");
  const [busy, setBusy] = useState(false);
  const [for_, setFor] = useState<string | null>(null);
  if ((floor?.id ?? null) !== for_) {
    setFor(floor?.id ?? null);
    if (floor) setName(`${floor.name} (copy)`);
  }
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!floor) return;
    setBusy(true);
    try {
      const f = await floorsApi.duplicate(floor.id, { name: name.trim(), keepZones: keepZones === "yes" });
      toast.success(`${f.name} created as a draft`);
      onClose();
      onDone(f);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={floor !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Duplicate floor"
      description="Copies the layout into a new draft. Nobody is seated on the copy."
    >
      <form onSubmit={go} className="contents">
        <ModalBody className="space-y-3">
          <Field id="dup-name" label="Name">
            <input id="dup-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} maxLength={60} autoComplete="off" />
          </Field>
          <Segmented
            label="Team zones"
            value={keepZones}
            onChange={setKeepZones}
            options={[
              { value: "no", label: "Layout only" },
              { value: "yes", label: "Keep team zones" },
            ]}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2}>
            {busy ? <Loader2 className="animate-spin" /> : null} Duplicate
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function DeleteDialog({ floor, onClose, onDone }: { floor: FloorSummary | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const del = async () => {
    if (!floor) return;
    setBusy(true);
    try {
      await floorsApi.remove(floor.id);
      toast.success(`${floor.name} deleted`);
      onClose();
      onDone();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={floor !== null}
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${floor?.name ?? "floor"}?`}
      description={
        floor?.stats.occupied
          ? `${floor.stats.occupied} people sit here. Move them first — a floor with people on it can’t be deleted.`
          : "The layout and its team zones are removed. This can’t be undone."
      }
    >
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => void del()} disabled={busy || Boolean(floor?.stats.occupied)} data-testid="confirm-delete-floor">
          {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete floor
        </Button>
      </ModalFooter>
    </Modal>
  );
}
