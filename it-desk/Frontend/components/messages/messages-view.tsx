"use client";

import { MessagesSquare, Plus, SearchX } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { CHAT_POLL_MS, chatApi, chatHref, counterpart, type ChatFilter, type ChatList, type ChatScope, type ChatThread, type ChatUnread } from "@/lib/chat";
import { isClosed, requestSummary } from "@/lib/requests";
import { cn } from "@/lib/utils";
import { useChat } from "@/store/chat-store";
import { useRequests } from "@/store/requests-store";
import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { CounterpartAvatar, listTime, UnreadBadge } from "./chat-ui";
import { ThreadPane } from "./thread-pane";

const FILTERS: { value: ChatFilter; label: string }[] = [
  { value: "active", label: "Open" },
  { value: "closed", label: "Resolved" },
  { value: "all", label: "All" },
];

const SCOPES: { value: ChatScope; label: string }[] = [
  { value: "mine", label: "Assigned to me" },
  { value: "everyone", label: "All IT" },
];

/**
 * Messages: every IT request has a conversation between the requester's side
 * and the IT member it is routed to. Two panes on wide screens; on phones the
 * list, then the thread with a back button. The selected request lives in the
 * URL (?r=), so other pages can deep-link into a conversation.
 */
export function MessagesView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedId = params.get("r");
  const { can, session } = useSession();
  const canCreate = can("requests.create");
  const openDialog = useRequests((s) => s.openDialog);
  const setUnread = useChat((s) => s.setUnread);

  const [filter, setFilter] = useState<ChatFilter>("active");
  // IT staff who sign in as themselves start on their own conversations. An
  // IT account not linked to a staff entry falls back to everything.
  const [scope, setScope] = useState<ChatScope>(session.user.role === "it" ? "mine" : "everyone");
  const [hasStaff, setHasStaff] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [list, setList] = useState<ChatList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  // Load on filter / search change, then keep previews and unread counts fresh
  // while the page is open and visible. The previous list stays until the new one arrives.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const load = async () => {
      const n = ++seq.current;
      try {
        const res = await chatApi.list({ status: filter, scope, q: debounced }, ctrl.signal);
        if (!alive || n !== seq.current) return;
        setHasStaff(Boolean(res.myStaffId));
        if (!res.myStaffId && scope === "mine") return setScope("everyone");
        setList(res);
        setError(null);
        setUnread({ unread: res.unread, unreadChats: res.unreadChats });
      } catch (err) {
        if (!alive || ctrl.signal.aborted || n !== seq.current) return;
        setError(err instanceof ApiError ? err.message : "Couldn’t load conversations.");
      }
    };
    void load();
    const onTick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const id = window.setInterval(onTick, CHAT_POLL_MS + 1000);
    document.addEventListener("visibilitychange", onTick);
    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onTick);
    };
  }, [filter, scope, debounced, setUnread, tick]);

  const select = (id: string | null) => router.replace(id ? chatHref(id) : pathname, { scroll: false });

  const seed = useMemo(() => list?.items.find((t) => t.request.id === selectedId) ?? null, [list, selectedId]);

  // The thread pane read or wrote: reflect it in the list and the nav badge at once.
  const onThread = useCallback(
    (t: ChatThread, unread?: ChatUnread) => {
      setList((cur) => {
        if (!cur) return cur;
        const i = cur.items.findIndex((x) => x.request.id === t.request.id);
        if (i < 0) return cur;
        const items = [...cur.items];
        const moved = items[i].lastMessage?.id !== t.lastMessage?.id;
        items[i] = t;
        if (moved && i > 0) items.unshift(items.splice(i, 1)[0]);
        return { ...cur, items, ...(unread ?? {}) };
      });
      if (unread) setUnread(unread);
    },
    [setUnread],
  );

  return (
    <>
      <h1 className="sr-only">Messages</h1>
      <div
        className="flex h-[calc(100dvh-7.5rem)] min-h-[520px] overflow-hidden rounded-2xl border border-line bg-white shadow-card max-sm:-mx-4 max-sm:-mt-6 max-sm:h-[calc(100dvh-3.5rem)] max-sm:rounded-none max-sm:border-x-0 max-sm:border-t-0"
        data-testid="messages"
      >
        {/* Conversations */}
        <section
          aria-label="Conversations"
          className={cn("flex w-full flex-col border-r border-line md:w-[340px] md:shrink-0 xl:w-[360px]", selectedId && "max-md:hidden")}
        >
          <div className="shrink-0 space-y-3 border-b border-line px-4 pb-3 pt-4">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-neutral-900">Messages</h2>
              {list && list.unread > 0 ? (
                <span className="tnum rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">{list.unread} unread</span>
              ) : null}
              {canCreate ? (
                <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="New request" title="New request" onClick={() => openDialog()}>
                  <Plus aria-hidden />
                </Button>
              ) : null}
            </div>
            {hasStaff ? (
              <Segmented
                label="Whose conversations"
                value={scope}
                onChange={setScope}
                options={SCOPES}
                className="w-full [&>button]:flex-1 [&>button]:justify-center"
              />
            ) : null}
            <SearchField value={query} onChange={setQuery} label="Search conversations" placeholder="Search by ticket, person or message" size="md" />
            <Segmented
              label="Show"
              value={filter}
              onChange={setFilter}
              options={FILTERS}
              className="w-full [&>button]:flex-1 [&>button]:justify-center"
            />
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="chat-list">
            {list === null && !error ? (
              <ListSkeleton />
            ) : error && !list ? (
              <div className="px-6 py-10 text-center text-[13px] text-neutral-500" role="alert">
                {error}
                <div className="mt-3">
                  <Button size="sm" onClick={reload}>
                    Try again
                  </Button>
                </div>
              </div>
            ) : list && list.items.length === 0 ? (
              debounced.trim() ? (
                <EmptyState icon={SearchX} title="No conversations match" description="Try a ticket number, a name or words from a message." />
              ) : (
                <EmptyState
                  icon={MessagesSquare}
                  title={
                    filter === "closed" ? "No resolved conversations" : scope === "mine" && hasStaff ? "Nothing assigned to you" : "No conversations yet"
                  }
                  description={
                    filter === "closed"
                      ? "Conversations on resolved, cancelled or rejected requests show up here."
                      : scope === "mine" && hasStaff
                        ? "Requests routed to you show up here. Switch to All IT to see unassigned ones."
                        : canCreate
                        ? "Every request you send to IT gets its own conversation with the person handling it."
                        : "Conversations appear here as soon as a request comes in."
                  }
                  action={
                    canCreate && filter !== "closed" ? (
                      <Button variant="primary" size="sm" onClick={() => openDialog()}>
                        <Plus aria-hidden />
                        New request
                      </Button>
                    ) : null
                  }
                />
              )
            ) : (
              <ul className="p-2" aria-label="Conversations">
                {list?.items.map((t) => (
                  <li key={t.request.id}>
                    <ConversationRow thread={t} active={t.request.id === selectedId} onSelect={() => select(t.request.id)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Thread */}
        <section aria-label="Conversation" className={cn("flex min-w-0 flex-1 flex-col bg-subtle/40", !selectedId && "max-md:hidden")}>
          {selectedId ? (
            <ThreadPane key={selectedId} id={selectedId} seed={seed} onBack={() => select(null)} onThread={onThread} />
          ) : (
            <EmptyState
              icon={MessagesSquare}
              title="Pick a conversation"
              description="Choose a request on the left to message the IT member handling it. Everything stays attached to the ticket."
              className="h-full"
            />
          )}
        </section>
      </div>
    </>
  );
}

function ConversationRow({ thread: t, active, onSelect }: { thread: ChatThread; active: boolean; onSelect: () => void }) {
  const r = t.request;
  const c = counterpart(t);
  const last = t.lastMessage;
  const unread = t.unread > 0;
  const closed = isClosed(r.status);
  const preview = last
    ? `${last.side === t.side ? (last.mine ? "You: " : `${last.side === "it" ? last.senderName : last.authorName}: `) : ""}${(last.body || (last.attachments?.length ? "Photo" : "")).replace(/\s+/g, " ")}`
    : "No messages yet — say hello";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/35",
        active ? "bg-accent-soft/70" : "hover:bg-neutral-900/[0.03]",
      )}
      data-testid="chat-row"
      data-unread={unread || undefined}
    >
      <CounterpartAvatar thread={t} className={cn(closed && "opacity-60")} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("truncate text-[13.5px] leading-5", unread ? "font-semibold text-neutral-900" : "font-medium text-neutral-800")}>{c.name}</span>
          {c.unassigned && t.side === "requester" ? <span className="shrink-0 text-[11px] text-neutral-400">Unassigned</span> : null}
          <span className={cn("tnum ml-auto shrink-0 text-[11px]", unread ? "font-medium text-accent-ink" : "text-neutral-400")}>{listTime(t.lastActivityAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-500">
          <span className="tnum shrink-0 font-mono text-[11px] font-medium text-neutral-600">{r.ticket}</span>
          <span aria-hidden className="text-neutral-300">·</span>
          <span className="truncate">{requestSummary(r)}</span>
          {closed ? <span className="ml-auto shrink-0 rounded-full bg-neutral-100 px-1.5 py-px text-[10.5px] font-medium text-neutral-500">Closed</span> : null}
        </span>
        <span className="mt-1 flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-5", unread ? "font-medium text-neutral-800" : last ? "text-neutral-500" : "italic text-neutral-400")}>{preview}</span>
          <UnreadBadge count={t.unread} />
        </span>
      </span>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex gap-3 px-3 py-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2 pt-0.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
