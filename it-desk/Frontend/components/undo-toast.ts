import { toast } from "sonner";
import type { ActionResult, WorkspaceStoreApi } from "@/store/workspace-store";

/**
 * Success toast with Undo (only while the server's undo window is open), or an
 * error toast. Undo calls the API, which re-checks conflicts transactionally.
 */
export function notifyResult(
  api: WorkspaceStoreApi,
  result: ActionResult,
  copy: { title: string; description?: string; undoable?: boolean },
) {
  if (!result.ok) {
    toast.error("Couldn’t complete that", { description: result.error });
    return;
  }
  const undoable = copy.undoable !== false && api.getState().canUndo(result.undoKey);
  toast.success(copy.title, {
    description: copy.description,
    duration: 6000,
    action: undoable
      ? {
          label: "Undo",
          onClick: () => {
            const id = toast.loading("Undoing…");
            void api
              .getState()
              .undo(result.undoKey)
              .then((undone) => {
                if (undone.ok) toast.success("Change undone", { id });
                else toast.error("Couldn’t undo", { id, description: undone.error });
              });
          },
        }
      : undefined,
  });
}
