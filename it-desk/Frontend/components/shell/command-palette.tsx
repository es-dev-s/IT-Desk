"use client";

import * as RD from "@radix-ui/react-dialog";
import { ArrowLeftRight, CornerDownLeft, LifeBuoy, Search, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { navFor } from "@/lib/nav";
import { useSession } from "@/components/auth/session-provider";
import { cn } from "@/lib/utils";
import { useActiveMembers, useTransfers } from "@/store/selectors";
import { useUI } from "@/store/ui-store";
import { useRequests } from "@/store/requests-store";
import { EMPTY_REQUEST_FORM } from "@/lib/requests";
import { Avatar } from "@/components/ui/avatar";
import { ItStatusGlyph } from "@/components/ui/status";

type Item = {
  id: string;
  group: string;
  label: string;
  meta?: string;
  leading: React.ReactNode;
  run: () => void;
};

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPaletteOpen);
  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-neutral-950/20 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RD.Content
          aria-describedby={undefined}
          className="fixed inset-x-4 top-[14vh] z-50 mx-auto max-w-[560px] overflow-hidden rounded-[var(--radius-overlay)] bg-white shadow-overlay outline-none data-[state=closed]:animate-dialog-out data-[state=open]:animate-dialog-in"
        >
          <RD.Title className="sr-only">Search</RD.Title>
          <PaletteBody onClose={() => setOpen(false)} />
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const members = useActiveMembers();
  const transfers = useTransfers();
  const openTransfer = useUI((s) => s.openTransfer);
  const openDetail = useUI((s) => s.openDetail);
  const { session, can } = useSession();
  const canTransfer = can("transfers.create");
  const canRequest = can("requests.create");
  const openRequest = useRequests((s) => s.openDialog);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));
    // A group (Reports) is listed as its sub-pages.
    const pages: Item[] = navFor(session.permissions)
      .flatMap((n) => (n.children?.length ? n.children.map((c) => ({ ...n, href: c.href, label: c.label })) : [n]))
      .filter((n) => match(n.label)).map((n) => ({
      id: `page:${n.href}`,
      group: "Go to",
      label: n.label,
      leading: <n.icon className="size-4 text-neutral-400" aria-hidden />,
      run: () => router.push(n.href),
    }));
    const people: Item[] = (canTransfer ? members : [])
      .filter((m) => match(m.name, m.seat ?? "", m.subGroup))
      .slice(0, q ? 8 : 4)
      .map((m) => ({
        id: `member:${m.id}`,
        group: "Transfer a member",
        label: m.name,
        meta: m.seat ? `Seat ${m.seat}` : "",
        leading: <Avatar name={m.name} hue={m.hue} size="xs" />,
        run: () => openTransfer([m.id]),
      }));
    const tickets: Item[] = transfers
      .filter((t) => match(t.ticket, ...t.moves.map((mv) => mv.memberName)))
      .slice(0, q ? 6 : 3)
      .map((t) => ({
        id: `ticket:${t.id}`,
        group: "Device moves",
        label: `${t.ticket} · ${t.moves.map((mv) => mv.memberName.split(" ")[0]).join(", ")}`,
        leading: <ItStatusGlyph status={t.itStatus} />,
        run: () => openDetail(t.id),
      }));
    const actions: Item[] = [
      ...(canTransfer && match("new transfer", "move")
        ? [
            {
              id: "action:new",
              group: "Actions",
              label: "New transfer",
              leading: <ArrowLeftRight className="size-4 text-neutral-400" aria-hidden />,
              run: () => openTransfer([]),
            },
          ]
        : []),
      ...(canRequest && match("request it", "laptop", "headphone", "mouse", "cpu", "equipment")
        ? [
            {
              id: "action:request",
              group: "Actions",
              label: "Request IT",
              meta: "R",
              leading: <LifeBuoy className="size-4 text-neutral-400" aria-hidden />,
              run: () => openRequest(),
            },
          ]
        : []),
      ...(canRequest && match("report an issue", "issue", "broken", "problem", "network", "wifi", "software", "access", "password")
        ? [
            {
              id: "action:issue",
              group: "Actions",
              label: "Report an IT issue",
              leading: <TriangleAlert className="size-4 text-neutral-400" aria-hidden />,
              run: () => openRequest({ ...EMPTY_REQUEST_FORM, type: "issue" }),
            },
          ]
        : []),
    ];
    return [...actions, ...people, ...tickets, ...pages];
  }, [query, members, transfers, router, openTransfer, openDetail, canTransfer, canRequest, openRequest, session.permissions]);

  const current = Math.min(active, Math.max(items.length - 1, 0));
  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          setActive((current + delta + items.length) % Math.max(items.length, 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          run(items[current]);
        }
      }}
    >
      <div className="flex h-12 items-center gap-3 border-b border-line px-4">
        <Search className="size-4 text-neutral-400" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Search people, seats or tickets"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={items[current] ? `palette-${current}` : undefined}
          className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
        />
      </div>
      <ul id="palette-list" role="listbox" className="scrollbar-thin max-h-[52vh] overflow-y-auto p-2">
        {items.length === 0 ? <li className="px-3 py-10 text-center text-[13px] text-neutral-500">No results</li> : null}
        {items.map((item, i) => (
          <li key={item.id} role="presentation">
            {i === 0 || items[i - 1].group !== item.group ? (
              <p className="px-2 pb-1 pt-3 text-xs font-medium text-neutral-400 first:pt-1">{item.group}</p>
            ) : null}
            <div
              id={`palette-${i}`}
              role="option"
              aria-selected={i === current}
              onMouseMove={() => setActive(i)}
              onClick={() => run(item)}
              className={cn(
                "flex h-9 cursor-default items-center gap-3 rounded-lg px-2 text-[13px] text-neutral-800",
                i === current && "bg-neutral-900/[0.05]",
              )}
            >
              {item.leading}
              <span className="truncate">{item.label}</span>
              {item.meta ? <span className="tnum ml-auto font-mono text-xs text-neutral-500">{item.meta}</span> : null}
              {i === current ? <CornerDownLeft className={cn("size-3.5 text-neutral-400", !item.meta && "ml-auto")} aria-hidden /> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
