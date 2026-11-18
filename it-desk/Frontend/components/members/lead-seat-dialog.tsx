"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { SeatPicker } from "@/components/transfer/seat-picker";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import type { UnrosteredLead } from "@/lib/schemas";
import { useSeatIndex } from "@/store/selectors";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";

export function LeadSeatDialog({ lead, onClose }: { lead: UnrosteredLead; onClose: () => void }) {
  const workspace = useWorkspaceApi();
  const rules = useWorkspace(useShallow(({ currentTeamId, teams, members, memberIds, floors }) => ({ currentTeamId, teams, members, memberIds, floors })));
  const seatIndex = useSeatIndex();
  const [seatId, setSeatId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const seat = seatId ? seatIndex.get(seatId) : undefined;

  const assign = async () => {
    if (!seat || saving) return;
    setSaving(true);
    setError("");
    const result = await workspace.getState().assignLeadSeat(lead.id, seat.id);
    if (result.ok) {
      toast.success(`${lead.name} is now on Seat ${seat.code}`);
      onClose();
      return;
    }
    setError(result.error);
    if (result.fields?.seat || result.code === "seat_taken") setSeatId(null);
    setSaving(false);
  };

  return (
    <Modal
      open
      onOpenChange={(open) => { if (!open && !saving) onClose(); }}
      title={`Assign a seat to ${lead.name}`}
      description={rules.teams[lead.teamId]?.name}
      className="max-w-[640px]"
    >
      <ModalBody className="space-y-3">
        <SeatPicker
          rules={rules}
          destId={lead.teamId}
          anyZone
          internal={false}
          movers={[{ id: lead.id, name: lead.name, seatId: null, hue: 220, isLead: true }]}
          seats={seat ? { [lead.id]: seat.id } : {}}
          activeId={lead.id}
          onPick={(id) => {
            if (saving) return;
            setSeatId((selected) => selected === id ? null : id);
            setError("");
          }}
        />
        {seat ? <p className="text-sm font-medium text-neutral-800">Seat {seat.code} · {seat.floorName}</p> : null}
        {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
      </ModalBody>
      <ModalFooter>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void assign()} disabled={!seat || saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Assign seat
        </Button>
      </ModalFooter>
    </Modal>
  );
}
