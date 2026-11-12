"use client";

import { ArrowRight, Loader2, UserMinus, Users } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiError, floorsApi } from "@/lib/api";
import type { AffectedMember, ConflictMode, ZoneChangeResult } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { useTeamColors, useTeamsById } from "@/store/selectors";
import { useWorkspaceApi } from "@/store/workspace-provider";
import { seatLabel } from "@/lib/floors";

/**
 * A zone change the admin is about to make (assign seats to a team, unassign,
 * move a team's zone). `run` calls the API; the hook previews it first and,
 * if people are sitting on the seats, asks what should happen to them.
 */
export type ZoneOp = {
  /** Toast text when it's done, e.g. "Victoria now has 12 seats on Level 4". */
  done: string;
  /** Dialog title, e.g. "Move Victoria to Level 3 (A)?". */
  title: string;
  run: (opts: { onConflict: ConflictMode; dryRun: boolean }) => Promise<ZoneChangeResult>;
  /** Not an undoable zone change (e.g. publishing a layout): just confirm when done. */
  noUndo?: boolean;
  /** Called after it's applied (and the workspace refreshed). */
  onDone?: () => void;
};

type Pending = {
  op: ZoneOp;
  /** Preview with the default mode: displaced people show as "conflict". */
  plain: ZoneChangeResult;
  /** Preview with relocate: where they'd be moved along to. */
  relocate: ZoneChangeResult | null;
};

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

