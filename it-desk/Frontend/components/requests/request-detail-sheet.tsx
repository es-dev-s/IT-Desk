"use client";

import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CircleCheck,
  Eye,
  Hand,
  Loader2,
  MessageSquare,
  RotateCcw,
  Send,
  Sparkles,
  Undo2,
  UserCheck,
  UserRoundCog,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import {
  CATEGORY_LABEL,
  KIND_LABEL,
  PRIORITY_LABEL,
  REQUEST_LIMITS,
  STATUS_LABEL,
  isClosed,
  requestsApi,
  type Assignee,
  type ITRequest,
  type ITRequestDetail,
  type RequestEvent,
} from "@/lib/requests";
import { chatHref } from "@/lib/chat";
import { cn } from "@/lib/utils";
import { useRequests } from "@/store/requests-store";
import { useNotifications } from "@/store/notifications-store";
import { AckBanner } from "@/components/realtime/ack-banner";
import { useSession } from "@/components/auth/session-provider";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonClass } from "@/components/ui/button";
import { textareaClass } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { SelectField } from "@/components/ui/select";
import { Sheet, SheetClose } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { CATEGORY_ICON, KIND_ICON, PriorityLabel, RequestStatusPill } from "./request-ui";
import { useRequestAction } from "./use-request-action";
import { StaffPicker, useStaffList } from "./staff-picker";
import { staffHue } from "@/lib/it-staff";

/** Request detail: items, notes, timeline, comments and the next actions for the viewer's role. */
export function RequestDetailSheet() {
  const detail = useRequests((s) => s.detail);
  const closeDetail = useRequests((s) => s.closeDetail);
  const seed = useRequests((s) => (detail.id ? s.items?.find((r) => r.id === detail.id) ?? null : null));
  return (
    <Sheet
      open={detail.open}
      onOpenChange={(open) => (open ? null : closeDetail())}
      title={seed ? `${seed.ticket} · IT request` : "IT request"}
      description="Request details, timeline and comments"
      header={<SheetHeader request={seed} />}
    >
      {detail.id ? <DetailBody key={detail.nonce} id={detail.id} seed={seed} /> : null}
    </Sheet>
  );
}

function SheetHeader({ request }: { request: ITRequest | null }) {
  const { can } = useSession();
  const closeDetail = useRequests((s) => s.closeDetail);
  const isIt = can("requests.fulfil");
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-6">
      {request ? (
        <>
          <span className="tnum font-mono text-[13px] font-semibold text-neutral-900">{request.ticket}</span>
          <RequestStatusPill status={request.status} />
          <PriorityLabel priority={request.priority} className="hidden sm:inline-flex" />
        </>
      ) : (
        <Skeleton className="h-4 w-24" />
      )}
      {request && can("requests.comment") ? (
        <Link
          href={chatHref(request.id)}
          onClick={closeDetail}
          className={buttonClass("secondary", "sm", "ml-auto")}
          data-testid="request-open-chat"
        >
          <MessagesSquare aria-hidden />
          {isIt ? "Open chat" : request.staffName ? `Message ${request.staffName.split(" ")[0]}` : "Message IT"}
        </Link>
      ) : null}
      <SheetClose className={request && can("requests.comment") ? "" : "ml-auto"} />
    </div>
  );
}

type Mode = null | "cancel" | "reject" | "resolve" | "assign";

