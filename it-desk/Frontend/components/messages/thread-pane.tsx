"use client";

import { AlertCircle, ArrowDown, ArrowLeft, CheckCheck, Download, ExternalLink, ImagePlus, Info, Loader2, RotateCw, Send, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, newIdempotencyKey } from "@/lib/api";
import { attachmentSrc, CHAT_LIMITS, CHAT_POLL_MS, chatApi, counterpart, type ChatMessage, type ChatSide, type ChatThread, type ChatUnread } from "@/lib/chat";
import { dayKey, formatDate, formatDateTime, formatTime } from "@/lib/format";
import { nowMs } from "@/lib/clock";
import { isClosed, requestSummary, STATUS_LABEL } from "@/lib/requests";
import { cn } from "@/lib/utils";
import { useRequests } from "@/store/requests-store";
import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { PriorityLabel, RequestStatusPill } from "@/components/requests/request-ui";
import { CounterpartAvatar } from "./chat-ui";

/** A message the viewer is sending: shown at once, confirmed or marked failed. */
type PendingFile = { name: string; data: string; preview: string };
type Pending = { key: string; body: string; files: PendingFile[]; as: ChatSide; createdAt: string; status: "sending" | "failed"; error?: string };

const GROUP_GAP_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 120;

export function ThreadPane({
  id,
  seed,
  onBack,
  onThread,
}: {
  id: string;
  seed: ChatThread | null;
  onBack: () => void;
  onThread: (t: ChatThread, unread?: ChatUnread) => void;
}) {
  const { session } = useSession();
  const isStaffSide = session.user.role === "it" || session.user.role === "admin";
  const openDetail = useRequests((s) => s.openDetail);
  const [thread, setThread] = useState<ChatThread | null>(seed);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [as, setAs] = useState<ChatSide | null>(null);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [unseenBelow, setUnseenBelow] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const forceScroll = useRef(true);
  const lastId = useRef<string | undefined>(undefined);
  const reading = useRef(false);
  const onThreadRef = useRef(onThread);
  useLayoutEffect(() => {
    onThreadRef.current = onThread;
  }, [onThread]);

  // Latest values for async callbacks (kept in sync after each render).
  const messagesRef = useRef<ChatMessage[] | null>(null);
  const threadRef = useRef<ChatThread | null>(seed);
  useLayoutEffect(() => {
    messagesRef.current = messages;
    threadRef.current = thread;
  });

  const merge = useCallback((incoming: ChatMessage[]) => {
    const cur = messagesRef.current ?? [];
    const seen = new Set(cur.map((m) => m.id));
    const add = incoming.filter((m) => !seen.has(m.id));
    if (!add.length) return;
    const next = [...cur, ...add].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    messagesRef.current = next;
    lastId.current = next.at(-1)?.id;
    setMessages(next);
    const theirs = add.filter((m) => !m.mine).length;
    if (!nearBottom.current && theirs) setUnseenBelow((n) => n + theirs);
  }, []);

  // Initial load, then poll for anything newer while visible.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const fetchPage = async (initial: boolean) => {
      try {
        const page = await chatApi.messages(id, initial ? undefined : lastId.current, ctrl.signal);
        if (!alive) return;
        setThread(page.thread);
        if (initial) {
          messagesRef.current = page.messages;
          setMessages(page.messages);
          lastId.current = page.messages.at(-1)?.id;
        } else merge(page.messages);
        setLoadError(null);
        onThreadRef.current(page.thread);
      } catch (err) {
        if (!alive || ctrl.signal.aborted) return;
        if (initial) setLoadError(err instanceof ApiError ? err.message : "Couldn’t load this conversation.");
      }
    };
    void fetchPage(true);
    const tick = () => {
      if (document.visibilityState === "visible") void fetchPage(lastId.current === undefined);
    };
    const timer = window.setInterval(tick, CHAT_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [id, merge]);

  // Mark read whenever something unread is on screen.
  useEffect(() => {
    if (!thread || thread.unread === 0 || reading.current || document.visibilityState !== "visible") return;
    reading.current = true;
    chatApi
      .read(id)
      .then((u) => {
        const t = { ...thread, unread: 0 };
        setThread(t);
        onThreadRef.current(t, u);
      })
      .catch(() => {})
      .finally(() => {
        reading.current = false;
      });
  }, [id, thread]);

  // Stick to the bottom when the viewer is already there (or just sent something).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (forceScroll.current || nearBottom.current) {
      el.scrollTop = el.scrollHeight;
      forceScroll.current = false;
      nearBottom.current = true;
      setUnseenBelow(0);
    }
  }, [messages, pending]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom.current) setUnseenBelow(0);
  };
  const jumpToEnd = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUnseenBelow(0);
  };

  const side: ChatSide = as ?? thread?.side ?? "requester";
  const canChoose = (thread?.canPostAs.length ?? 0) > 1;

  const deliver = async (p: Pending) => {
    setPending((cur) => cur.map((x) => (x.key === p.key ? { ...x, status: "sending", error: undefined } : x)));
    try {
      const m = await chatApi.send(id, { body: p.body, images: p.files.map((f) => ({ name: f.name, data: f.data })), ...(canChoose ? { as: p.as } : {}) }, p.key);
      setPending((cur) => cur.filter((x) => x.key !== p.key));
      forceScroll.current = true;
      merge([m]);
      const t = threadRef.current;
      if (t) {
        const next = { ...t, lastMessage: m, lastActivityAt: m.createdAt, messageCount: t.messageCount + 1 };
        threadRef.current = next;
        setThread(next);
        onThreadRef.current(next);
      }
    } catch (err) {
      const message = err instanceof ApiError ? (err.fields?.body ?? err.message) : "Check your connection and try again.";
      setPending((cur) => cur.map((x) => (x.key === p.key ? { ...x, status: "failed", error: message } : x)));
    }
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setFileError(null);
    const next = [...files];
    for (const file of Array.from(list)) {
      if (next.length >= CHAT_LIMITS.maxImages) {
        setFileError("Attach up to 3 images");
        break;
      }
      if (!file.type.startsWith("image/")) {
        setFileError("Only PNG, JPEG, GIF and WebP images can be sent");
        continue;
      }
      if (file.size > CHAT_LIMITS.maxImageBytes) {
        setFileError("Each image must be under 2 MB");
        continue;
      }
      const data = await file.arrayBuffer();
      const bytes = new Uint8Array(data);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      next.push({ name: file.name, data: btoa(binary), preview: URL.createObjectURL(file) });
    }
    setFiles(next);
    if (fileRef.current) fileRef.current.value = "";
  };

  const send = () => {
    const body = draft.trim();
    if ((!body && files.length === 0) || body.length > CHAT_LIMITS.maxBody || !thread) return;
    const p: Pending = { key: newIdempotencyKey(), body, files, as: side, createdAt: new Date(nowMs()).toISOString(), status: "sending" };
    setPending((cur) => [...cur, p]);
    setDraft("");
    setFiles([]);
    setFileError(null);
    forceScroll.current = true;
    void deliver(p);
    inputRef.current?.focus();
  };

  const rows = useMemo(() => buildRows(messages ?? [], thread?.side ?? "requester"), [messages, thread?.side]);
  const lastMineIndex = useMemo(() => {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) if (messages![i].side === thread?.side) return i;
    return -1;
  }, [messages, thread?.side]);
  const seenAt = thread?.otherReadAt ?? null;

  if (loadError && !thread) {
    return (
      <div className="flex h-full flex-col">
        <MobileBack onBack={onBack} />
        <div className="m-auto max-w-sm px-6 text-center" role="alert">
          <AlertCircle className="mx-auto size-6 text-red-500" aria-hidden />
          <p className="mt-3 text-[13px] text-neutral-600">{loadError}</p>
          <Button size="sm" className="mt-4" onClick={onBack}>
            Back to conversations
          </Button>
        </div>
      </div>
    );
  }

  const c = thread ? counterpart(thread) : null;
  const r = thread?.request;
  const routedStaff = r?.staffName ?? null;
  const placeholder = !thread
    ? "Message"
    : side === "it"
      ? `Reply to ${r!.requesterName}${routedStaff ? ` as ${routedStaff}` : " as the IT team"}…`
      : `Message ${routedStaff ?? "the IT team"}…`;
  const overLimit = draft.trim().length > CHAT_LIMITS.maxBody;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-thread">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-white px-4 py-3 sm:px-5">
        <Button size="icon-sm" variant="ghost" className="-ml-1 md:hidden" aria-label="Back to conversations" onClick={onBack}>
          <ArrowLeft aria-hidden />
        </Button>
        {thread && c && r ? (
          <>
            <CounterpartAvatar thread={thread} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold leading-5 tracking-[-0.005em] text-neutral-900" data-testid="chat-counterpart">
                {c.name}
              </p>
              <p className="truncate text-xs leading-4 text-neutral-500">
                {thread.side === "it" ? c.subtitle : c.unassigned ? "Unassigned · anyone in IT can reply" : c.subtitle}
              </p>
            </div>
            <div className="hidden items-center gap-2.5 lg:flex">
              <span className="tnum font-mono text-[12px] font-semibold text-neutral-700">{r.ticket}</span>
              <RequestStatusPill status={r.status} />
              <PriorityLabel priority={r.priority} />
            </div>
            <Button size="sm" onClick={() => openDetail(r.id)} data-testid="chat-open-request">
              <ExternalLink aria-hidden />
              <span className="max-sm:sr-only">View request</span>
            </Button>
          </>
        ) : (
          <div className="flex flex-1 items-center gap-3">
            <Skeleton className="size-9 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        )}
      </header>

      {/* Context strip: what this conversation is about, and routing state */}
      {thread && r ? (
        <div className="shrink-0 border-b border-line bg-white/70 px-4 py-2 text-xs text-neutral-500 sm:px-5">
          <div className="flex items-center gap-2">
            <span className="tnum font-mono font-medium text-neutral-600 lg:hidden">{r.ticket}</span>
            <span className="text-neutral-300 lg:hidden" aria-hidden>·</span>
            <span className="min-w-0 truncate">
              <span className="font-medium text-neutral-700">{requestSummary(r)}</span>
              {r.teamName ? ` · ${r.teamName}` : ""} · raised by {r.requesterName}
            </span>
            <span className="ml-auto shrink-0 lg:hidden">{STATUS_LABEL[r.status]}</span>
          </div>
          {!r.staffId && !isClosed(r.status) ? (
            <div className="mt-2 flex items-center gap-2.5 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-inset ring-amber-200/70" data-testid="chat-unassigned">
              <Info className="size-4 shrink-0 text-amber-600" aria-hidden />
              <span className="min-w-0 flex-1 leading-4">
                {isStaffSide
                  ? "No one in IT is assigned yet. Replies go out as the IT team until you assign someone."
                  : "No one in IT is assigned yet — your messages reach the whole IT team."}
              </span>
              {isStaffSide ? (
                <Button size="sm" className="h-7 shrink-0 bg-white" onClick={() => openDetail(r.id)} data-testid="chat-assign">
                  <UserPlus aria-hidden />
                  Assign
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scrollbar-thin h-full overflow-y-auto px-4 py-5 sm:px-6"
          role="log"
          aria-live="polite"
          aria-label={c ? `Conversation with ${c.name}` : "Conversation"}
          data-testid="chat-log"
        >
          {messages === null ? (
            <MessagesSkeleton />
          ) : messages.length === 0 && pending.length === 0 && thread && c ? (
            <EmptyThread
              name={c.name}
              ticket={thread.request.ticket}
              itSide={thread.side === "it"}
              onPick={(text) => {
                setDraft(text);
                inputRef.current?.focus();
              }}
            />
          ) : (
            <ol className="mx-auto flex max-w-[760px] flex-col">
              {rows.map((row) =>
                row.kind === "day" ? (
                  <li key={row.key} className="my-4 flex items-center gap-3 first:mt-0" aria-label={row.label}>
                    <span className="h-px flex-1 bg-line" />
                    <span className="text-[11px] font-medium text-neutral-400">{row.label}</span>
                    <span className="h-px flex-1 bg-line" />
                  </li>
                ) : (
                  <Bubble
                    key={row.m.id}
                    m={row.m}
                    own={row.own}
                    first={row.first}
                    last={row.last}
                    showVia={isStaffSide}
                    seen={row.index === lastMineIndex && seenAt !== null && seenAt >= row.m.createdAt}
                  />
                ),
              )}
              {pending.map((p) => (
                <PendingBubble key={p.key} p={p} onRetry={() => void deliver(p)} onDiscard={() => setPending((cur) => cur.filter((x) => x.key !== p.key))} />
              ))}
            </ol>
          )}
        </div>
        {unseenBelow > 0 ? (
          <button
            type="button"
            onClick={jumpToEnd}
            className="absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-neutral-900 px-3 text-xs font-medium text-white shadow-pop outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ArrowDown className="size-3.5" aria-hidden />
            {unseenBelow} new {unseenBelow === 1 ? "message" : "messages"}
          </button>
        ) : null}
      </div>

      {/* Composer */}
      <form
        className="shrink-0 border-t border-line bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {canChoose && thread ? (
          <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
            <span id="chat-as-label">Send as</span>
            <Segmented
              label="Send as"
              value={side}
              onChange={setAs}
              options={[
                { value: "it", label: routedStaff ? `IT · ${routedStaff}` : "IT team" },
                { value: "requester", label: `Requester side` },
              ]}
            />
          </div>
        ) : null}
        {files.length ? (
          <ul className="mb-2 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="relative">
                <img src={f.preview} alt="" className="h-16 w-16 rounded-lg object-cover ring-1 ring-line" />
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-neutral-900 text-white"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div
          className={cn(
            "flex items-end gap-2 rounded-xl border bg-white px-3 py-2 shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15",
            overLimit ? "border-red-400" : "border-line-strong",
          )}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="sr-only"
            aria-label="Attach images"
            onChange={(e) => void addFiles(e.target.files)}
          />
          <button
            type="button"
            aria-label="Attach a screenshot"
            title="Attach a screenshot"
            disabled={!thread || files.length >= CHAT_LIMITS.maxImages}
            onClick={() => fileRef.current?.click()}
            className="mb-px grid size-8 shrink-0 place-items-center rounded-lg text-neutral-500 outline-none hover:bg-neutral-100 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-40"
          >
            <ImagePlus className="size-4" aria-hidden />
          </button>
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={draft}
            disabled={!thread}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            aria-invalid={overLimit || undefined}
            aria-describedby="chat-hint"
            className="max-h-40 min-h-6 flex-1 resize-none bg-transparent py-1 text-sm leading-6 text-neutral-900 outline-none [field-sizing:content] placeholder:text-neutral-400 disabled:cursor-not-allowed"
            data-testid="chat-input"
          />
          <Button
            type="submit"
            variant="primary"
            size="icon-sm"
            aria-label="Send message"
            title="Send (Enter)"
            disabled={!thread || (!draft.trim() && files.length === 0) || overLimit}
            className="mb-px shrink-0 disabled:opacity-40"
            data-testid="chat-send"
          >
            <Send aria-hidden />
          </Button>
        </div>
        <p id="chat-hint" className={cn("mt-1.5 flex gap-3 text-[11px]", overLimit ? "text-red-600" : "text-neutral-400")}>
          <span className="max-sm:hidden">
            <kbd className="font-sans font-medium text-neutral-500">Enter</kbd> to send · <kbd className="font-sans font-medium text-neutral-500">Shift + Enter</kbd> for a new line
          </span>
          {side === "it" && thread ? (
            <span className="truncate">
              Shown to {r!.requesterName} as {routedStaff ?? "the IT team"}
              {" · sent by you"}
            </span>
          ) : null}
          {fileError ? <span className="text-red-600">{fileError}</span> : <span>Images stay in the chat for 30 days.</span>}
          {draft.trim().length > CHAT_LIMITS.maxBody - 200 ? (
            <span className="tnum ml-auto">
              {draft.trim().length}/{CHAT_LIMITS.maxBody}
            </span>
          ) : null}
        </p>
      </form>
    </div>
  );
}

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; m: ChatMessage; own: boolean; first: boolean; last: boolean; index: number };

/** Day separators, and runs of messages from the same sender within a few minutes. */
function buildRows(messages: ChatMessage[], viewerSide: ChatSide): Row[] {
  const out: Row[] = [];
  const today = dayKey(nowMs());
  const yesterday = dayKey(nowMs() - 86_400_000);
  let prevDay = "";
  messages.forEach((m, i) => {
    const t = new Date(m.createdAt).getTime();
    const day = dayKey(t);
    if (day !== prevDay) {
      out.push({ kind: "day", key: `d-${day}`, label: day === today ? "Today" : day === yesterday ? "Yesterday" : formatDate(m.createdAt) });
      prevDay = day;
    }
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const same = (a?: ChatMessage) =>
      a && a.side === m.side && a.senderName === m.senderName && a.authorId === m.authorId && dayKey(new Date(a.createdAt).getTime()) === day;
    const first = !same(prev) || t - new Date(prev!.createdAt).getTime() > GROUP_GAP_MS;
    const last = !same(next) || new Date(next!.createdAt).getTime() - t > GROUP_GAP_MS;
    out.push({ kind: "msg", m, own: m.side === viewerSide, first, last, index: i });
  });
  return out;
}

function Bubble({ m, own, first, last, showVia, seen }: { m: ChatMessage; own: boolean; first: boolean; last: boolean; showVia: boolean; seen: boolean }) {
  // Your own IT-side messages: say who the requester sees them from.
  const name = m.mine ? (m.side === "it" && m.onBehalf ? `You · as ${m.senderName}` : "You") : m.senderName;
  return (
    <li className={cn("flex flex-col", own ? "items-end" : "items-start", first ? "mt-3 first:mt-0" : "mt-1")} data-testid="chat-message" data-side={m.side}>
      {first ? (
        <span className={cn("mb-1 flex items-baseline gap-1.5 px-1 text-[11px]", own && "flex-row-reverse")}>
          <span className="font-semibold text-neutral-700">{name}</span>
          {m.side === "it" && showVia && m.onBehalf && !m.mine ? <span className="text-neutral-400">via {m.authorName}</span> : null}
          <time className="tnum text-neutral-400" dateTime={m.createdAt} title={formatDateTime(m.createdAt)}>
            {formatTime(m.createdAt)}
          </time>
        </span>
      ) : null}
      <div
        className={cn(
          "max-w-[min(80%,560px)] whitespace-pre-wrap break-words px-3.5 py-2 text-[13.5px] leading-[1.45]",
          own ? "bg-accent text-white" : "bg-white text-neutral-900 shadow-xs ring-1 ring-inset ring-line",
          own
            ? cn("rounded-2xl", !first && "rounded-tr-md", !last && "rounded-br-md")
            : cn("rounded-2xl", !first && "rounded-tl-md", !last && "rounded-bl-md"),
        )}
        title={first ? undefined : formatDateTime(m.createdAt)}
      >
        {m.body ? <span className="block">{m.body}</span> : null}
        {m.attachments?.length ? (
          <span className={cn("mt-2 flex flex-col gap-2", !m.body && "mt-0")}>
            {m.attachments.map((a) => (
              <span key={a.id} className="block">
                <a href={attachmentSrc(a.url)} target="_blank" rel="noreferrer" className="block">
                  <img src={attachmentSrc(a.url)} alt={a.name} className="max-h-60 max-w-full rounded-lg object-contain" />
                </a>
                <a href={attachmentSrc(a.url, true)} className={cn("mt-1 inline-flex items-center gap-1 text-[11px] font-medium underline-offset-2 hover:underline", own ? "text-white/90" : "text-neutral-500")}>
                  <Download className="size-3" aria-hidden />
                  Download
                </a>
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {seen ? (
        <span className="mt-1 inline-flex items-center gap-1 px-1 text-[11px] text-neutral-400" data-testid="chat-seen">
          <CheckCheck className="size-3.5 text-accent" aria-hidden />
          Seen
        </span>
      ) : null}
    </li>
  );
}

function PendingBubble({ p, onRetry, onDiscard }: { p: Pending; onRetry: () => void; onDiscard: () => void }) {
  const failed = p.status === "failed";
  return (
    <li className="mt-1 flex flex-col items-end" data-testid="chat-pending" data-status={p.status}>
      <div
        className={cn(
          "max-w-[min(80%,560px)] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[13.5px] leading-[1.45]",
          failed ? "bg-red-50 text-red-900 ring-1 ring-inset ring-red-200" : "bg-accent/75 text-white",
        )}
      >
        {p.body ? <span className="block">{p.body}</span> : null}
        {p.files.length ? (
          <span className="mt-2 flex gap-1.5">
            {p.files.map((f) => (
              <img key={f.preview} src={f.preview} alt="" className="h-16 w-16 rounded-md object-cover" />
            ))}
          </span>
        ) : null}
      </div>
      <span className={cn("mt-1 inline-flex items-center gap-1.5 px-1 text-[11px]", failed ? "text-red-600" : "text-neutral-400")} role={failed ? "alert" : undefined}>
        {failed ? (
          <>
            <AlertCircle className="size-3.5" aria-hidden />
            Not sent{p.error ? ` · ${p.error}` : ""}
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-medium text-red-700 underline-offset-2 hover:underline">
              <RotateCw className="size-3" aria-hidden />
              Retry
            </button>
            <button type="button" onClick={onDiscard} className="font-medium text-neutral-500 underline-offset-2 hover:underline">
              Discard
            </button>
          </>
        ) : (
          <>
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Sending…
          </>
        )}
      </span>
    </li>
  );
}

function EmptyThread({ name, ticket, itSide, onPick }: { name: string; ticket: string; itSide: boolean; onPick: (text: string) => void }) {
  const ideas = itSide
    ? ["Hi! I’m looking into this now.", "Could you share a photo or the error message?", "Is now a good time to come by your desk?"]
    : ["Hi! Any update on this?", "When could I collect it?", "It’s getting urgent — could you take a look today?"];
  return (
    <div className="mx-auto flex h-full max-w-sm flex-col items-center justify-center text-center" data-testid="chat-empty">
      <span className="grid size-12 place-items-center rounded-2xl bg-white text-accent shadow-xs ring-1 ring-line">
        <Send className="size-5" aria-hidden />
      </span>
      <p className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-neutral-900">Start the conversation</p>
      <p className="mt-1.5 text-[13px] leading-5 text-neutral-500 text-pretty">
        {itSide ? `Message ${name} about ${ticket}. They’ll see it in Messages.` : `Message ${name} about ${ticket}. Everything stays attached to the ticket.`}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {ideas.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onPick(t)}
            className="rounded-full border border-line-strong bg-white px-3 py-1.5 text-xs text-neutral-700 shadow-xs outline-none transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-accent/35"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessagesSkeleton() {
  return (
    <div className="mx-auto max-w-[760px] space-y-4" aria-hidden>
      <Skeleton className="h-9 w-2/5 rounded-2xl" />
      <Skeleton className="ml-auto h-9 w-1/3 rounded-2xl" />
      <Skeleton className="h-14 w-1/2 rounded-2xl" />
      <Skeleton className="ml-auto h-9 w-1/4 rounded-2xl" />
    </div>
  );
}

function MobileBack({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center border-b border-line px-3 md:hidden">
      <Button size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeft aria-hidden />
        Conversations
      </Button>
    </div>
  );
}
