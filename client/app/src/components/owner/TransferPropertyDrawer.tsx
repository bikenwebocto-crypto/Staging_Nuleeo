import { Drawer } from "vaul";
import { useState } from "react";
import { useLocation } from "wouter";
import { X, Send, User, CheckCircle2 } from "lucide-react";
import { apiRequest, queryClient } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";

interface TransferPropertyDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  propertyId: string;
  propertyAddress: string;
}

export function TransferPropertyDrawer({
  open,
  onOpenChange,
  propertyId,
  propertyAddress,
}: TransferPropertyDrawerProps) {
  const [email, setEmail] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [step, setStep] = useState<"input" | "success">("input");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  // Destructive + irreversible: gate behind a typed confirmation that
  // matches the property address. Mirrors the DeletePropertyDialog
  // pattern. A misclicked or typo'd email — matching a real Olio user —
  // would silently move the property to a stranger without this gate.
  const confirmTarget = propertyAddress.trim();
  const isConfirmed =
    confirmText.trim().toLowerCase() === confirmTarget.toLowerCase() && confirmTarget.length > 0;

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    if (!isConfirmed) {
      toast({
        title: "Type the address to confirm",
        description: "Paste or type the property address exactly to confirm this transfer.",
        variant: "destructive",
      });
      return;
    }
    try {
      setIsSubmitting(true);
      await apiRequest("POST", `/api/properties/${propertyId}/transfer`, {
        recipientEmail: email.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/owner/properties"] });
      setStep("success");
    } catch (err: any) {
      toast({
        title: "Could not transfer property",
        description: err?.message ?? "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    const wasSuccess = step === "success";
    setTimeout(() => {
      setStep("input");
      setEmail("");
      setConfirmText("");
    }, 300);
    if (wasSuccess) navigate("/properties");
  };

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40 z-50 backdrop-blur-sm" />
        <Drawer.Content
          className="bg-card flex flex-col rounded-t-2xl fixed bottom-0 left-0 right-0 z-50 outline-none pb-8 w-full"
          style={{ maxHeight: "75vh" }}
        >
          <div className="p-4 bg-card rounded-t-[2rem] flex items-center justify-between border-b border-border relative">
            <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-border absolute top-3 left-1/2 -translate-x-1/2 mb-2" />
            <div className="w-8" />
            <h2 className="text-lg font-bold mt-2">Transfer Property</h2>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close transfer property dialog"
              className="p-2 bg-secondary rounded-full text-muted-foreground mt-2 hover:bg-secondary transition"
            >
              <X size={20} />
            </button>
          </div>

          <div className="p-6">
            {step === "input" ? (
              <form onSubmit={handleTransfer} className="space-y-6">
                <div className="bg-blue-500/10 p-4 rounded-xl border border-blue-500/20 text-sm text-blue-700 dark:text-blue-400 space-y-2">
                  <p>
                    Transferring <strong>{propertyAddress}</strong> immediately reassigns ownership
                    to the email below. The recipient must already have an Olio account.
                  </p>
                  <p className="text-xs opacity-90">
                    Your documents, transactions, and tenant history stay with your account — the
                    new owner starts with a clean property record.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-foreground ml-1">
                    New Owner Email
                  </label>
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                      <User size={18} />
                    </div>
                    <input
                      type="email"
                      required
                      placeholder="new.owner@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full bg-background border border-border rounded-xl pl-11 pr-4 py-3.5 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
                    />
                  </div>
                </div>

                {/* Typed confirmation — irreversible action, no undo from UI.
            User must type the property address verbatim before submit
            unlocks. Mirrors the DeletePropertyDialog pattern. */}
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-foreground ml-1">
                    Type the property address to confirm
                  </label>
                  <input
                    type="text"
                    placeholder={confirmTarget}
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    className="w-full bg-background border border-border rounded-xl px-4 py-3.5 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-destructive/20 focus:border-destructive/60 transition font-medium"
                  />
                  <p className="text-xs text-muted-foreground/80 ml-1">
                    Transfer is permanent and can't be reversed from the app.
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting || !isConfirmed || !email.trim()}
                  className="w-full bg-primary text-primary-foreground font-bold text-lg py-4 rounded-2xl shadow-lg shadow-primary/30 active:scale-[0.98] transition hover:bg-primary/90 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <Send size={20} /> {isSubmitting ? "Transferring…" : "Transfer Ownership"}
                </button>
              </form>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                <div className="w-20 h-20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center animate-in zoom-in duration-300">
                  <CheckCircle2 size={40} />
                </div>
                <h3 className="text-2xl font-bold text-foreground">Transfer Complete</h3>
                <p className="text-muted-foreground max-w-xs">
                  <strong>{propertyAddress}</strong> now belongs to <strong>{email}</strong>.
                </p>
                <button
                  onClick={handleClose}
                  className="w-full bg-secondary text-foreground font-bold py-3.5 rounded-xl hover:bg-secondary transition mt-4"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
