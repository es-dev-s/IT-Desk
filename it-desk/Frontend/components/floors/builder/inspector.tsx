"use client";

import {
  CircleAlert,
  TriangleAlert,
  CircleCheck,
  Crown,
  Eraser,
  Grid3x3,
  Hash,
  LayoutTemplate,
  Lock,
  LockOpen,
  Maximize2,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { GRID, GRID_HINT, outsideGrid } from "@/lib/floors";
import type { FloorElement } from "@/lib/schemas";
import { NO_TEAM_COLOR, type TeamColor } from "@/lib/team-colors";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { TeamCombobox } from "@/components/teams/team-combobox";
import { useTeams, useTeamsById } from "@/store/selectors";
import type { Doc } from "./use-builder-doc";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KIND_NAME: Record<FloorElement["kind"], string> = {
  seat: "seat",
  block: "block",
  void: "void",
  wall: "wall",
  door: "door",
  room: "room",
  label: "label",
};

type Props = {
  doc: Doc;
  selection: FloorElement[];
  colors: Record<string, TeamColor>;
  issues: Record<string, string>;
  focusLabel: number;
  onEdit: (ids: ReadonlySet<string>, fn: (e: FloorElement) => FloorElement) => void;
  onDelete: () => void;
  onSelect: (ids: string[]) => void;
  onDoc: (fn: (d: Doc) => Doc) => void;
  onRenumber: () => void;
  onFit: () => void;
  onTemplate: () => void;
  onIssue: (id: string) => void;
};

/** Right-hand panel: the selection's properties, or the floor's settings, zones and problems. */
export function Inspector(p: Props) {
  return (
    <aside
      className="space-y-4 rounded-xl border border-line bg-white p-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-8rem)] lg:overflow-auto"
      data-testid="builder-inspector"
    >
      {p.selection.length ? <SelectionPanel {...p} /> : <FloorPanel {...p} />}
      <Problems issues={p.issues} doc={p.doc} onIssue={p.onIssue} />
    </aside>
  );
}

function SelectionPanel({ selection, colors, onEdit, onDelete, focusLabel }: Props) {
  const teams = useTeams();
  const byId = useTeamsById();
  const [team, setTeam] = useState("");
  const seats = selection.filter((e) => e.kind === "seat");
  const seatIds = new Set(seats.map((e) => e.id));
  const kinds = Object.entries(
    selection.reduce<Record<string, number>>((m, e) => {
      m[e.kind] = (m[e.kind] ?? 0) + 1;
      return m;
    }, {}),
  );
  const zoneTeams = [...new Set(seats.map((s) => s.teamId))];
  const oneTeam = zoneTeams.length === 1 && zoneTeams[0] ? zoneTeams[0] : null;
  const allLead = seats.length > 0 && seats.every((s) => s.leadSeat);
  const single = selection.length === 1 ? selection[0] : null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[13px] font-semibold text-neutral-900" data-testid="builder-selection">
          {plural(selection.length, "item")} selected
        </h2>
        <p className="text-[12px] text-neutral-500">{kinds.map(([k, n]) => plural(n, KIND_NAME[k as FloorElement["kind"]])).join(" · ")}</p>
        {seats.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {zoneTeams.map((t) => (
              <span key={t ?? "none"} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-neutral-600">
                <span className="size-1.5 rounded-full" style={{ background: (t && colors[t]?.fill) || NO_TEAM_COLOR.fill }} aria-hidden />
                {t ? (byId[t]?.name ?? "Unknown team") : "No team"} {seats.filter((s) => s.teamId === t).length}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {single ? <SingleProps key={single.id} el={single} onEdit={onEdit} focusLabel={focusLabel} /> : null}
      {seats.length ? (
        <section className="space-y-2">
          <h3 className="text-[12px] font-medium text-neutral-500">
            Team zone <span className="font-normal text-neutral-400">· optional</span>
          </h3>
          <TeamCombobox teams={teams} value={team} onChange={setTeam} label="Team for the selected seats" placeholder="Choose a team" testId="builder-team" />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!team}
              onClick={() => onEdit(seatIds, (e) => ({ ...e, teamId: team, leadSeat: e.teamId === team ? e.leadSeat : false }))}
              data-testid="builder-assign"
            >
              Assign {plural(seats.length, "seat")}
            </Button>
            <Button
              size="sm"
              disabled={zoneTeams.every((t) => !t)}
              onClick={() => onEdit(seatIds, (e) => ({ ...e, teamId: null, leadSeat: false }))}
              data-testid="builder-unassign"
            >
              <Eraser /> Unassign
            </Button>
            <Button
              size="sm"
              disabled={!oneTeam}
              title={oneTeam ? undefined : "Select seats of one team"}
              onClick={() => onEdit(seatIds, (e) => ({ ...e, leadSeat: !allLead }))}
              data-testid="builder-lead"
            >
              <Crown className="text-amber-500" /> {allLead ? "Not a lead desk" : "Lead desk"}
            </Button>
          </div>
        </section>
      ) : null}

      <div className="flex items-center justify-between border-t border-line pt-3">
        <span className="text-[11px] text-neutral-400">
          <Kbd>Esc</Kbd> clear · <Kbd>⌫</Kbd> delete · arrows nudge
        </span>
        <Button size="sm" variant="danger" onClick={onDelete} data-testid="builder-delete">
          <Trash2 /> Delete
        </Button>
      </div>
    </div>
  );
}

function SingleProps({ el, onEdit, focusLabel }: { el: FloorElement; onEdit: Props["onEdit"]; focusLabel: number }) {
  const only = useMemo(() => new Set([el.id]), [el.id]);
  const [code, setCode] = useState(el.code);
  const [label, setLabel] = useState(el.label);
  const [was, setWas] = useState({ code: el.code, label: el.label });
  if (was.code !== el.code || was.label !== el.label) {
    setWas({ code: el.code, label: el.label });
    setCode(el.code);
    setLabel(el.label);
  }
  const labelRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusLabel && (el.kind === "label" || el.kind === "room")) {
      labelRef.current?.focus();
      labelRef.current?.select();
    }
  }, [focusLabel, el.kind]);
  const sized = el.kind === "block" || el.kind === "void" || el.kind === "room" || el.kind === "wall";
  return (
    <section className="space-y-3 border-t border-line pt-3">
      {el.kind === "seat" ? (
        <label className="block space-y-1">
          <span className="flex items-center justify-between text-[12px] font-medium text-neutral-500">
            Seat number
            <span className="inline-flex items-center gap-1 text-[11px] font-normal">
              {el.codeLocked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
              {el.codeLocked ? "Fixed" : "Auto"}
            </span>
          </span>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) =>
                setCode(
                  e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9-]/g, "")
                    .slice(0, 16),
                )
              }
              onBlur={() => code !== el.code && onEdit(only, (e) => ({ ...e, code, codeLocked: code !== "" }))}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              className={cn(inputClass, "tnum text-[15px] font-semibold")}
              inputMode="numeric"
              placeholder="Auto"
              data-testid="builder-code"
              aria-label="Seat number"
              spellCheck={false}
            />
            {el.codeLocked ? (
              <Button
                size="sm"
                variant="ghost"
                title="Back to automatic numbering"
                onClick={() => {
                  setCode("");
                  onEdit(only, (e) => ({ ...e, code: "", codeLocked: false }));
                }}
              >
                <Hash /> Auto
              </Button>
            ) : null}
          </div>
          <span className="text-[11px] text-neutral-400">Type any number — no team needed. Typed numbers stay when you renumber.</span>
        </label>
      ) : null}
      {el.kind === "label" || el.kind === "room" || el.kind === "door" ? (
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-neutral-500">{el.kind === "label" ? "Text" : "Name"}</span>
          <input
            ref={labelRef}
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label !== el.label && onEdit(only, (e) => ({ ...e, label: label.trim() }))}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            className={inputClass}
            placeholder={el.kind === "door" ? "Door" : el.kind === "room" ? "Meeting room" : "Washroom"}
            data-testid="builder-label"
          />
        </label>
      ) : null}
      {sized || el.kind === "label" ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberProp label="Width" value={el.w} min={1} onChange={(w) => onEdit(only, (e) => ({ ...e, w }))} />
          <NumberProp label="Height" value={el.h} min={1} onChange={(h) => onEdit(only, (e) => ({ ...e, h }))} />
        </div>
      ) : null}
      <p className="text-[11px] text-neutral-400">
        At column {el.x + 1}, row {el.y + 1}
      </p>
    </section>
  );
}

