"use client";

import { ArrowRight, Check, Info } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { compareSeats } from "@/lib/constants";
import { todayKey } from "@/lib/format";
import { formatDate } from "@/lib/format";
import type { Member, TransferDraft, TransferMode } from "@/lib/schemas";
import type { SeatRef } from "@/lib/floors";
import { seatLabel } from "@/lib/floors";
import { autoAssign, freeZoneSeats, validateTransfer, type RulesState } from "@/lib/transfer-rules";
import { useSeatIndex } from "@/store/selectors";
import { cn, pluralize } from "@/lib/utils";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";
import { useUI } from "@/store/ui-store";
import { notifyResult } from "@/components/undo-toast";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, inputClass } from "@/components/ui/field";
import { SearchField } from "@/components/ui/search-field";
import { TeamCombobox } from "@/components/teams/team-combobox";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetClose } from "@/components/ui/sheet";
import { DEVICE_ICON } from "@/components/ui/status";
import { SeatPicker } from "./seat-picker";

const STEPS = ["Members", "Destination", "Devices", "Review"] as const;

export function TransferSheet() {
  const { open, nonce, memberIds, mode } = useUI(useShallow((s) => s.transfer));
  const close = useUI((s) => s.closeTransfer);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => (next ? null : close())}
      title="New transfer"
      description="Move members to new seats or another team"
      className="max-w-[640px]"
      header={<span hidden />}
    >
      {nonce > 0 ? <TransferFlow key={nonce} initialIds={memberIds} initialMode={mode} onDone={close} /> : null}
    </Sheet>
  );
}

function useRulesState(): RulesState {
  return useWorkspace(
    useShallow((s) => ({
      currentTeamId: s.currentTeamId,
      teams: s.teams,
      members: s.members,
      memberIds: s.memberIds,
      floors: s.floors,
    })),
  );
}

