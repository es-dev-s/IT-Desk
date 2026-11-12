import { create } from "zustand";
import { MEMBER_PAGE_SIZE } from "@/lib/constants";
import type { MemberStatus, TransferMode } from "@/lib/schemas";

export type MembersView = "grid" | "list" | "map";
export type MemberSort = "seat" | "name";
export type ExitKind = "resigned" | "unknown";

/**
 * Overlays keep their payload after closing (`open: false`) so their content
 * stays rendered while the exit animation plays. Opening bumps `nonce`, which
 * keys the form and resets it.
 */
type Overlay<T> = { open: boolean; nonce: number } & T;

type UIState = {
  mobileNavOpen: boolean;
  paletteOpen: boolean;
  transfer: Overlay<{ memberIds: string[]; mode: TransferMode }>;
  exit: Overlay<{ kind: ExitKind; memberIds: string[] }>;
  detail: Overlay<{ transferId: string | null }>;
  /** Add (memberId null) or edit a member. */
  memberDialog: Overlay<{ memberId: string | null }>;
  members: {
    view: MembersView;
    query: string;
    status: "all" | MemberStatus;
    subGroup: string;
    sort: MemberSort;
    selected: Record<string, true>;
    visible: number;
  };
  setMobileNavOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  openTransfer: (memberIds?: string[], mode?: TransferMode) => void;
  closeTransfer: () => void;
  openExit: (kind: ExitKind, memberIds: string[]) => void;
  closeExit: () => void;
  openDetail: (transferId: string) => void;
  closeDetail: () => void;
  openMemberDialog: (memberId?: string | null) => void;
  closeMemberDialog: () => void;
  setMembers: (patch: Partial<UIState["members"]>) => void;
  toggleSelected: (memberId: string) => void;
  setSelection: (memberIds: string[]) => void;
  clearSelection: () => void;
  resetMemberFilters: () => void;
};

let nonce = 0;

export const useUI = create<UIState>()((set) => ({
  mobileNavOpen: false,
  paletteOpen: false,
  transfer: { open: false, nonce: 0, memberIds: [], mode: "internal" },
  exit: { open: false, nonce: 0, kind: "resigned", memberIds: [] },
  detail: { open: false, nonce: 0, transferId: null },
  memberDialog: { open: false, nonce: 0, memberId: null },
  members: {
    view: "grid",
    query: "",
    status: "active",
    subGroup: "all",
    sort: "seat",
    selected: {},
    visible: MEMBER_PAGE_SIZE,
  },
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openTransfer: (memberIds = [], mode = "internal") =>
    set({ transfer: { open: true, nonce: ++nonce, memberIds, mode }, paletteOpen: false }),
  closeTransfer: () => set((s) => ({ transfer: { ...s.transfer, open: false } })),
  openExit: (kind, memberIds) => set({ exit: { open: true, nonce: ++nonce, kind, memberIds } }),
  closeExit: () => set((s) => ({ exit: { ...s.exit, open: false } })),
  openDetail: (transferId) => set({ detail: { open: true, nonce: ++nonce, transferId } }),
  closeDetail: () => set((s) => ({ detail: { ...s.detail, open: false } })),
  openMemberDialog: (memberId = null) => set({ memberDialog: { open: true, nonce: ++nonce, memberId }, paletteOpen: false }),
  closeMemberDialog: () => set((s) => ({ memberDialog: { ...s.memberDialog, open: false } })),
  setMembers: (patch) =>
    set((s) => {
      const filterChanged = "query" in patch || "status" in patch || "subGroup" in patch || "sort" in patch;
      return {
        members: {
          ...s.members,
          ...patch,
          visible: patch.visible ?? (filterChanged ? MEMBER_PAGE_SIZE : s.members.visible),
        },
      };
    }),
  toggleSelected: (id) =>
    set((s) => {
      const selected = { ...s.members.selected };
      if (selected[id]) delete selected[id];
      else selected[id] = true;
      return { members: { ...s.members, selected } };
    }),
  setSelection: (ids) =>
    set((s) => ({
      members: { ...s.members, selected: Object.fromEntries(ids.map((id) => [id, true as const])) },
    })),
  clearSelection: () => set((s) => ({ members: { ...s.members, selected: {} } })),
  resetMemberFilters: () =>
    set((s) => ({
      members: { ...s.members, query: "", status: "active", subGroup: "all", visible: MEMBER_PAGE_SIZE },
    })),
}));