/**
 * Columns × rows, editable any time (also on live floors — changes go live on
 * publish). Growing is instant; shrinking past placed elements asks first and
 * never deletes anything: those elements stay and are flagged until moved.
 */
function GridSize({ doc, onDoc, onSelect }: { doc: Doc; onDoc: Props["onDoc"]; onSelect: Props["onSelect"] }) {
  const [pending, setPending] = useState<{ cols: number; rows: number; ids: string[] } | null>(null);
  const request = (cols: number, rows: number) => {
    const cut = outsideGrid(doc.elements, cols, rows);
    if (cut.length) setPending({ cols, rows, ids: cut.map((e) => e.id) });
    else {
      setPending(null);
      onDoc((d) => ({ ...d, cols, rows }));
    }
  };
  const shown = pending ?? { cols: doc.cols, rows: doc.rows };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <NumberProp
          label="Columns"
          hint={GRID_HINT.cols}
          value={shown.cols}
          min={GRID.minCols}
          max={GRID.maxCols}
          onChange={(cols) => request(cols, shown.rows)}
          testId="builder-cols"
        />
        <NumberProp
          label="Rows"
          hint={GRID_HINT.rows}
          value={shown.rows}
          min={GRID.minRows}
          max={GRID.maxRows}
          onChange={(rows) => request(shown.cols, rows)}
          testId="builder-rows"
        />
      </div>
      {pending ? (
        <div
          className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/70 p-2.5 text-[12px] text-amber-900"
          role="alert"
          data-testid="grid-shrink-warning"
        >
          <p className="flex gap-1.5">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              {pending.cols}×{pending.rows} would cut off {pending.ids.length === 1 ? "1 element" : `${pending.ids.length} elements`}. They’re kept, but you’ll
              need to move them back inside before publishing.
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const { cols, rows } = pending;
                setPending(null);
                onDoc((d) => ({ ...d, cols, rows }));
              }}
              data-testid="grid-shrink-confirm"
            >
              Resize anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSelect(pending.ids)} data-testid="grid-shrink-show">
              Show them
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)} data-testid="grid-shrink-cancel">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NumberProp({
  label,
  value,
  min,
  max = Infinity,
  hint,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  hint?: string;
  testId?: string;
  onChange: (v: number) => void;
}) {
  const [v, setV] = useState(String(value));
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    setV(String(value));
  }
  const commit = () => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n === value) return setV(String(value));
    const c = Math.min(max, Math.max(min, n));
    setV(String(c));
    if (c !== value) onChange(c);
  };
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between text-[12px] font-medium text-neutral-500">
        {label}
        {hint ? <span className="tnum text-[11px] font-normal text-neutral-400">{hint}</span> : null}
      </span>
      <input
        inputMode="numeric"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className={inputClass}
        aria-label={hint ? `${label} (${hint})` : undefined}
        data-testid={testId}
      />
    </label>
  );
}

