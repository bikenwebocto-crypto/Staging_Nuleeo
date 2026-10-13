import { useCallback } from "react";
import { useConfirm } from "@ui/components/common/ConfirmDialog";

// Wrap a drawer/dialog close handler so the user is warned before losing
// in-flight form state. The caller decides what "dirty" means (any field
// non-empty, isPending mutation, etc) and passes it in.
//
//   const { guardClose, guardDialog } = useUnsavedChangesGuard(isDirty);
//   <Drawer onOpenChange={(o) => o ? open() : guardClose(close)} />
//   {guardDialog}
//
// The dialog is built on ResponsiveDrawer + destructive ConfirmDialog —
// same look as every other confirmation in the product.
export function useUnsavedChangesGuard(isDirty: boolean) {
  const { confirm, dialog: guardDialog } = useConfirm();

  const guardClose = useCallback(
    async (close: () => void) => {
      if (!isDirty) {
        close();
        return;
      }
      const ok = await confirm({
        title: "Discard your changes?",
        description: "You have unsaved changes that will be lost. Continue?",
        confirmLabel: "Discard",
        tone: "destructive",
      });
      if (ok) close();
    },
    [isDirty, confirm],
  );

  return { guardClose, guardDialog };
}
