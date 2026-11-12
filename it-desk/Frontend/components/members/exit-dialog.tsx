"use client";

import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { todayKey } from "@/lib/format";
import { exitFormSchema, toFieldErrors, type FieldErrors } from "@/lib/schemas";
import { cn, pluralize } from "@/lib/utils";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";
import { useUI, type ExitKind } from "@/store/ui-store";
import { notifyResult } from "@/components/undo-toast";
import { Button } from "@/components/ui/button";
import { Field, inputClass, textareaClass } from "@/components/ui/field";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";

export function ExitDialog() {
  const { open, nonce, kind, memberIds } = useUI(useShallow((s) => s.exit));
  const close = useUI((s) => s.closeExit);
  const names = useWorkspace(useShallow((s) => memberIds.map((id) => s.members[id]?.name ?? "")));
  const who = names.length === 1 ? names[0] : pluralize(names.length, "member");
  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? null : close())}
      title={kind === "resigned" ? `Mark ${who} as resigned` : `Mark ${who} as unknown`}
      description={
        kind === "resigned"
          ? "Their seat is released. IT will collect their devices."
          : "Use when you can’t confirm where someone is. Their seat is released."
      }
    >
      <ExitForm key={nonce} kind={kind} memberIds={memberIds} onDone={close} />
    </Modal>
  );
}

function ExitForm({ kind, memberIds, onDone }: { kind: ExitKind; memberIds: string[]; onDone: () => void }) {
  const api = useWorkspaceApi();
  const clearSelection = useUI((s) => s.clearSelection);
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayKey);
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = exitFormSchema.safeParse({ reason, effectiveDate });
    if (!parsed.success) return setErrors(toFieldErrors(parsed.error));
    // Optimistic: the roster updates and the dialog closes at once; a failure rolls back with a toast.
    const pending = api.getState().markExit({ memberIds, status: kind, ...parsed.data });
    clearSelection();
    onDone();
    void pending.then((result) =>
      notifyResult(api, result, {
        title: kind === "resigned" ? "Marked as resigned" : "Marked as unknown",
        description: result.ok ? `${pluralize(result.count, "seat")} released` : undefined,
      }),
    );
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <ModalBody className="space-y-1">
        <Field id="exit-reason" label={kind === "resigned" ? "Reason" : "What do you know?"} error={errors.reason}>
          <textarea
            id="exit-reason"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={Boolean(errors.reason)}
            placeholder={kind === "resigned" ? "e.g. Last day confirmed with HR" : "e.g. No response for two weeks"}
            className={textareaClass}
          />
        </Field>
        <Field id="exit-date" label="Effective date" error={errors.effectiveDate} className="max-w-[200px]">
          <input
            id="exit-date"
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            aria-invalid={Boolean(errors.effectiveDate)}
            className={cn(inputClass, "tnum")}
          />
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant={kind === "resigned" ? "danger" : "dark"}>
          {kind === "resigned" ? "Mark resigned" : "Mark unknown"}
        </Button>
      </ModalFooter>
    </form>
  );
}