function DetailBody({ id, seed }: { id: string; seed: ITRequest | null }) {
  const { session, can } = useSession();
  const isIt = can("requests.fulfil");
  const [data, setData] = useState<ITRequestDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  // Bumped by live events for this request: refetch so the sheet updates in place.
  const liveTick = useNotifications((s) => s.ticks[id] ?? 0);

  useEffect(() => {
    const ctrl = new AbortController();
    requestsApi
      .get(id, ctrl.signal)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof ApiError ? (err.status === 404 ? "This request doesn’t exist or isn’t visible to you." : err.message) : "Couldn’t load this request.");
      });
    return () => ctrl.abort();
  }, [id, tick, liveTick]);

  useEffect(() => {
    if (!isIt) return;
    const ctrl = new AbortController();
    requestsApi
      .assignees(ctrl.signal)
      .then(setAssignees)
      .catch(() => {
        /* the assign picker just stays empty */
      });
    return () => ctrl.abort();
  }, [isIt]);

  const { pending, run } = useRequestAction({
    onDone: (r) => {
      setData(r);
      setMode(null);
      setText("");
    },
    onConflict: () => setTick((t) => t + 1),
  });

  const r: ITRequest | null = data ?? seed;
  if (!r) {
    return loadError ? <LoadError message={loadError} onRetry={() => setTick((t) => t + 1)} /> : <BodySkeleton />;
  }

  const me = session.user.id;
  const v = r.version;
  const isRequester = r.requesterId === me;
  const canCancel = can("requests.cancel") && isRequester && r.status === "open";
  const assignedToOther = Boolean(r.assigneeId && r.assigneeId !== me);

  const act = (key: string, fn: () => Promise<ITRequestDetail>, done: string) => void run(key, r.ticket, fn, () => done);
  const confirmMode = () => {
    const t = text.trim();
    if (mode === "cancel") act("cancel", () => requestsApi.cancel(r.id, { reason: t, expectedVersion: v }), `${r.ticket} cancelled`);
    else if (mode === "reject") act("reject", () => requestsApi.reject(r.id, { reason: t, expectedVersion: v }), `${r.ticket} rejected`);
    else if (mode === "resolve") act("resolve", () => requestsApi.move(r.id, { status: "resolved", note: t, expectedVersion: v }), `${r.ticket} resolved`);
    else if (mode === "assign")
      act("assign", () => requestsApi.assign(r.id, { assigneeId: assignTo, expectedVersion: v }), assignTo ? `${r.ticket} assigned` : `${r.ticket} unassigned`);
  };

  const sendComment = () => {
    const body = comment.trim();
    if (body.length < 1) return setCommentError("Write something first");
    if (body.length > REQUEST_LIMITS.maxComment) return setCommentError(`Keep it under ${REQUEST_LIMITS.maxComment} characters`);
    setCommentError(null);
    void run("comment", r.ticket, () => requestsApi.comment(r.id, body)).then((res) => (res ? setComment("") : null));
  };

  const rejectInvalid = mode === "reject" && text.trim().length < 3;

  return (
    <>
      <div className="scrollbar-thin flex-1 overflow-y-auto" data-testid="request-detail" data-status={r.status} data-ticket={r.ticket}>
        <div className="px-6 pt-5 empty:hidden">
          <AckBanner
            kind="request"
            request={r}
            isIt={isIt}
            onAck={() => run("ack", r.ticket, () => requestsApi.acknowledge(r.id, { expectedVersion: v }), () => `${r.ticket} acknowledged · in progress`)}
          />
        </div>
        {/* What: the issue, or the requested items */}
        <section className="border-b border-line px-6 py-5">
          {r.type === "issue" ? <IssueSummary request={r} /> : (
          <>
          <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-400">Requested</h3>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {r.items.map((it) => {
              const Icon = KIND_ICON[it.kind];
              return (
                <li key={it.kind} className="flex items-center gap-3 rounded-xl border border-line bg-subtle/50 px-3 py-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white text-neutral-600 shadow-xs">
                    <Icon className="size-[18px]" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-neutral-900">{KIND_LABEL[it.kind]}</span>
                    {it.description ? <span className="block truncate text-xs text-neutral-500">{it.description}</span> : null}
                  </span>
                  <span className="tnum text-[13px] font-semibold text-neutral-700">×{it.quantity}</span>
                </li>
              );
            })}
          </ul>
          </>
          )}
          <p className="mt-4 whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-700">{r.notes}</p>
        </section>

        {/* Meta */}
        <section className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-line px-6 py-5 text-[13px]">
          <Meta label="Raised by">
            <span className="flex items-center gap-2">
              <Avatar name={r.requesterName} size="xs" />
              <span className="truncate">{r.requesterName}</span>
            </span>
          </Meta>
          <Meta label={r.type === "issue" ? "Affects" : "For"}>{r.forMemberName ?? (r.teamName ? `${r.teamName} team` : "Organisation-wide")}</Meta>
          <Meta label="Team">{r.teamName ? `${r.teamCode} · ${r.teamName}` : "—"}</Meta>
          <Meta label="Priority">{PRIORITY_LABEL[r.priority]}</Meta>
          <Meta label="Assignee">
            {r.assigneeName ? (
              <span className="flex items-center gap-2">
                <Avatar name={r.assigneeName} size="xs" />
                <span className="truncate">{r.assigneeName}</span>
              </span>
            ) : (
              <span className="text-neutral-400">Unassigned</span>
            )}
          </Meta>
          <div className="col-span-2">
            <StaffMeta request={r} canRoute={(isIt || session.user.role === "admin") && !isClosed(r.status)} busy={Boolean(pending)} onRoute={(staffId) =>
              act("route", () => requestsApi.route(r.id, { staffId, expectedVersion: v }), staffId ? `${r.ticket} routed` : `${r.ticket} open to anyone in IT`)
            } />
          </div>
          <Meta label="Opened">
            <span title={formatDateTime(r.createdAt)}>{formatRelative(r.createdAt)}</span>
          </Meta>
        </section>

        {r.resolution && (r.status === "resolved" || r.status === "rejected" || r.status === "cancelled") ? (
          <div
            className={cn(
              "mx-6 mt-5 rounded-xl border px-4 py-3 text-[13px]",
              r.status === "resolved" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : r.status === "rejected" ? "border-red-200 bg-red-50 text-red-900" : "border-line bg-subtle text-neutral-700",
            )}
          >
            <p className="text-xs font-medium opacity-80">{r.status === "resolved" ? "Resolution" : r.status === "rejected" ? "Reason for rejection" : "Cancellation note"}</p>
            <p className="mt-1 whitespace-pre-wrap">{r.resolution}</p>
          </div>
        ) : null}

        {/* Timeline */}
        <section className="px-6 py-5">
          <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-400">Activity</h3>
          {data ? (
            <ol className="relative mt-4 space-y-4 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-line">
              {data.events.map((e) => (
                <TimelineItem key={e.id} event={e} />
              ))}
            </ol>
          ) : loadError ? (
            <LoadError message={loadError} onRetry={() => setTick((t) => t + 1)} compact />
          ) : (
            <div className="mt-4 space-y-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="size-7 rounded-full" />
                  <div className="flex-1 space-y-1.5 pt-1">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {can("requests.comment") ? (
            <div className="mt-5">
              <label htmlFor="req-comment" className="sr-only">Add a comment</label>
              <div className="relative">
                <textarea
                  id="req-comment"
                  rows={2}
                  className={cn(textareaClass, "min-h-[72px] pr-12")}
                  placeholder={isIt ? "Reply to the requester…" : "Add a comment for IT…"}
                  value={comment}
                  maxLength={REQUEST_LIMITS.maxComment}
                  aria-invalid={commentError ? true : undefined}
                  onChange={(e) => {
                    setComment(e.target.value);
                    setCommentError(null);
                  }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      sendComment();
                    }
                  }}
                  data-testid="comment-input"
                />
                <Button
                  size="icon-sm"
                  variant="dark"
                  aria-label="Send comment"
                  className="absolute bottom-2 right-2"
                  disabled={pending === "comment" || !comment.trim()}
                  onClick={sendComment}
                  data-testid="comment-submit"
                >
                  {pending === "comment" ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                </Button>
              </div>
              <p className={cn("mt-1 min-h-4 text-xs", commentError ? "text-red-600" : "text-neutral-400")}>
                {commentError ?? (
                  <span className="hidden items-center gap-1 sm:inline-flex">
                    <Kbd>⌘</Kbd>
                    <Kbd>↵</Kbd> to send
                  </span>
                )}
              </p>
            </div>
          ) : null}
        </section>
      </div>

      {/* Inline confirm panel for actions that take text */}
      {mode ? (
        <div className="shrink-0 animate-step-in border-t border-line bg-subtle/60 px-6 py-4">
          {mode === "assign" ? (
            <>
              <p className="mb-2 text-[13px] font-medium text-neutral-800">Assign to</p>
              <SelectField
                size="md"
                className="w-full"
                label="Assign to"
                value={assignTo || "__none"}
                onValueChange={(val) => setAssignTo(val === "__none" ? "" : val)}
                options={[
                  { value: "__none", label: "Unassigned" },
                  ...(assignees ?? []).map((a) => ({ value: a.id, label: `${a.name}${a.id === me ? " (you)" : ""} · ${a.open} open` })),
                ]}
              />
            </>
          ) : (
            <>
              <label htmlFor="req-action-text" className="mb-2 block text-[13px] font-medium text-neutral-800">
                {mode === "cancel" ? "Why cancel? (optional)" : mode === "reject" ? "Reason (the requester will see this)" : "Resolution note (optional)"}
              </label>
              <textarea
                id="req-action-text"
                autoFocus
                rows={2}
                className={cn(textareaClass, "min-h-[64px] bg-white")}
                maxLength={REQUEST_LIMITS.maxResolution}
                value={text}
                placeholder={mode === "resolve" ? "e.g. Laptop LT-2231 handed over at desk A-14" : mode === "reject" ? "e.g. Covered by the Q3 hardware refresh" : "e.g. No longer needed"}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !rejectInvalid) {
                    e.preventDefault();
                    confirmMode();
                  }
                }}
                data-testid="action-text"
              />
            </>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setMode(null); setText(""); }}>
              Back
            </Button>
            <Button
              size="sm"
              variant={mode === "reject" || mode === "cancel" ? "danger" : "primary"}
              disabled={Boolean(pending) || rejectInvalid}
              onClick={confirmMode}
              data-testid="action-confirm"
            >
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {mode === "cancel" ? "Cancel request" : mode === "reject" ? "Reject request" : mode === "resolve" ? "Mark resolved" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <Footer>
          {isIt && r.status === "open" ? (
            <>
              {!r.assigneeId ? (
                <Button size="sm" variant="primary" disabled={Boolean(pending)} onClick={() => act("claim", () => requestsApi.assign(r.id, { assigneeId: "me", expectedVersion: v }), `${r.ticket} claimed`)} data-testid="request-claim">
                  {pending === "claim" ? <Loader2 className="animate-spin" aria-hidden /> : <Hand aria-hidden />}
                  Claim
                </Button>
              ) : null}
              <Button size="sm" variant={r.assigneeId ? "primary" : "secondary"} disabled={Boolean(pending) || assignedToOther} title={assignedToOther ? `Assigned to ${r.assigneeName}` : undefined} onClick={() => act("start", () => requestsApi.move(r.id, { status: "in_progress", expectedVersion: v }), `${r.ticket} in progress`)} data-testid="request-start">
                {pending === "start" ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowRight aria-hidden />}
                Start
              </Button>
              <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => { setAssignTo(r.assigneeId ?? ""); setMode("assign"); }} data-testid="request-assign">
                <UserRoundCog aria-hidden />
                Assign
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto text-red-700 hover:bg-red-50" disabled={Boolean(pending)} onClick={() => setMode("reject")} data-testid="request-reject">
                <Ban aria-hidden />
                Reject
              </Button>
            </>
          ) : isIt && r.status === "in_progress" ? (
            <>
              <Button size="sm" variant="primary" disabled={Boolean(pending)} onClick={() => setMode("resolve")} data-testid="request-resolve">
                <CircleCheck aria-hidden />
                Resolve
              </Button>
              <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => act("handback", () => requestsApi.move(r.id, { status: "open", expectedVersion: v }), `${r.ticket} back to open`)} data-testid="request-handback">
                {pending === "handback" ? <Loader2 className="animate-spin" aria-hidden /> : <Undo2 aria-hidden />}
                Back to open
              </Button>
              <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => { setAssignTo(r.assigneeId ?? ""); setMode("assign"); }} data-testid="request-assign">
                <UserRoundCog aria-hidden />
                Assign
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto text-red-700 hover:bg-red-50" disabled={Boolean(pending)} onClick={() => setMode("reject")} data-testid="request-reject">
                <Ban aria-hidden />
                Reject
              </Button>
            </>
          ) : isIt && r.status === "resolved" ? (
            <Button size="sm" disabled={Boolean(pending)} onClick={() => act("reopen", () => requestsApi.move(r.id, { status: "in_progress", expectedVersion: v }), `${r.ticket} reopened`)} data-testid="request-reopen">
              {pending === "reopen" ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
              Reopen
            </Button>
          ) : canCancel ? (
            <>
              <p className="text-xs text-neutral-500">You can cancel until IT starts on it.</p>
              <Button size="sm" variant="ghost" className="ml-auto text-red-700 hover:bg-red-50" disabled={Boolean(pending)} onClick={() => setMode("cancel")} data-testid="request-cancel">
                <XCircle aria-hidden />
                Cancel request
              </Button>
            </>
          ) : (
            <p className="text-xs text-neutral-500">
              {isClosed(r.status)
                ? `${STATUS_LABEL[r.status]} ${r.closedAt ? formatRelative(r.closedAt) : ""}`.trim()
                : r.status === "in_progress"
                  ? `IT is working on this${r.assigneeName ? ` (${r.assigneeName})` : ""}. Add a comment if anything changes.`
                  : "Waiting for IT to pick this up."}
            </p>
          )}
        </Footer>
      )}
    </>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[60px] shrink-0 flex-wrap items-center gap-2 border-t border-line px-6 py-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">{children}</div>;
}

