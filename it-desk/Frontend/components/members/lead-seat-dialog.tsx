"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { SeatPicker } from "@/components/transfer/seat-picker";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { useSession } from "@/components/auth/session-provider";
import type { Member, UnrosteredLead } from "@/lib/schemas";
import { useSeatIndex } from "@/store/selectors";
import { useUI } from "@/store/ui-store";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";

/** Mounted once in the app shell; the members page and the detail sheet open it via `openLeadSeat`. */
export function LeadSeatHost() {
  const leadId = useUI((s) => s.leadSeatId);
  const close = useUI((s) => s.closeLeadSeat);
  const { can } = useSession();
  const lead = useWorkspace((s) => (leadId ? s.members[leadId] ?? s.unrosteredLeads.find((entry) => entry.id === leadId) : undefined));
  if (!lead || !can("seats.assign")) return null;
  return <LeadSeatDialog key={lead.id} lead={lead} onClose={close} />;
}

/**
 * Seat a team lead: an unrostered lead gets a roster record on first seating;
 * a rostered lead is moved. Admins may pick any free seat, a lead only seats
 * themselves in their own team's zone (free zoneless seats join it).
 */
export function LeadSeatDialog({ lead, onClose }: { lead: UnrosteredLead | Member; onClose: () => void }) {
  const { session } = useSession();
  const isAdmin = session.user.role === "admin";
  const rostered = "status" in lead;
  const currentSeatId = rostered ? (lead.seatId ?? null) : null;
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
    const result = rostered
      ? await workspace.getState().assignSeat(lead.id, seat.id)
      : await workspace.getState().assignLeadSeat(lead.id, seat.id);
    if (result.ok) {
      toast.success(isAdmin ? `${lead.name} is now on Seat ${seat.code}` : `You moved to Seat ${seat.code}`);
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
      title={rostered ? `Change ${lead.name}'s seat` : `Assign a seat to ${lead.name}`}
      description={rules.teams[lead.teamId]?.name}
      className="max-w-[640px]"
    >
      <ModalBody className="space-y-3">
        <SeatPicker
          rules={rules}
          destId={lead.teamId}
          anyZone={isAdmin}
          claimNoZone={!isAdmin}
          internal={rostered}
          movers={[{ id: lead.id, name: lead.name, seatId: currentSeatId, hue: rostered ? lead.hue : 220, isLead: true }]}
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
          {rostered ? "Move seat" : "Assign seat"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
