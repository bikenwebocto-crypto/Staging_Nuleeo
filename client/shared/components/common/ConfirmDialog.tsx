import { ReactNode, useCallback, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";

type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Style the primary button. "destructive" = red. Default = primary tone.
  tone?: "destructive" | "default";
};

// Promise-based replacement for window.confirm(). Drop {dialog} into JSX,
// then `await confirm({title, ...})` from any handler — resolves true on
// confirm, false on cancel/close. One instance per component is enough.
export function useConfirm() {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setOpts(options);
      resolverRef.current = resolve;
      setOpen(true);
    });
  }, []);

  const handle = useCallback((result: boolean) => {
    setOpen(false);
    const resolver = resolverRef.current;
    resolverRef.current = null;
    // Defer so the close animation can play before the caller's next step.
    queueMicrotask(() => resolver?.(result));
  }, []);

  const isDestructive = opts?.tone === "destructive";

  const dialog = (
    <ResponsiveDrawer
      open={open}
      onOpenChange={(next) => {
        if (!next) handle(false);
      }}
      title={opts?.title ?? ""}
      desktopMaxWidth="max-w-[420px]"
      footer={
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => handle(false)}
            className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {opts?.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => handle(true)}
            className={
              isDestructive
                ? "flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold transition bg-destructive text-destructive-foreground hover:bg-destructive/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                : "flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold transition bg-primary text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            }
          >
            {opts?.confirmLabel ?? "Confirm"}
          </button>
        </div>
      }
    >
      <div className="flex items-start gap-3">
        {isDestructive && (
          <div className="w-10 h-10 rounded-full bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
            <AlertTriangle size={18} />
          </div>
        )}
        <div className="text-sm text-foreground/80 leading-relaxed">
          {opts?.description ?? null}
        </div>
      </div>
    </ResponsiveDrawer>
  );

  return { confirm, dialog };
}