/** IT staff directory routing: a picker for IT and admins, plain text for everyone else. */
function StaffMeta({ request: r, canRoute, busy, onRoute }: { request: ITRequest; canRoute: boolean; busy: boolean; onRoute: (staffId: string) => void }) {
  const { staff, loading } = useStaffList();
  if (!canRoute) {
    return (
      <Meta label="Assigned to (IT staff)">
        {r.staffName ? (
          <span className="flex items-center gap-2">
            <Avatar name={r.staffName} hue={staffHue(r.staffName)} size="xs" />
            <span className="truncate">{r.staffName}</span>
            {r.staffTitle ? <span className="truncate text-xs font-normal text-neutral-500">{r.staffTitle}</span> : null}
          </span>
        ) : (
          <span className="text-neutral-400">Anyone in IT</span>
        )}
      </Meta>
    );
  }
  return (
    <div className="min-w-0">
      <label htmlFor="detail-staff" className="text-xs text-neutral-500">
        Assigned to (IT staff)
      </label>
      <StaffPicker
        id="detail-staff"
        className="mt-1"
        value={r.staffId ?? ""}
        onChange={(v) => (v !== (r.staffId ?? "") ? onRoute(v) : null)}
        staff={staff}
        loading={loading}
        disabled={busy}
        current={r.staffName ? { name: r.staffName, title: r.staffTitle } : null}
        testId="detail-staff"
      />
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-neutral-500">{label}</p>
      <div className="mt-1 truncate font-medium text-neutral-900">{children}</div>
    </div>
  );
}