export function useZoneAction() {
  const api = useWorkspaceApi();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<ConflictMode | "preview" | null>(null);

  const apply = useCallback(
    async (op: ZoneOp, mode: ConflictMode) => {
      setBusy(mode);
      try {
        const res = await op.run({ onConflict: mode, dryRun: false });
        setPending(null);
        await api.getState().refresh();
        op.onDone?.();
        if (op.noUndo) {
          const moved = res.affected.length;
          toast.success(op.done, { description: moved ? `${moved} ${moved === 1 ? "person" : "people"} moved or unseated. Leads and IT were notified.` : undefined });
          return;
        }
        if (!res.id) {
          toast.message("Nothing to change", { description: "Those seats already look like that." });
          return;
        }
        const id = res.id;
        const moved = res.affected.filter((a) => a.action !== "keep").length;
        toast.success(op.done, {
          description: moved ? `${moved} ${moved === 1 ? "person" : "people"} moved or unseated. Leads and IT were notified.` : undefined,
          duration: 12_000,
          action: {
            label: "Undo",
            onClick: () => {
              void floorsApi
                .undoZoneChange(id)
                .then(() => api.getState().refresh())
                .then(() => toast.success("Undone"))
                .catch((e) => toast.error(errText(e)));
            },
          },
        });
      } catch (e) {
        if (e instanceof ApiError && e.code === "zone_conflict") {
          // Someone sat down meanwhile: show who and ask again.
          try {
            const [plain, relocate] = await Promise.all([
              op.run({ onConflict: "", dryRun: true }),
              op.run({ onConflict: "relocate", dryRun: true }),
            ]);
            setPending({ op, plain, relocate });
          } catch (e2) {
            toast.error(errText(e2));
          }
          return;
        }
        toast.error(errText(e));
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  const execute = useCallback(
    async (op: ZoneOp) => {
      setBusy("preview");
      try {
        const plain = await op.run({ onConflict: "", dryRun: true });
        if (plain.affected.length === 0) {
          setBusy(null);
          await apply(op, "");
          return;
        }
        const conflicts = plain.affected.some((a) => a.action === "conflict");
        const relocate = conflicts ? await op.run({ onConflict: "relocate", dryRun: true }) : null;
        setPending({ op, plain, relocate });
      } catch (e) {
        toast.error(errText(e));
      } finally {
        setBusy((b) => (b === "preview" ? null : b));
      }
    },
    [apply],
  );

  const dialog = (
    <ConflictDialog
      pending={pending}
      busy={busy}
      onCancel={() => busy === null && setPending(null)}
      onApply={(mode) => pending && void apply(pending.op, mode)}
    />
  );

  return { execute, dialog, busy: busy !== null };
}

function ConflictDialog({
  pending,
  busy,
  onCancel,
  onApply,
}: {
  pending: Pending | null;
  busy: ConflictMode | "preview" | null;
  onCancel: () => void;
  onApply: (mode: ConflictMode) => void;
}) {
  const teams = useTeamsById();
  const colors = useTeamColors();
  const affected = pending?.plain.affected ?? [];
  const displaced = affected.filter((a) => a.action === "conflict");
  const carried = affected.filter((a) => a.action !== "conflict");
  const where = new Map((pending?.relocate?.affected ?? []).map((a) => [a.memberId, a]));
  const hasConflicts = displaced.length > 0;

  const row = (a: AffectedMember, after: AffectedMember | undefined) => {
    const target = after ?? a;
    const c = colors[a.teamId];
    const dest =
      target.action === "unseat" || (target.action === "conflict" && !target.toSeat) ? (
        <span className="text-amber-700">{hasConflicts && a.action === "conflict" ? "no free seat in their zone → unseated" : "no free seat → unseated"}</span>
      ) : (
        <span className="tnum text-neutral-800">{seatLabel(target.toSeat)}</span>
      );
    return (
      <li key={a.memberId} className="flex items-center gap-2 py-1.5 text-[13px]" data-testid="conflict-person">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: c?.fill ?? "#bbb" }} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-neutral-900">{a.name}</span>
          <span className="text-neutral-500"> · {teams[a.teamId]?.name ?? "Unknown team"}</span>
        </span>
        <span className="tnum text-neutral-500">{seatLabel(a.fromSeat)}</span>
        <ArrowRight className="size-3.5 text-neutral-400" aria-hidden />
        {dest}
      </li>
    );
  };

  return (
    <Modal
      open={pending !== null}
      onOpenChange={(o) => !o && onCancel()}
      title={pending?.op.title ?? ""}
      description={
        hasConflicts
          ? `${displaced.length} ${displaced.length === 1 ? "person from another team is" : "people from other teams are"} sitting on these seats. What should happen to them?`
          : `${carried.length} ${carried.length === 1 ? "person moves" : "people move"} with this change.`
      }
      className="max-w-[540px]"
    >
      <div data-testid="zone-conflict-dialog" className="contents">
        <ModalBody className="space-y-4">
          {displaced.length ? (
            <section>
              <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-neutral-500">Seated there now</h3>
              <ul className="divide-y divide-line">{displaced.map((a) => row(a, where.get(a.memberId)))}</ul>
              <p className="mt-1 text-[12px] text-neutral-500">“Move them along” puts each person on a free seat in their own team’s zone.</p>
            </section>
          ) : null}
          {carried.length ? (
            <section>
              <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-neutral-500">Moving with the zone</h3>
              <ul className="divide-y divide-line">{carried.map((a) => row(a, undefined))}</ul>
            </section>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy !== null} data-testid="conflict-cancel">
            Cancel
          </Button>
          {hasConflicts ? (
            <>
              <Button onClick={() => onApply("unseat")} disabled={busy !== null} data-testid="conflict-unseat">
                {busy === "unseat" ? <Loader2 className="animate-spin" /> : <UserMinus />}
                Unseat them
              </Button>
              <Button variant="primary" onClick={() => onApply("relocate")} disabled={busy !== null} data-testid="conflict-relocate">
                {busy === "relocate" ? <Loader2 className="animate-spin" /> : <Users />}
                Move them along
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => onApply("")} disabled={busy !== null} data-testid="conflict-apply">
              {busy === "" ? <Loader2 className="animate-spin" /> : null}
              Apply
            </Button>
          )}
        </ModalFooter>
      </div>
    </Modal>
  );
}