function TransferFlow({
  initialIds,
  initialMode,
  onDone,
}: {
  initialIds: string[];
  initialMode: TransferMode;
  onDone: () => void;
}) {
  const api = useWorkspaceApi();
  const rules = useRulesState();
  const teams = useWorkspace((s) => s.teams);
  const teamIds = useWorkspace(useShallow((s) => s.teamIds));
  const clearSelection = useUI((s) => s.clearSelection);

  const eligible = useMemo(
    () =>
      rules.memberIds
        .map((id) => rules.members[id])
        .filter((m) => m.teamId === rules.currentTeamId && m.status === "active")
        .sort((a, b) => compareSeats(a.seat, b.seat)),
    [rules],
  );
  const eligibleIds = new Set(eligible.map((m) => m.id));

  const [step, setStep] = useState(initialIds.some((id) => eligibleIds.has(id)) ? 1 : 0);
  const [ids, setIds] = useState<string[]>(() => initialIds.filter((id) => eligibleIds.has(id)));
  const [mode, setMode] = useState<TransferMode>(initialMode);
  const [toTeamId, setToTeamId] = useState("");
  /** memberId → chosen seat id. */
  const [seats, setSeats] = useState<Record<string, string>>({});
  /** memberId → seat code being typed (until it matches a seat in the zone). */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const index = useSeatIndex();
  const code = (seatId: string | undefined) => (seatId ? (index.get(seatId)?.code ?? "") : "");
  const [excluded, setExcluded] = useState<Record<string, true>>({});
  const [effectiveDate, setEffectiveDate] = useState(todayKey);
  const [note, setNote] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [attempted, setAttempted] = useState<Record<number, boolean>>({});
  const [query, setQuery] = useState("");

  const selected = ids.map((id) => rules.members[id]).filter(Boolean);
  const draft: TransferDraft = {
    mode,
    toTeamId: mode === "internal" ? rules.currentTeamId : toTeamId,
    assignments: ids.map((memberId) => ({ memberId, toSeatId: seats[memberId] ?? "" })),
    devicesByMember: Object.fromEntries(
      selected.map((m) => [m.id, m.devices.filter((d) => !excluded[d.id]).map((d) => d.id)]),
    ),
    effectiveDate,
    note,
  };
  const errors = validateTransfer(rules, draft);
  const stepErrors = (s: number) =>
    Object.keys(errors).filter((k) =>
      s === 0 ? k === "assignments" : s === 1 ? k !== "assignments" || ids.length > 0 : false,
    );
  const shown = (key: string) => (attempted[step] ? errors[key] : undefined);
  const deviceTotal = Object.values(draft.devicesByMember).reduce((n, list) => n + list.length, 0);
  const destId = mode === "internal" ? rules.currentTeamId : toTeamId;
  const dest = teams[destId];

  const goNext = () => {
    if (step === 0 && ids.length === 0) return setAttempted((a) => ({ ...a, 0: true }));
    if (step === 1 && stepErrors(1).length > 0) return setAttempted((a) => ({ ...a, 1: true }));
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const [submitting, setSubmitting] = useState(false);
  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    const result = await api.getState().createTransfer(draft);
    setSubmitting(false);
    if (!result.ok) {
      setAttempted((a) => ({ ...a, 1: true }));
      setStep(1);
      notifyResult(api, result, { title: "" });
      return;
    }
    clearSelection();
    onDone();
    notifyResult(api, result, {
      title: `${result.ticket} sent to IT`,
      description: `${pluralize(result.members, "member")} · ${pluralize(result.devices, "device")} to move`,
    });
  };

  // The person currently being seated: the chosen one, else the first without a desk.
  const active = activeId && ids.includes(activeId) ? activeId : (ids.find((id) => !seats[id]) ?? ids[0] ?? null);

  /** Map click: free seat → give it to the active person; a chosen seat → clear it and focus its owner. */
  const pickSeat = (seatId: string) => {
    const owner = Object.entries(seats).find(([id, s]) => ids.includes(id) && s === seatId)?.[0];
    const dropTyped = (id: string) =>
      setTyped((x) => {
        const next = { ...x };
        delete next[id];
        return next;
      });
    if (owner) {
      const next = { ...seats };
      delete next[owner];
      setSeats(next);
      dropTyped(owner);
      setActiveId(owner);
      return;
    }
    if (!active) return;
    const next = { ...seats, [active]: seatId };
    setSeats(next);
    dropTyped(active);
    setActiveId(ids.find((id) => !next[id]) ?? active);
  };

  return (
    <>
      {/* Header */}
      <div className="shrink-0 border-b border-line px-6 pt-5">
        <div className="flex items-center justify-between">
          <p className="text-[15px] font-semibold tracking-[-0.01em]">New transfer</p>
          <SheetClose />
        </div>
        <ol className="mt-4 flex gap-6" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i === step ? "step" : undefined}>
              <button
                type="button"
                disabled={i > step}
                onClick={() => setStep(i)}
                className={cn(
                  "-mb-px flex h-9 items-center gap-2 border-b-2 text-[13px] font-medium outline-none transition-colors duration-150 focus-visible:text-accent-ink",
                  i === step ? "border-neutral-900 text-neutral-900" : "border-transparent",
                  i < step ? "text-neutral-600 hover:text-neutral-900" : i > step ? "text-neutral-400" : "",
                )}
              >
                <span
                  className={cn(
                    "grid size-[18px] place-items-center rounded-full text-[11px] tnum",
                    i < step ? "bg-accent text-white" : i === step ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-500",
                  )}
                >
                  {i < step ? <Check className="size-3" strokeWidth={3} aria-hidden /> : i + 1}
                </span>
                <span className={cn(i !== step && "hidden sm:inline")}>{label}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      {/* Body: fixed-height scroller; steps swap with a short fade, no exit animation */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div key={step} className="animate-step-in px-6 py-6">
          {step === 0 ? (
            <MembersStep
              eligible={eligible}
              ids={ids}
              setIds={setIds}
              query={query}
              setQuery={setQuery}
              error={attempted[0] && ids.length === 0 ? "Choose at least one member" : undefined}
            />
          ) : null}

          {step === 1 ? (
            <div className="space-y-8">
              <section>
                <h3 className="text-sm font-semibold">Where are they going?</h3>
                <Segmented
                  className="mt-3"
                  label="Transfer type"
                  value={mode}
                  onChange={(m) => {
                    setMode(m);
                    setSeats({});
                    setTyped({});
                  }}
                  options={[
                    { value: "internal", label: "New seat in team" },
                    { value: "team", label: "Another team" },
                  ]}
                />
                {mode === "team" ? (
                  <div className="mt-4">
                    <label htmlFor="to-team" className="mb-1.5 block text-[13px] font-medium text-neutral-800">
                      Destination team
                    </label>
                    <TeamCombobox
                      id="to-team"
                      label="Destination team"
                      value={toTeamId}
                      onChange={(id) => {
                        setToTeamId(id);
                        setSeats({});
                        setTyped({});
                      }}
                      teams={teamIds.filter((id) => id !== rules.currentTeamId).map((id) => teams[id])}
                      invalid={Boolean(shown("toTeamId"))}
                      placeholder="Search for a team"
                      meta={(t) => `${freeZoneSeats(rules, t.id).length} free seats`}
                      testId="transfer-team"
                    />
                    <p className="mt-2 min-h-4 text-xs text-red-600" role={shown("toTeamId") ? "alert" : undefined}>
                      {shown("toTeamId") ?? ""}
                    </p>
                  </div>
                ) : null}
              </section>

              {dest && (mode === "internal" || toTeamId) ? (
                <section>
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold">Assign seats</h3>
                      <p className="mt-0.5 text-[13px] text-neutral-500">
                        {zoneFloors(index, destId) || "No zone yet"} · Choose a person, then a free seat in {dest.name}’s zone.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const filled = autoAssign(rules, draft);
                        setTyped({});
                        setSeats(Object.fromEntries(filled.filter((a) => a.toSeatId).map((a) => [a.memberId, a.toSeatId])));
                      }}
                    >
                      Auto-assign
                    </Button>
                  </div>

                  <MoverList
                    movers={selected}
                    value={(id) => typed[id] ?? code(seats[id])}
                    chosen={(id) => Boolean(seats[id])}
                    active={active}
                    onActivate={setActiveId}
                    onType={(id, value) => {
                      setTyped((x) => ({ ...x, [id]: value }));
                      const hit = [...index.values()].find((s) => s.teamId === destId && s.code === value.trim());
                      setSeats((x) => {
                        const next = { ...x };
                        if (hit) next[id] = hit.id;
                        else delete next[id];
                        return next;
                      });
                    }}
                    errorFor={(i) => {
                      const id = ids[i];
                      const t = typed[id]?.trim();
                      if (t && !seats[id] && attempted[step]) return `No seat ${t} in ${dest.name}’s zone`;
                      return shown(`assignments.${i}.toSeat`) ?? shown(`assignments.${i}.memberId`);
                    }}
                  />

                  <div className="mt-4">
                    <SeatPicker
                      rules={rules}
                      destId={destId}
                      internal={mode === "internal"}
                      movers={selected}
                      seats={seats}
                      activeId={active}
                      onPick={pickSeat}
                    />
                  </div>
                </section>
              ) : null}

              <section className="grid gap-4 sm:grid-cols-[180px_1fr]">
                <Field id="tr-date" label="Effective date" error={shown("effectiveDate")}>
                  <input
                    id="tr-date"
                    type="date"
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    aria-invalid={Boolean(shown("effectiveDate"))}
                    className={cn(inputClass, "tnum")}
                  />
                </Field>
                <Field id="tr-note" label="Note for IT" optional error={shown("note")}>
                  <input
                    id="tr-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Second monitor stays at the old desk"
                    className={inputClass}
                  />
                </Field>
              </section>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold">Devices IT will move</h3>
                <p className="mt-0.5 text-[13px] text-neutral-500">Untick anything that should stay behind.</p>
              </div>
              {selected.map((m) => (
                <div key={m.id} className="rounded-lg border border-line">
                  <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
                    <Avatar name={m.name} hue={m.hue} size="xs" />
                    <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.name}</p>
                    <span className="tnum text-xs text-neutral-500">
                      {seatLabel(m.seat)} → {seatLabel(code(seats[m.id]))}
                    </span>
                  </div>
                  <ul>
                    {m.devices.map((d) => {
                      const Icon = DEVICE_ICON[d.kind];
                      const on = !excluded[d.id];
                      return (
                        <li key={d.id} className="flex h-10 items-center gap-3 px-3">
                          <Checkbox
                            checked={on}
                            label={`Move ${d.model}`}
                            onCheckedChange={(v) =>
                              setExcluded((x) => {
                                const next = { ...x };
                                if (v) delete next[d.id];
                                else next[d.id] = true;
                                return next;
                              })
                            }
                          />
                          <Icon className={cn("size-4", on ? "text-neutral-500" : "text-neutral-300")} />
                          <span className={cn("min-w-0 flex-1 truncate text-[13px]", on ? "text-neutral-800" : "text-neutral-400 line-through")}>
                            {d.model}
                          </span>
                          <span className="tnum font-mono text-xs text-neutral-500">{d.assetTag}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-6">
              <div>
                <p className="text-xs font-medium text-neutral-500">{mode === "internal" ? "Seat move" : "Team transfer"}</p>
                <h3 className="mt-1 text-lg font-semibold tracking-[-0.015em]">
                  {mode === "internal"
                    ? `Reseat ${pluralize(selected.length, "member")} on ${dest?.location.split(" · ")[1] ?? "the floor"}`
                    : `Move ${pluralize(selected.length, "member")} to ${dest?.name}`}
                </h3>
              </div>
              <dl className="grid grid-cols-3 divide-x divide-line rounded-lg border border-line">
                {[
                  ["Members", String(selected.length)],
                  ["Devices", String(deviceTotal)],
                  ["Effective", formatDate(effectiveDate)],
                ].map(([k, v]) => (
                  <div key={k} className="px-4 py-3">
                    <dt className="text-xs text-neutral-500">{k}</dt>
                    <dd className="tnum mt-1 text-[15px] font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {selected.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Avatar name={m.name} hue={m.hue} size="xs" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.name}</span>
                    <span className="tnum text-xs text-neutral-500">{pluralize(draft.devicesByMember[m.id]?.length ?? 0, "device")}</span>
                    <span className="tnum w-[150px] text-right text-[13px] text-neutral-800">
                      {seatLabel(m.seat)} <span className="text-neutral-300">→</span> {seatLabel(code(seats[m.id]))}
                    </span>
                  </li>
                ))}
              </ul>
              {note.trim() ? (
                <p className="rounded-lg bg-subtle px-3 py-2.5 text-[13px] text-neutral-600">“{note.trim()}”</p>
              ) : null}
              <p className="flex gap-2 text-[13px] text-neutral-500">
                <Info className="mt-0.5 size-4 shrink-0 text-neutral-400" aria-hidden />
                IT receives one ticket for this transfer. You can undo it until IT schedules the move.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-6 py-4">
        <p className="tnum truncate text-[13px] text-neutral-500">
          {pluralize(ids.length, "member")}
          {step >= 2 ? ` · ${pluralize(deviceTotal, "device")}` : ""}
        </p>
        <div className="flex gap-2">
          {step > 0 ? (
            <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={goNext}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void confirm()} disabled={submitting} aria-busy={submitting}>
              {submitting ? "Sending to IT…" : "Create request"}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

function MembersStep({
  eligible,
  ids,
  setIds,
  query,
  setQuery,
  error,
}: {
  eligible: { id: string; name: string; seat: string | null; hue: number; subGroup: string; devices: unknown[] }[];
  ids: string[];
  setIds: (ids: string[]) => void;
  query: string;
  setQuery: (q: string) => void;
  error?: string;
}) {
  const q = query.trim().toLowerCase();
  const rows = q ? eligible.filter((m) => `${m.name} ${m.seat} ${m.subGroup}`.toLowerCase().includes(q)) : eligible;
  const chosen = new Set(ids);
  const toggle = (id: string) => setIds(chosen.has(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">Who is moving?</h3>
          <p className={cn("mt-0.5 text-[13px]", error ? "text-red-600" : "text-neutral-500")}>
            {error ?? "Pick one or more people. Their devices move with them."}
          </p>
        </div>
        {ids.length ? (
          <Button size="sm" variant="ghost" onClick={() => setIds([])}>
            Clear
          </Button>
        ) : null}
      </div>
      <SearchField className="mt-4" value={query} onChange={setQuery} label="Search members" placeholder="Search by name or seat" />
      <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
        {rows.map((m) => (
          <li
            key={m.id}
            onClick={() => toggle(m.id)}
            className={cn("flex h-12 cursor-default items-center gap-3 px-3 transition-colors duration-150", chosen.has(m.id) ? "bg-accent-soft/60" : "hover:bg-neutral-50")}
          >
            <Checkbox checked={chosen.has(m.id)} onCheckedChange={() => toggle(m.id)} label={`Select ${m.name}`} />
            <span className="tnum w-16 text-[13px] font-medium text-neutral-900">{seatLabel(m.seat)}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">{m.name}</span>
            <span className="hidden truncate text-xs text-neutral-500 sm:block">{m.subGroup}</span>
          </li>
        ))}
        {rows.length === 0 ? <li className="px-3 py-8 text-center text-[13px] text-neutral-500">No one matches “{query}”.</li> : null}
      </ul>
    </div>
  );
}

/**
 * Who is being seated. A radio group (arrow keys move between people); the
 * typed seat box stays as a secondary, keyboard-first way to enter a desk.
 */
function MoverList({
  movers,
  value,
  chosen,
  active,
  onActivate,
  onType,
  errorFor,
}: {
  movers: Member[];
  value: (id: string) => string;
  chosen: (id: string) => boolean;
  active: string | null;
  onActivate: (id: string) => void;
  onType: (id: string, value: string) => void;
  errorFor: (index: number) => string | undefined;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + movers.length) % movers.length;
    onActivate(movers[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Person to seat" className="mt-4 divide-y divide-line overflow-hidden rounded-lg border border-line">
      {movers.map((m, i) => {
        const err = errorFor(i);
        const on = active === m.id;
        const seat = value(m.id);
        const ok = chosen(m.id);
        return (
          <div
            key={m.id}
            className={cn(
              "relative flex items-center gap-3 py-2 pl-3 pr-2 transition-colors duration-150",
              on ? "bg-accent-soft" : "hover:bg-neutral-50",
            )}
          >
            <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5 transition-opacity duration-150", on ? "bg-accent opacity-100" : "opacity-0")} />
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onActivate(m.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className="flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Avatar name={m.name} hue={m.hue} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-neutral-900">{m.name}</span>
                <span className={cn("block truncate text-xs", err ? "text-red-600" : "text-neutral-500")}>
                  {err ?? (ok ? `From ${seatLabel(m.seat, "no seat")}` : on ? "Pick a seat on the map" : `Now at ${seatLabel(m.seat, "no seat")}`)}
                </span>
              </span>
            </button>
            <span className="tnum hidden text-xs text-neutral-400 sm:inline">{seatLabel(m.seat)}</span>
            <ArrowRight className="hidden size-3.5 text-neutral-300 sm:block" aria-hidden />
            <input
              value={seat}
              onFocus={() => onActivate(m.id)}
              onChange={(e) => onType(m.id, e.target.value.toUpperCase().slice(0, 16))}
              placeholder="—"
              inputMode="text"
              autoComplete="off"
              aria-label={`New desk for ${m.name}`}
              aria-invalid={Boolean(err)}
              className={cn(
                inputClass,
                "tnum h-10 w-24 px-2 text-center font-mono text-[13px] font-semibold uppercase sm:h-9",
                ok && !err && "border-accent-line bg-white text-accent-ink",
              )}
            />
          </div>
        );
      })}
    </div>
  );
}

/** "Level 4, Level 3 (A)": the floors holding a team's zone. */
function zoneFloors(index: Map<string, SeatRef>, teamId: string) {
  const names: string[] = [];
  for (const s of index.values()) if (s.teamId === teamId && !names.includes(s.floorName)) names.push(s.floorName);
  return names.join(", ");
}