const EVENT_STYLE: Record<RequestEvent["kind"], { icon: React.ComponentType<{ className?: string }>; className: string }> = {
  created: { icon: Sparkles, className: "bg-accent-soft text-accent-ink" },
  acknowledged: { icon: Eye, className: "bg-emerald-50 text-emerald-700" },
  assigned: { icon: UserCheck, className: "bg-sky-50 text-sky-700" },
  status: { icon: ArrowRight, className: "bg-neutral-100 text-neutral-600" },
  comment: { icon: MessageSquare, className: "bg-white text-neutral-600 ring-1 ring-line" },
  cancelled: { icon: XCircle, className: "bg-neutral-100 text-neutral-500" },
  rejected: { icon: Ban, className: "bg-red-50 text-red-700" },
};

function eventTitle(e: RequestEvent) {
  switch (e.kind) {
    case "created":
      return "raised the request";
    case "acknowledged":
      return "has seen it · working on it";
    case "assigned":
      if (e.body.startsWith("Claimed")) return "claimed the request";
      if (e.body.startsWith("Assigned to ")) return `assigned it to ${e.body.slice("Assigned to ".length)}`;
      if (e.body.startsWith("Unassigned")) return "put it back in the unassigned pool";
      return "changed the assignee";
    case "status": {
      const to = e.toStatus as keyof typeof STATUS_LABEL | null;
      if (to === "resolved") return "resolved the request";
      if (to === "in_progress") return e.fromStatus === "resolved" ? "reopened the request" : "started work";
      if (to === "open") return "moved it back to open";
      return "changed the status";
    }
    case "comment":
      return "commented";
    case "cancelled":
      return "cancelled the request";
    case "rejected":
      return "rejected the request";
  }
}

