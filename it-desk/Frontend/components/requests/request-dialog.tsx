"use client";

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronsUpDown, Loader2, Minus, Plus, Search, Send, UserRound, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { ApiError } from "@/lib/api";
import { chatHref } from "@/lib/chat";
import {
  CATEGORY_HINT,
  CATEGORY_LABEL,
  EMPTY_REQUEST_FORM,
  ISSUE_CATEGORIES,
  KIND_HINT,
  KIND_LABEL,
  PRIORITY_LABEL,
  REQUEST_KINDS,
  REQUEST_LIMITS,
  REQUEST_PRIORITIES,
  formErrors,
  itemSummary,
  requestFormSchema,
  requestSummary,
  requestsApi,
  type IssueCategory,
  type RequestForm,
  type RequestKind,
  type RequestPriority,
  type RequestType,
} from "@/lib/requests";
import type { Member } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useTeams } from "@/store/selectors";
import { useRequests } from "@/store/requests-store";
import { useWorkspace } from "@/store/workspace-provider";
import { useSession } from "@/components/auth/session-provider";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, inputClass, textareaClass } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { TeamCombobox } from "@/components/teams/team-combobox";
import { CATEGORY_ICON, EQUIPMENT_ICON, ISSUE_ICON, KIND_ICON } from "./request-ui";
import { StaffPicker, useStaffList } from "./staff-picker";

type Item = { kind: RequestKind; quantity: number; description: string };

const ORG = "__org";

const TYPE_OPTIONS: { value: RequestType; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "equipment", label: "Request equipment", hint: "Laptop, headset, mouse or other kit", icon: EQUIPMENT_ICON },
  { value: "issue", label: "Report an issue", hint: "Something is broken or not working", icon: ISSUE_ICON },
];

/**
 * "Request IT": ask for equipment or report an issue (broken laptop, no
 * network, software or access problem). Mounted once in the shell; opened from
 * the topbar, the palette, the member sheet or `R`.
 */
export function RequestDialog() {
  const dialog = useRequests((s) => s.dialog);
  const closeDialog = useRequests((s) => s.closeDialog);
  return (
    <Modal
      open={dialog.open}
      onOpenChange={(open) => (open ? null : closeDialog())}
      title="Request IT"
      description="Get new equipment or report a problem. It goes straight to the IT queue."
      headerClassName="px-7 pt-7 max-sm:px-5 max-sm:pt-5"
      className={cn(
        // 920px reads as a workspace, not a form: room for a two-column body on wide screens.
        // Height follows the content, capped to the viewport; only the body scrolls.
        "max-w-[920px] sm:max-h-[min(880px,calc(100dvh-3rem))]",
        // Phone: bottom sheet that fills most of the screen and slides up.
        "max-sm:top-auto max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:max-h-[94dvh] max-sm:rounded-b-none",
        "max-sm:data-[state=open]:animate-sheet-up max-sm:data-[state=closed]:animate-sheet-down",
        // Grab handle so the sheet reads as a sheet on phones.
        "max-sm:before:mx-auto max-sm:before:mt-2 max-sm:before:-mb-3 max-sm:before:block max-sm:before:h-1 max-sm:before:w-9 max-sm:before:shrink-0 max-sm:before:rounded-full max-sm:before:bg-neutral-300 max-sm:before:content-['']",
      )}
    >
      <RequestFormBody key={dialog.nonce} initial={{ ...EMPTY_REQUEST_FORM, ...dialog.draft }} initialErrors={dialog.errors ?? {}} />
    </Modal>
  );
}

