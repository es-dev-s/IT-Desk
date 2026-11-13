"use client";

import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useShallow } from "zustand/react/shallow";
import { ApiError, api as http, type MemberInput } from "@/lib/api";
import { DEVICE_KINDS } from "@/lib/constants";
import type { DeviceKind, Member } from "@/lib/schemas";
import type { RulesState } from "@/lib/transfer-rules";
import { cn } from "@/lib/utils";
import { useSeatIndex, useTeams } from "@/store/selectors";
import { useUI } from "@/store/ui-store";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";
import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { SelectField } from "@/components/ui/select";
import { DEVICE_LABEL } from "@/components/ui/status";
import { TeamCombobox } from "@/components/teams/team-combobox";
import { SeatPicker } from "@/components/transfer/seat-picker";
import { LeadBadge } from "@/components/floors/lead-badge";
import { Checkbox } from "@/components/ui/checkbox";

const MAX_DEVICES = 12;
const ASSET_TAG = /^IT-[A-Z]{2}-\d{4}$/;
const EMPLOYEE_ID = /^[A-Za-z0-9._-]{1,32}$/;

const deviceRow = z.object({
  id: z.string().optional(),
  kind: z.enum(DEVICE_KINDS, "Choose a device type"),
  model: z.string().trim().min(2, "Enter the model (2–80 characters)").max(80, "Enter the model (2–80 characters)"),
  assetTag: z.string().trim().toUpperCase().regex(ASSET_TAG, "Asset tags look like IT-LP-0142"),
});

/** Mirrors the API's checks so most mistakes show inline before a round-trip. */
export const memberFormSchema = z
  .object({
    name: z.string().trim().min(2, "Enter a name (2–80 characters)").max(80, "Enter a name (2–80 characters)"),
    employeeId: z
      .string()
      .trim()
      .refine((v) => v === "" || EMPLOYEE_ID.test(v), "Use up to 32 letters, digits, dots, dashes or underscores"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email address"),
    designation: z.string().trim().min(2, "Enter a designation (2–80 characters)").max(80, "Enter a designation (2–80 characters)"),
    subGroup: z.string().trim().max(60, "Keep the group under 60 characters"),
    teamId: z.string().min(1, "Choose a team"),
    seatId: z.string().min(1).nullable(),
    isLead: z.boolean(),
    devices: z.array(deviceRow).max(MAX_DEVICES, `Add at most ${MAX_DEVICES} devices`),
  })
  .superRefine((v, ctx) => {
    const seen = new Map<string, number>();
    v.devices.forEach((d, i) => {
      const tag = d.assetTag.trim().toUpperCase();
      const first = seen.get(tag);
      if (first !== undefined) ctx.addIssue({ code: "custom", path: ["devices", i, "assetTag"], message: `Same tag as device ${first + 1}` });
      else seen.set(tag, i);
    });
  });

type Errors = Record<string, string | undefined>;
type DeviceDraft = { key: string; id?: string; kind: DeviceKind; model: string; assetTag: string };

let rowSeq = 0;
const newRow = (kind: DeviceKind = "laptop"): DeviceDraft => ({ key: `d${++rowSeq}`, kind, model: "", assetTag: "" });

const hueOf = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

/** Add or edit one member. Mounted once in the app shell; opened from the Members view. */
export function MemberDialog() {
  const { open, nonce, memberId } = useUI(useShallow((s) => s.memberDialog));
  const close = useUI((s) => s.closeMemberDialog);
  const editing = useWorkspace((s) => (memberId ? (s.members[memberId] ?? null) : null));
  const teamName = useWorkspace((s) => s.teams[s.currentTeamId]?.name ?? "this team");
  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? null : close())}
      title={editing ? `Edit ${editing.name}` : `Add a member to ${teamName}`}
      description={
        editing
          ? "Changes show up for everyone on this team right away."
          : "They appear on the floor plan for the team, its leads and IT immediately."
      }
      className="max-w-[640px]"
    >
      {nonce > 0 && (!memberId || editing) ? <MemberForm key={nonce} editing={editing} onDone={close} /> : null}
    </Modal>
  );
}