function TimelineItem({ event: e }: { event: RequestEvent }) {
  const style = e.kind === "status" && e.toStatus === "resolved" ? { icon: CircleCheck, className: "bg-emerald-50 text-emerald-700" } : EVENT_STYLE[e.kind];
  const Icon = style.icon;
  const showBody = e.body && e.kind !== "assigned" && e.kind !== "created" && e.kind !== "acknowledged";
  return (
    <li className="relative flex gap-3" data-testid="timeline-event" data-kind={e.kind}>
      <span className={cn("relative z-[1] grid size-7 shrink-0 place-items-center rounded-full", style.className)}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <p className="text-[13px] leading-5 text-neutral-600">
          <span className="font-medium text-neutral-900">{e.actorName}</span> {eventTitle(e)}
          <span className="tnum ml-1.5 text-xs text-neutral-400" title={formatDateTime(e.at)}>
            · {formatRelative(e.at)}
          </span>
        </p>
        {showBody ? (
          <p className={cn("mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-700", e.kind === "comment" && "rounded-lg rounded-tl-sm border border-line bg-white px-3 py-2 shadow-xs")}>
            {e.body}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function LoadError({ message, onRetry, compact = false }: { message: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "mt-4 py-4" : "flex-1 justify-center px-6 py-16")} role="alert">
      <AlertTriangle className="size-5 text-amber-600" aria-hidden />
      <p className="mt-2 text-[13px] text-neutral-700">{message}</p>
      <Button size="sm" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function BodySkeleton() {
  return (
    <div className="space-y-4 px-6 py-5" aria-busy="true">
      <Skeleton className="h-3 w-20" />
      <div className="grid gap-2 sm:grid-cols-2">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

/** Issue header in the detail sheet: category, title and the affected device. */
function IssueSummary({ request: r }: { request: ITRequest }) {
  const Icon = r.category ? CATEGORY_ICON[r.category] : null;
  return (
    <div data-testid="request-detail-issue">
      <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-400">Reported issue</h3>
      <div className="mt-3 flex items-start gap-3 rounded-xl border border-amber-200/80 bg-amber-50/50 px-3 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white text-amber-700 shadow-xs">
          {Icon ? <Icon className="size-[18px]" aria-hidden /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-neutral-900">{r.title}</span>
          <span className="block truncate text-xs text-neutral-500">
            {r.category ? CATEGORY_LABEL[r.category] : "Issue"}
            {r.device ? ` · Device ${r.device}` : ""}
          </span>
        </span>
      </div>
    </div>
  );
}