function RequestFormBody({ initial, initialErrors }: { initial: RequestForm; initialErrors: Record<string, string> }) {
  const { session, can } = useSession();
  const router = useRouter();
  const isAdmin = session.user.role === "admin";
  const teams = useTeams();
  const currentTeamId = useWorkspace((s) => s.currentTeamId);
  const members = useWorkspace(useShallow((s) => s.memberIds.map((id) => s.members[id]).filter((m) => m.status === "active")));
  const { closeDialog, openDialog, upsert, load, openDetail } = useRequests(
    useShallow((s) => ({ closeDialog: s.closeDialog, openDialog: s.openDialog, upsert: s.upsert, load: s.load, openDetail: s.openDetail })),
  );

  const [type, setType] = useState<RequestType>(initial.type);
  const [items, setItems] = useState<Item[]>(initial.items);
  const [category, setCategory] = useState<IssueCategory | "">(initial.category);
  const [title, setTitle] = useState(initial.title);
  const [device, setDevice] = useState(initial.device);
  const [notes, setNotes] = useState(initial.notes);
  const [priority, setPriority] = useState<RequestPriority>(initial.priority);
  const [teamId, setTeamId] = useState(isAdmin ? initial.teamId : (session.user.teamId ?? currentTeamId));
  const [forMemberId, setForMemberId] = useState(initial.forMemberId);
  const [staffId, setStaffId] = useState(initial.staffId);
  const { staff, loading: staffLoading } = useStaffList();
  const [errors, setErrors] = useState<Record<string, string>>(initialErrors);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const memberOptions = useMemo(
    () => members.filter((m) => (isAdmin ? !teamId || m.teamId === teamId : m.teamId === teamId)).sort((a, b) => a.name.localeCompare(b.name)),
    [members, isAdmin, teamId],
  );
  const teamsById = useMemo(() => Object.fromEntries(teams.map((t) => [t.id, t])), [teams]);

  const clearError = (...keys: string[]) =>
    setErrors((e) => {
      if (!keys.some((k) => k in e)) return e;
      const next = { ...e };
      for (const k of keys) delete next[k];
      return next;
    });

  const toggleKind = (kind: RequestKind) => {
    setItems((cur) => (cur.some((i) => i.kind === kind) ? cur.filter((i) => i.kind !== kind) : [...cur, { kind, quantity: 1, description: "" }]));
    clearError("items");
    if (kind === "other") clearError(...Object.keys(errors).filter((k) => k.startsWith("items.")));
  };
  const setQty = (kind: RequestKind, delta: number) =>
    setItems((cur) =>
      cur.map((i) => (i.kind === kind ? { ...i, quantity: Math.min(REQUEST_LIMITS.maxQuantity, Math.max(1, i.quantity + delta)) } : i)),
    );
  const other = items.find((i) => i.kind === "other");
  const otherIndex = items.findIndex((i) => i.kind === "other");
  const otherError = otherIndex >= 0 ? errors[`items.${otherIndex}.description`] : undefined;

  const pickTeam = (value: string) => {
    const next = value === ORG ? "" : value;
    setTeamId(next);
    if (forMemberId && members.find((m) => m.id === forMemberId)?.teamId !== next) setForMemberId("");
    clearError("teamId", "forMemberId");
  };
  const pickMember = (m: Member | null) => {
    setForMemberId(m?.id ?? "");
    if (m && isAdmin) setTeamId(m.teamId);
    clearError("forMemberId");
  };

  const isIssue = type === "issue";
  const pickType = (next: RequestType) => {
    setType(next);
    clearError("type", "items", "category", "title", "device", ...Object.keys(errors).filter((k) => k.startsWith("items.")));
  };
  const pickCategory = (c: IssueCategory) => {
    setCategory((cur) => (cur === c ? "" : c));
    clearError("category");
  };

  const submit = async () => {
    if (submitting) return;
    const draft: RequestForm = {
      type,
      items: isIssue ? [] : items,
      category: isIssue ? category : "",
      title: isIssue ? title : "",
      device: isIssue ? device : "",
      notes,
      priority,
      forMemberId,
      teamId: isAdmin ? teamId : "",
      staffId,
    };
    const parsed = requestFormSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(formErrors(parsed.error));
      // Focus the first invalid control once React has rendered the error state.
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>("[aria-invalid=true], [data-invalid=true] button")?.focus(),
      );
      return;
    }
    const v = parsed.data;
    setSubmitting(true);
    // Optimistic: close at once and confirm with the server's ticket number.
    closeDialog();
    const toastId = toast.loading(v.type === "issue" ? "Reporting your issue to IT…" : "Sending your request to IT…", {
      description: v.type === "issue" ? v.title : itemSummary(v.items),
    });
    try {
      const created = await requestsApi.create({
        type: v.type,
        items: v.type === "issue" ? [] : v.items.map((i) => ({ kind: i.kind, quantity: i.quantity, description: i.description })),
        ...(v.type === "issue" && v.category ? { category: v.category, title: v.title, device: v.device } : {}),
        notes: v.notes,
        priority: v.priority,
        ...(v.forMemberId ? { forMemberId: v.forMemberId } : {}),
        ...(isAdmin && v.teamId ? { teamId: v.teamId } : {}),
        ...(v.staffId ? { staffId: v.staffId } : {}),
      });
      upsert(created);
      void load(session.user.id, { silent: true });
      toast.success(`${created.ticket} sent to IT`, {
        id: toastId,
        description: `${requestSummary(created)} · ${PRIORITY_LABEL[created.priority]} priority`,
        // Straight into the conversation with whoever it was routed to; or just view it.
        ...(can("requests.comment")
          ? {
              action: { label: created.staffName ? `Message ${created.staffName.split(" ")[0]}` : "Message IT", onClick: () => router.push(chatHref(created.id)) },
              cancel: { label: "View", onClick: () => openDetail(created.id) },
            }
          : { action: { label: "View", onClick: () => openDetail(created.id) } }),
      });
    } catch (err) {
      const fields = err instanceof ApiError ? (err.fields ?? {}) : {};
      toast.error(v.type === "issue" ? "Issue not reported" : "Request not sent", {
        id: toastId,
        description: err instanceof ApiError ? err.message : "Something went wrong. Everything you typed is still in the form.",
      });
      // Bring the form back exactly as it was, with the server's field errors.
      openDialog(draft, fields);
    }
  };

  const notesLength = notes.trim().length;
  const hasErrors = Object.keys(errors).length > 0;
  const selectedMember = forMemberId ? members.find((m) => m.id === forMemberId) : undefined;
  const forLabel = selectedMember
    ? `For ${selectedMember.name}`
    : isAdmin
      ? teamId
        ? `${teamsById[teamId]?.name ?? "Team"} team`
        : "Organisation-wide"
      : "For your team";
  const assignee = staffId ? staff.find((s) => s.id === staffId) : undefined;
  const summary = isIssue
    ? category
      ? `${CATEGORY_LABEL[category]} issue${title.trim() ? ` · ${title.trim()}` : ""}`
      : ""
    : items.length
      ? itemSummary(items)
      : "";

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
      }}
      data-testid="request-form"
    >
      <div className="scrollbar-thin flex-1 overflow-y-auto px-7 pb-7 pt-3 max-sm:px-5 max-sm:pb-6">
        <TypeChooser value={type} onChange={pickType} />

        {/* Wide screens: the request on the left, a compact rail for urgency and routing on the right. */}
        <div className="mt-7 grid gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1fr)_288px]">
          <div className="min-w-0 space-y-7">
            {/* What */}
            <Section id="req-what" title={isIssue ? "What kind of problem is it?" : "What do you need?"} aside={isIssue ? "Pick one" : "Pick one or more"}>
              {isIssue ? (
                <ChoiceGrid label="Issue category" invalid={Boolean(errors.category)}>
                  {ISSUE_CATEGORIES.map((c) => (
                    <ChoiceCard
                      key={c}
                      kind="radio"
                      selected={category === c}
                      onToggle={() => pickCategory(c)}
                      icon={CATEGORY_ICON[c]}
                      label={CATEGORY_LABEL[c]}
                      hint={CATEGORY_HINT[c]}
                      wide={c === "other"}
                      testId={`issue-category-${c}`}
                    />
                  ))}
                </ChoiceGrid>
              ) : (
                <ChoiceGrid label="Equipment" invalid={Boolean(errors.items)}>
                  {REQUEST_KINDS.map((kind) => {
                    const item = items.find((i) => i.kind === kind);
                    return (
                      <ChoiceCard
                        key={kind}
                        kind="toggle"
                        selected={Boolean(item)}
                        onToggle={() => toggleKind(kind)}
                        icon={KIND_ICON[kind]}
                        label={KIND_LABEL[kind]}
                        hint={KIND_HINT[kind]}
                        wide={kind === "other"}
                        testId={`request-kind-${kind}`}
                      >
                        {item ? (
                          <Stepper
                            label={KIND_LABEL[kind]}
                            value={item.quantity}
                            onDec={() => setQty(kind, -1)}
                            onInc={() => setQty(kind, 1)}
                            kind={kind}
                          />
                        ) : null}
                      </ChoiceCard>
                    );
                  })}
                </ChoiceGrid>
              )}
              <InlineError message={isIssue ? errors.category : errors.items} />
            </Section>

            {/* Details */}
            <Section id="req-details" title={isIssue ? "Describe the problem" : "Add details"}>
              <div className="space-y-4">
                {isIssue ? (
                  <div className="grid gap-x-3 gap-y-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                    <Field id="req-title" label="Short title" error={errors.title} hint="A few words IT will see in the queue">
                      <input
                        id="req-title"
                        className={inputClass}
                        value={title}
                        maxLength={REQUEST_LIMITS.maxTitle}
                        aria-invalid={errors.title ? true : undefined}
                        aria-describedby="req-title-msg"
                        placeholder="e.g. Laptop won’t turn on"
                        onChange={(e) => {
                          setTitle(e.target.value);
                          clearError("title");
                        }}
                        data-testid="issue-title"
                      />
                    </Field>
                    <Field id="req-device" label="Device" optional error={errors.device} hint="Asset tag or model">
                      <input
                        id="req-device"
                        className={inputClass}
                        value={device}
                        maxLength={REQUEST_LIMITS.maxDevice}
                        aria-invalid={errors.device ? true : undefined}
                        aria-describedby="req-device-msg"
                        placeholder="e.g. LT-0423"
                        onChange={(e) => {
                          setDevice(e.target.value);
                          clearError("device");
                        }}
                        data-testid="issue-device"
                      />
                    </Field>
                  </div>
                ) : other ? (
                  <Field id="req-other" label="What’s the other item?" error={otherError} hint="e.g. USB-C dock, monitor arm, software licence" className="animate-step-in">
                    <input
                      id="req-other"
                      autoFocus
                      className={inputClass}
                      value={other.description}
                      maxLength={REQUEST_LIMITS.maxDescription}
                      aria-invalid={otherError ? true : undefined}
                      aria-describedby="req-other-msg"
                      placeholder="Describe the item"
                      onChange={(e) => {
                        const description = e.target.value;
                        setItems((cur) => cur.map((i) => (i.kind === "other" ? { ...i, description } : i)));
                        clearError(`items.${otherIndex}.description`);
                      }}
                      data-testid="request-other-description"
                    />
                  </Field>
                ) : null}

                <Field
                  id="req-notes"
                  label={isIssue ? "What’s happening?" : "Notes for IT"}
                  error={errors.notes}
                  hint={isIssue ? "When it started, what you’ve tried, any error message" : "Who it’s for and when you need it"}
                >
                  <div className="relative">
                    <textarea
                      id="req-notes"
                      rows={3}
                      className={cn(textareaClass, "min-h-[92px] pb-6")}
                      value={notes}
                      maxLength={REQUEST_LIMITS.maxNotes}
                      aria-invalid={errors.notes ? true : undefined}
                      aria-describedby="req-notes-msg req-notes-count"
                      placeholder={
                        isIssue
                          ? "e.g. Black screen since this morning’s update. Restarting didn’t help."
                          : "e.g. New joiner starts Monday and needs a laptop and headset."
                      }
                      onChange={(e) => {
                        setNotes(e.target.value);
                        clearError("notes");
                      }}
                      data-testid="request-notes"
                    />
                    <span
                      id="req-notes-count"
                      className={cn(
                        "tnum pointer-events-none absolute bottom-2 right-3 text-[11px]",
                        notesLength > REQUEST_LIMITS.maxNotes - 50 ? "text-amber-700" : "text-neutral-400",
                      )}
                    >
                      {notesLength < REQUEST_LIMITS.minNotes ? `${REQUEST_LIMITS.minNotes - notesLength} more to go` : `${notesLength}/${REQUEST_LIMITS.maxNotes}`}
                    </span>
                  </div>
                </Field>
              </div>
            </Section>
          </div>

          <aside
            aria-labelledby="req-routing-title"
            className="space-y-5 max-lg:border-t max-lg:border-line max-lg:pt-7 lg:sticky lg:top-0 lg:self-start lg:rounded-2xl lg:bg-neutral-50 lg:p-5 lg:ring-1 lg:ring-inset lg:ring-line"
            data-testid="request-rail"
          >
            <div>
              <h3 id="req-routing-title" className="text-[13.5px] font-semibold tracking-[-0.005em] text-neutral-900">
                Assignment and priority
              </h3>
              <p className="mt-0.5 text-xs leading-4 text-neutral-500">All optional — the defaults suit most requests.</p>
            </div>
            <Field
              id="req-staff"
              label="Assign to"
              optional
              error={errors.staffId}
              hint={assignee ? `${assignee.name} will see it first; anyone in IT can still help.` : "Leave as “Anyone in IT” if you’re not sure."}
            >
              <StaffPicker
                id="req-staff"
                value={staffId}
                onChange={(v) => {
                  setStaffId(v);
                  clearError("staffId");
                }}
                staff={staff}
                loading={staffLoading}
                invalid={Boolean(errors.staffId)}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span id="req-priority-label" className="text-[13px] font-medium text-neutral-800">
                Priority
              </span>
              <Segmented
                size="md"
                label="Priority"
                className="w-full [&>button]:flex-1 [&>button]:justify-center"
                value={priority}
                onChange={setPriority}
                options={REQUEST_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
              />
              <p className="min-h-4 text-xs leading-4 text-neutral-500">{PRIORITY_HINT[priority]}</p>
            </div>

            <div className={cn("grid gap-x-3 gap-y-4", isAdmin && "sm:max-lg:grid-cols-2")}>
              {isAdmin ? (
                <Field id="req-team" label="Team" optional error={errors.teamId} hint="Organisation-wide if it’s not for a team">
                  <TeamCombobox
                    id="req-team"
                    label="Team"
                    value={teamId || ORG}
                    onChange={pickTeam}
                    teams={teams}
                    extras={[{ value: ORG, label: "Organisation-wide", hint: "Not tied to a team" }]}
                    testId="request-team"
                  />
                </Field>
              ) : null}
              <Field
                id="req-member"
                label={isIssue ? "Who’s affected?" : "Who’s it for?"}
                optional
                error={errors.forMemberId}
                hint={forMemberId ? undefined : isIssue ? "Leave empty if it’s you or the whole team" : "Leave empty if it’s for you or the team"}
              >
                <MemberCombobox
                  members={memberOptions}
                  value={forMemberId}
                  onChange={pickMember}
                  invalid={Boolean(errors.forMemberId)}
                  teamLabel={isAdmin && !teamId ? (m) => teamsById[m.teamId]?.code ?? "" : undefined}
                />
              </Field>
            </div>

          </aside>
        </div>
      </div>

      {/* Sticky footer: what will be sent + the one primary action. */}
      <div className="flex items-center gap-3 border-t border-line bg-white px-7 py-4 max-sm:px-5 max-sm:py-3.5 max-sm:pb-[max(0.875rem,env(safe-area-inset-bottom))]">
        <div className="min-w-0 flex-1" aria-live="polite" data-testid="request-summary">
          <p className={cn("truncate text-[13px] font-medium", summary ? "text-neutral-900" : "text-neutral-400")}>
            {summary || (isIssue ? "Pick a category to start" : "Pick what you need to start")}
          </p>
          <p className={cn("truncate text-xs", hasErrors ? "text-red-600" : "text-neutral-500")}>
            {hasErrors ? "Fix the highlighted fields to continue" : `${PRIORITY_LABEL[priority]} priority · ${forLabel} · ${assignee ? `To ${assignee.name}` : "Anyone in IT"}`}
          </p>
        </div>
        <Button onClick={closeDialog} className="max-sm:hidden">
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={submitting}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          title="Ctrl/⌘ + Enter"
          className="shrink-0"
          data-testid="request-submit"
        >
          {submitting ? <Loader2 className="animate-spin" aria-hidden /> : isIssue ? <ISSUE_ICON aria-hidden /> : <Send aria-hidden />}
          {isIssue ? "Report issue" : "Submit request"}
        </Button>
      </div>
    </form>
  );
}