function MemberForm({ editing, onDone }: { editing: Member | null; onDone: () => void }) {
  const store = useWorkspaceApi();
  const { session } = useSession();
  const isAdmin = session.user.role === "admin";
  const teams = useTeams();
  const rules: RulesState = useWorkspace(
    useShallow((s) => ({
      currentTeamId: s.currentTeamId,
      teams: s.teams,
      members: s.members,
      memberIds: s.memberIds,
      floors: s.floors,
    })),
  );
  const subGroups = useWorkspace(
    useShallow((s) => [...new Set(s.memberIds.map((id) => s.members[id]?.subGroup).filter(Boolean))].sort()),
  );

  const [name, setName] = useState(editing?.name ?? "");
  const [employeeId, setEmployeeId] = useState(editing?.employeeId ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [designation, setDesignation] = useState(editing?.role ?? "");
  const [subGroup, setSubGroup] = useState(editing?.subGroup ?? "");
  const [teamId, setTeamId] = useState(editing?.teamId ?? rules.currentTeamId);
  const [seat, setSeat] = useState<string | null>(editing?.seatId ?? null);
  const [isLead, setIsLead] = useState(editing?.isLead ?? false);
  const index = useSeatIndex();
  const seatRef = seat ? index.get(seat) : undefined;
  // Lead status is admin-only (the API refuses it from anyone else).
  const canLead = isAdmin;
  // Who already leads the chosen team: flagged people plus team-lead accounts (deduped by name).
  const currentLeads = useMemo(() => {
    if (!canLead) return [];
    const names = rules.memberIds
      .map((id) => rules.members[id])
      .filter((m) => m && m.isLead && m.teamId === teamId && m.status === "active" && m.id !== editing?.id)
      .map((m) => m!.name);
    for (const l of teams.find((t) => t.id === teamId)?.leads ?? []) names.push(l.name);
    const self = editing?.name.trim().toLowerCase();
    return [...new Set(names)].filter((n) => n.trim().toLowerCase() !== self);
  }, [canLead, rules.memberIds, rules.members, teams, teamId, editing?.id, editing?.name]);
  const leadTaken = canLead && !editing?.isLead && currentLeads.length > 0;
  const [devices, setDevices] = useState<DeviceDraft[]>(() =>
    editing ? editing.devices.map((d) => ({ key: `d${++rowSeq}`, id: d.id, kind: d.kind, model: d.model, assetTag: d.assetTag })) : [],
  );
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);

  const canSeat = !editing || editing.status === "active";
  const draftId = editing?.id ?? "__new_member__";
  const draft = useMemo<Member>(
    () => ({
      id: draftId,
      name: name.trim() || "New member",
      email: "",
      employeeId: "",
      role: designation || "Member",
      subGroup: subGroup || "General",
      seat: null,
      seatId: editing?.seatId ?? null,
      floorId: null,
      isLead,
      teamId,
      status: "active",
      joinedAt: "2000-01-01",
      hue: editing?.hue ?? hueOf(name || "new"),
      version: 0,
      devices: [],
    }),
    [draftId, name, designation, subGroup, teamId, editing?.hue, editing?.seatId, isLead],
  );
  const team = teams.find((t) => t.id === teamId);

  const clear = (k: string) => setErrors((e) => (e[k] || e.form ? { ...e, [k]: undefined, form: undefined } : e));
  const setDevice = (key: string, patch: Partial<DeviceDraft>) => setDevices((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  /** Device errors are keyed by index; removing a row shifts them, so drop them all. */
  const dropDeviceErrors = () =>
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith("devices"))));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const parsed = memberFormSchema.safeParse({
      name,
      employeeId,
      email,
      designation,
      subGroup,
      teamId,
      seatId: canSeat ? seat : (editing?.seatId ?? null),
      isLead,
      devices: devices.map(({ id, kind, model, assetTag }) => ({ id, kind, model, assetTag })),
    });
    if (!parsed.success) {
      const errs: Errors = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path.join(".");
        errs[k] ??= issue.message;
      }
      setErrors(errs);
      const first = document.querySelector<HTMLElement>(`[data-field="${Object.keys(errs)[0]}"]`);
      first?.focus();
      return;
    }
    const v = parsed.data;
    const { isLead: lead, ...rest } = v;
    // Non-admins never send the flag, so the server keeps whatever is stored.
    const body: MemberInput = { ...rest, subGroup: v.subGroup || "General", ...(canLead ? { isLead: lead } : {}) };
    setSaving(true);
    setErrors({});
    try {
      const saved = editing ? await http.updateMember(editing.id, { ...body, expectedVersion: editing.version }) : await http.createMember(body);
      store.getState().applyMember(saved);
      void store.getState().refresh();
      toast.success(editing ? `Saved ${saved.name}` : `${saved.name} added`, {
        description: saved.seat ? `Seat ${saved.seat}${team && saved.teamId !== rules.currentTeamId ? ` · ${team.name}` : ""}` : "No desk yet — assign one any time.",
      });
      onDone();
    } catch (err) {
      setSaving(false);
      if (err instanceof ApiError) {
        if (err.fields && Object.keys(err.fields).length) {
          setErrors({ ...err.fields });
          return;
        }
        if (err.code === "stale_member") {
          void store.getState().refresh();
          setErrors({ form: "Someone else just changed this member. We loaded the latest — review and save again." });
          return;
        }
        if (err.isUnavailable && !editing) {
          setErrors({ form: "The server didn’t answer. Check the roster before trying again, in case the member was added." });
          return;
        }
        setErrors({ form: err.message });
        return;
      }
      setErrors({ form: "Something went wrong. Please try again." });
    }
  };

  const text = (
    id: string,
    key: string,
    label: string,
    value: string,
    set: (v: string) => void,
    opts: { optional?: boolean; hint?: string; max?: number; autoFocus?: boolean; type?: string; list?: string; placeholder?: string } = {},
  ) => (
    <Field id={id} label={label} optional={opts.optional} hint={opts.hint} error={errors[key]}>
      <input
        id={id}
        data-field={key}
        type={opts.type ?? "text"}
        value={value}
        list={opts.list}
        placeholder={opts.placeholder}
        onChange={(e) => {
          set(e.target.value);
          clear(key);
        }}
        autoComplete="off"
        spellCheck={false}
        maxLength={opts.max ?? 80}
        autoFocus={opts.autoFocus}
        aria-invalid={Boolean(errors[key]) || undefined}
        aria-describedby={`${id}-msg`}
        className={inputClass}
      />
    </Field>
  );

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex min-h-0 flex-1 flex-col" data-testid="member-form">
      <ModalBody className="space-y-5">
        <section aria-labelledby="mf-person" className="grid gap-x-4 sm:grid-cols-2">
          <h3 id="mf-person" className="sr-only">
            Person
          </h3>
          {text("mf-name", "name", "Full name", name, setName, { autoFocus: true, placeholder: "e.g. Asha Gurung" })}
          {text("mf-emp", "employeeId", "Employee ID", employeeId, setEmployeeId, { optional: true, max: 32, placeholder: "e.g. EMP-1042" })}
          {text("mf-role", "designation", "Designation", designation, setDesignation, { placeholder: "e.g. Support Engineer" })}
          {text("mf-group", "subGroup", "Group", subGroup, setSubGroup, { optional: true, max: 60, list: "mf-groups", hint: "Defaults to General." })}
          <datalist id="mf-groups">
            {subGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          {text("mf-email", "email", "Work email", email, setEmail, { optional: true, type: "email", max: 254 })}
          {isAdmin ? (
            <Field id="mf-team" label="Team" error={errors.teamId} hint={editing && teamId !== editing.teamId ? "Moves them to another team. For a tracked move with IT, use a transfer." : undefined}>
              <TeamCombobox
                id="mf-team"
                label="Team"
                value={teamId}
                onChange={(v) => {
                  setTeamId(v);
                  setSeat(null);
                  clear("teamId");
                  clear("seat");
                }}
                teams={teams}
                invalid={Boolean(errors.teamId)}
                placeholder="Choose a team"
                testId="member-team"
              />
            </Field>
          ) : (
            <Field id="mf-team-ro" label="Team" hint="Team leads add people to their own team.">
              <input id="mf-team-ro" value={team?.name ?? ""} readOnly className={cn(inputClass, "bg-neutral-50 text-neutral-600")} />
            </Field>
          )}
        </section>

        {canLead ? (
          <label className={cn("-mt-2 flex items-center gap-3 rounded-lg border border-line px-3 py-2.5", leadTaken ? "cursor-not-allowed bg-neutral-50" : "cursor-default hover:bg-neutral-50")} data-testid="member-is-lead">
            <Checkbox checked={isLead} className={leadTaken ? "pointer-events-none opacity-50" : undefined} onCheckedChange={(v) => { if (!leadTaken) setIsLead(Boolean(v)); }} label="Team lead" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-neutral-800">Team lead</span>
              <span className="block text-xs text-neutral-500">Shown with a crown on every floor plan and people list. One lead per team.</span>
            </span>
            {isLead ? <LeadBadge /> : null}
          </label>
        ) : null}
        {leadTaken ? (
          <p className="-mt-3 px-1 text-xs text-amber-800" data-testid="member-lead-note">
            This team already has a Team Lead assigned.
          </p>
        ) : null}

        <section aria-labelledby="mf-desk">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 id="mf-desk" className="text-[13px] font-medium text-neutral-800">
              Desk <span className="ml-1 text-xs font-normal text-neutral-400">Optional</span>
            </h3>
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <span className="tnum font-semibold text-neutral-900" data-testid="member-seat-value">
                {seatRef ? `Seat ${seatRef.code} · ${seatRef.floorName}` : seat ? "Saved seat" : "None"}
              </span>
              {seat && canSeat ? (
                <button
                  type="button"
                  onClick={() => {
                    setSeat(null);
                    clear("seat");
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-500 outline-none hover:bg-neutral-100 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-accent/35"
                >
                  <X className="size-3" aria-hidden />
                  Clear
                </button>
              ) : null}
            </div>
          </div>
          {canSeat && team ? (
            <SeatPicker
              rules={rules}
              destId={teamId}
              anyZone={isAdmin}
              claimNoZone={!isAdmin}
              colorByTeam
              internal
              movers={[draft]}
              seats={seat ? { [draftId]: seat } : {}}
              activeId={draftId}
              onPick={(s) => {
                setSeat((cur) => (cur === s ? null : s));
                clear("seat");
              }}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-[13px] text-neutral-500">
              {team ? "Only active members can hold a seat." : "Choose a team to see its floors."}
            </p>
          )}
          <p className={cn("mt-1.5 min-h-4 text-xs", errors.seat ? "text-red-600" : "text-neutral-500")} role={errors.seat ? "alert" : undefined}>
            {errors.seat ?? ""}
          </p>
        </section>

        <section aria-labelledby="mf-devices">
          <div className="mb-2 flex items-center justify-between">
            <h3 id="mf-devices" className="text-[13px] font-medium text-neutral-800">
              Devices <span className="tnum ml-1 text-xs font-normal text-neutral-400">{devices.length}/{MAX_DEVICES}</span>
            </h3>
            <Button
              size="sm"
              variant="ghost"
              disabled={devices.length >= MAX_DEVICES}
              onClick={() => {
                setDevices((list) => [...list, newRow(list.length === 0 ? "laptop" : "monitor")]);
                clear("devices");
              }}
              data-testid="member-add-device"
            >
              <Plus aria-hidden />
              Add device
            </Button>
          </div>
          {devices.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-[13px] text-neutral-500">
              No devices yet. Add laptops, monitors and other kit with their asset tags so IT can track them.
            </p>
          ) : (
            <ul className="space-y-2">
              {devices.map((d, i) => {
                const tagErr = errors[`devices.${i}.assetTag`];
                const modelErr = errors[`devices.${i}.model`];
                const kindErr = errors[`devices.${i}.kind`];
                return (
                  <li key={d.key} className="rounded-lg border border-line bg-subtle/60 p-2" data-testid="member-device-row">
                    <div className="grid grid-cols-[120px_1fr_130px_auto] items-start gap-2 max-sm:grid-cols-[1fr_auto]">
                      <SelectField
                        size="md"
                        className="w-full"
                        label={`Device ${i + 1} type`}
                        value={d.kind}
                        onValueChange={(kind) => {
                          setDevice(d.key, { kind: kind as DeviceKind });
                          clear(`devices.${i}.kind`);
                        }}
                        options={DEVICE_KINDS.map((k) => ({ value: k, label: DEVICE_LABEL[k] }))}
                      />
                      <input
                        aria-label={`Device ${i + 1} model`}
                        data-field={`devices.${i}.model`}
                        value={d.model}
                        placeholder="Model, e.g. ThinkPad T14"
                        onChange={(e) => {
                          setDevice(d.key, { model: e.target.value });
                          clear(`devices.${i}.model`);
                        }}
                        maxLength={80}
                        autoComplete="off"
                        aria-invalid={Boolean(modelErr) || undefined}
                        className={cn(inputClass, "max-sm:col-span-2 max-sm:row-start-2")}
                      />
                      <input
                        aria-label={`Device ${i + 1} asset tag`}
                        data-field={`devices.${i}.assetTag`}
                        value={d.assetTag}
                        placeholder="IT-LP-0142"
                        onChange={(e) => {
                          setDevice(d.key, { assetTag: e.target.value.toUpperCase() });
                          clear(`devices.${i}.assetTag`);
                        }}
                        maxLength={10}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={Boolean(tagErr) || undefined}
                        className={cn(inputClass, "tnum font-mono max-sm:col-span-2 max-sm:row-start-3")}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove device ${i + 1}`}
                        className="max-sm:col-start-2 max-sm:row-start-1"
                        onClick={() => {
                          setDevices((list) => list.filter((x) => x.key !== d.key));
                          dropDeviceErrors();
                        }}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                    {kindErr || modelErr || tagErr ? (
                      <p role="alert" className="mt-1.5 px-1 text-xs text-red-600">
                        {kindErr ?? modelErr ?? tagErr}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {errors.devices ? (
            <p role="alert" className="mt-1.5 text-xs text-red-600">
              {errors.devices}
            </p>
          ) : null}
        </section>

        {errors.form ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800">
            {errors.form}
          </p>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <Button onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving} data-testid="member-save">
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {editing ? "Save changes" : "Add member"}
        </Button>
      </ModalFooter>
    </form>
  );
}