function FloorPanel({ doc, colors, onDoc, onRenumber, onFit, onTemplate, onSelect }: Props) {
  const byId = useTeamsById();
  const seats = doc.elements.filter((e) => e.kind === "seat");
  const zones = Object.entries(
    seats.reduce<Record<string, string[]>>((m, s) => {
      if (s.teamId) (m[s.teamId] ??= []).push(s.id);
      return m;
    }, {}),
  ).sort((a, b) => b[1].length - a[1].length);
  const unzoned = seats.filter((s) => !s.teamId).length;
  const leads = seats.filter((s) => s.leadSeat).length;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[13px] font-semibold text-neutral-900">Layout</h2>
        <p className="text-[12px] text-neutral-500" data-testid="builder-stats">
          {plural(seats.length, "seat")} · {plural(zones.length, "team zone")} · {unzoned} without a team · {plural(leads, "lead desk")}
        </p>
      </div>
      {doc.elements.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-3 text-[12px] text-neutral-500">
          Empty floor. Paint seats with <Kbd>S</Kbd> or a row with <Kbd>R</Kbd> — or start from the template.
        </div>
      ) : null}
      <Button size="sm" className="w-full" onClick={onTemplate} data-testid="builder-template">
        <LayoutTemplate /> Start from template…
      </Button>

      <section className="space-y-2">
        <h3 className="text-[12px] font-medium text-neutral-500">Grid & numbering</h3>
        <GridSize doc={doc} onDoc={onDoc} onSelect={onSelect} />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={onRenumber}
            title="Number every seat 1, 2, 3… top row first, left to right; numbers you typed stay"
            data-testid="builder-renumber"
          >
            <WandSparkles /> Number seats 1…N
          </Button>
          <Button size="sm" variant="ghost" onClick={onFit}>
            <Maximize2 /> Fit grid
          </Button>
        </div>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[12px] font-medium text-neutral-500">Team zones</h3>
        {zones.length ? (
          <ul className="space-y-0.5">
            {zones.map(([t, ids]) => (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => onSelect(ids)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-neutral-700 hover:bg-neutral-50"
                  data-testid="builder-zone"
                >
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: colors[t]?.fill ?? NO_TEAM_COLOR.fill }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{byId[t]?.name ?? "Unknown team"}</span>
                  <span className="tabular-nums text-neutral-400">{ids.length}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-neutral-400">
            Select seats (drag a box with <Kbd>V</Kbd>) and assign them to a team.
          </p>
        )}
      </section>
      <div className="flex items-start gap-1.5 text-[11px] leading-5 text-neutral-400">
        <Grid3x3 className="mt-1 size-3 shrink-0" />
        <p>
          Hold <Kbd>Space</Kbd> and drag to pan, <Kbd>⌘</Kbd>+scroll to zoom. Press <Kbd>?</Kbd> for every shortcut.
        </p>
      </div>
    </div>
  );
}

function Problems({ issues, doc, onIssue }: { issues: Record<string, string>; doc: Doc; onIssue: (id: string) => void }) {
  const list = Object.entries(issues);
  const seats = doc.elements.some((e) => e.kind === "seat");
  if (!list.length)
    return (
      <p className="flex items-center gap-1.5 border-t border-line pt-3 text-[12px] text-emerald-700" data-testid="builder-valid">
        <CircleCheck className="size-4" /> {seats ? "Ready to publish" : "Add at least one seat"}
      </p>
    );
  return (
    <section className="space-y-1.5 border-t border-line pt-3" data-testid="builder-issues">
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-red-600">
        <CircleAlert className="size-4" /> {plural(list.length, "problem")} to fix before publishing
      </h3>
      <ul className="space-y-0.5">
        {list.slice(0, 12).map(([id, msg]) => (
          <li key={id}>
            <button type="button" onClick={() => onIssue(id)} className="w-full rounded-md px-1.5 py-1 text-left text-[12px] text-neutral-700 hover:bg-red-50">
              {msg}
            </button>
          </li>
        ))}
      </ul>
      {list.length > 12 ? <p className="text-[11px] text-neutral-400">+{list.length - 12} more</p> : null}
    </section>
  );
}