const PRIORITY_HINT: Record<RequestPriority, string> = {
  low: "Whenever IT has a moment.",
  normal: "Handled in the usual order.",
  high: "Needed within a day.",
  urgent: "Someone can’t work right now.",
};

/** The first, most important choice: two large radio cards. Arrow keys move between them. */
function TypeChooser({ value, onChange }: { value: RequestType; onChange: (v: RequestType) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="radiogroup" aria-label="What would you like to do?" className="grid grid-cols-2 gap-2.5">
      {TYPE_OPTIONS.map((o, i) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const next = (i + d + TYPE_OPTIONS.length) % TYPE_OPTIONS.length;
              onChange(TYPE_OPTIONS[next].value);
              refs.current[next]?.focus();
            }}
            className={cn(
              "relative flex items-center gap-3.5 rounded-xl border px-4 py-3.5 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150 max-sm:flex-col max-sm:gap-2.5 max-sm:p-3",
              "focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1",
              active ? "border-accent bg-accent-soft/50 shadow-xs ring-1 ring-accent" : "border-line-strong bg-white hover:border-neutral-300 hover:bg-neutral-50/70",
            )}
            data-testid={`request-type-${o.value}`}
          >
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-lg transition-colors duration-150 max-sm:size-8",
                active ? "bg-accent text-white" : "bg-neutral-100 text-neutral-600",
              )}
            >
              <Icon className="size-[18px]" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 pr-5 max-sm:pr-0">
              <span className="block text-[13.5px] font-semibold leading-5 max-sm:text-[13px] text-neutral-900">{o.label}</span>
              <span className="mt-0.5 block text-xs leading-4 text-neutral-500">{o.hint}</span>
            </span>
            <RadioDot checked={active} className="absolute right-3 top-3" />
          </button>
        );
      })}
    </div>
  );
}

function RadioDot({ checked, className, square = false }: { checked: boolean; className?: string; square?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 place-items-center border transition-colors duration-150",
        square ? "rounded-[5px]" : "rounded-full",
        checked ? "border-accent bg-accent text-white" : "border-neutral-300 bg-white",
        className,
      )}
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

/** Quiet section heading: title, optional note on the right, no rules or step numbers. */
function Section({ id, title, aside, children }: { id: string; title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`}>
      <div className="mb-3 flex items-baseline gap-3">
        <h3 id={`${id}-title`} className="text-[13.5px] font-semibold tracking-[-0.005em] text-neutral-900">
          {title}
        </h3>
        {aside ? <span className="ml-auto shrink-0 text-xs text-neutral-400">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function ChoiceGrid({ label, invalid, children }: { label: string; invalid: boolean; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3" data-invalid={invalid || undefined}>
      {children}
    </div>
  );
}

function InlineError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-2 animate-step-in text-xs leading-4 text-red-600" role="alert">
      {message}
    </p>
  );
}

/**
 * One option card (equipment kind or issue category). The whole card is the
 * toggle; `children` (the quantity stepper) replaces the hint once selected,
 * so cards never change size.
 */
function ChoiceCard({
  kind,
  selected,
  onToggle,
  icon: Icon,
  label,
  hint,
  wide,
  testId,
  children,
}: {
  kind: "toggle" | "radio";
  selected: boolean;
  onToggle: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  wide?: boolean;
  testId: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative flex h-[100px] flex-col rounded-xl border bg-white px-3.5 pb-2 pt-3.5 shadow-xs transition-[border-color,background-color,box-shadow] duration-150",
        "has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-accent/40",
        selected ? "border-accent bg-accent-soft/50 ring-1 ring-accent" : "border-line-strong hover:border-neutral-300 hover:bg-neutral-50/70",
        wide && "col-span-2",
      )}
      data-testid={testId}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        {...(kind === "radio" ? { role: "radio", "aria-checked": selected } : { "aria-pressed": selected })}
        aria-label={`${label}: ${hint}`}
        onClick={onToggle}
        className="absolute inset-0 rounded-xl outline-none"
      />
      <span className="pointer-events-none flex items-start justify-between">
        <span
          className={cn(
            "grid size-8 place-items-center rounded-lg transition-colors duration-150",
            selected ? "bg-accent text-white" : "bg-neutral-100 text-neutral-600 group-hover:bg-neutral-200/70",
          )}
        >
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <RadioDot checked={selected} square={kind === "toggle"} />
      </span>
      <span className="pointer-events-none mt-auto block text-[13px] font-semibold leading-5 text-neutral-900">{label}</span>
      {/* Fixed-height slot: hint, or the stepper once selected, so labels line up across cards. */}
      <span className="flex h-6 items-center">
        {children ?? <span className="pointer-events-none block truncate text-xs leading-4 text-neutral-500" title={hint}>{hint}</span>}
      </span>
    </div>
  );
}

function Stepper({ label, value, onDec, onInc, kind }: { label: string; value: number; onDec: () => void; onInc: () => void; kind: string }) {
  const btn =
    "grid size-5 place-items-center rounded text-neutral-600 outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30";
  return (
    <span className="relative z-10 inline-flex h-6 w-fit items-center gap-1.5 rounded-md border border-line bg-white px-0.5 shadow-xs">
      <button type="button" aria-label={`Fewer ${label}`} disabled={value <= 1} onClick={onDec} className={btn}>
        <Minus className="size-3" aria-hidden />
      </button>
      <span className="tnum min-w-3 text-center text-xs font-semibold text-neutral-900" aria-live="polite" data-testid={`request-qty-${kind}`}>
        {value}
      </span>
      <button type="button" aria-label={`More ${label}`} disabled={value >= REQUEST_LIMITS.maxQuantity} onClick={onInc} className={btn} data-testid={`request-inc-${kind}`}>
        <Plus className="size-3" aria-hidden />
      </button>
    </span>
  );
}

function MemberCombobox({
  members,
  value,
  onChange,
  invalid,
  teamLabel,
}: {
  members: Member[];
  value: string;
  onChange: (member: Member | null) => void;
  invalid: boolean;
  teamLabel?: (m: Member) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const selected = members.find((m) => m.id === value) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => members.filter((m) => !q || `${m.name} ${m.role} ${m.seat ?? ""}`.toLowerCase().includes(q)).slice(0, 50),
    [members, q],
  );
  const current = Math.min(active, Math.max(filtered.length - 1, 0));

  const choose = (m: Member | null) => {
    onChange(m);
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="relative">
        <Popover.Trigger
          id="req-member"
          aria-invalid={invalid || undefined}
          className={cn(inputClass, "flex items-center gap-2 pr-16 text-left")}
          data-testid="request-member"
        >
          {selected ? (
            <>
              <Avatar name={selected.name} hue={selected.hue} size="xs" />
              <span className="truncate font-medium">{selected.name}</span>
              <span className="truncate text-xs text-neutral-500">{teamLabel ? `${teamLabel(selected)} · ` : ""}{selected.seat ?? selected.role}</span>
            </>
          ) : (
            <>
              <UserRound className="size-4 text-neutral-400" aria-hidden />
              <span className="text-neutral-400">No one specific</span>
            </>
          )}
          <ChevronsUpDown className="absolute right-2.5 size-4 text-neutral-400" aria-hidden />
        </Popover.Trigger>
        {selected ? (
          <button
            type="button"
            aria-label="Clear member"
            onClick={() => choose(null)}
            className="absolute right-8 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-neutral-400 outline-none hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-accent/35"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[70] w-[var(--radix-popover-trigger-width)] min-w-[260px] rounded-xl bg-white p-1 shadow-pop outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" aria-hidden />
            <input
              role="combobox"
              aria-expanded
              aria-controls="req-member-list"
              aria-activedescendant={filtered[current] ? `req-member-${filtered[current].id}` : undefined}
              className="h-9 w-full rounded-lg bg-transparent pl-8 pr-2 text-sm outline-none placeholder:text-neutral-400"
              placeholder="Search people"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const next = (current + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) % Math.max(filtered.length, 1);
                  setActive(next);
                  listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (filtered[current]) choose(filtered[current]);
                }
              }}
            />
          </div>
          <ul ref={listRef} id="req-member-list" role="listbox" className="scrollbar-thin mt-1 max-h-60 overflow-y-auto border-t border-line pt-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-[13px] text-neutral-500">{members.length ? "No one matches" : "No active members on this team"}</li>
            ) : (
              filtered.map((m, i) => (
                <li
                  key={m.id}
                  id={`req-member-${m.id}`}
                  role="option"
                  aria-selected={m.id === value}
                  data-index={i}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(m)}
                  className={cn("flex h-10 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px]", i === current && "bg-neutral-900/[0.05]")}
                  data-testid="request-member-option"
                >
                  <Avatar name={m.name} hue={m.hue} size="xs" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-neutral-900">{m.name}</span>
                    <span className="block truncate text-xs text-neutral-500">
                      {teamLabel ? `${teamLabel(m)} · ` : ""}
                      {m.role}
                      {m.seat ? ` · Seat ${m.seat}` : ""}
                    </span>
                  </span>
                  {m.id === value ? <Check className="size-4 text-accent" aria-hidden /> : null}
                </li>
              ))
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
