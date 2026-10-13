import { Button } from "@ui/components/ui/button";
import { Input } from "@ui/components/ui/input";
import { Label } from "@ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/components/ui/select";
import { Textarea } from "@ui/components/ui/textarea";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOwnerProperties, useUpdateOwnerTransaction } from "@/lib/ownerQueries";
import { apiRequest } from "@ui/lib/queryClient";
import { dateInputToIso, isoToDateInput } from "@ui/lib/format";
import { useToast } from "@ui/hooks/use-toast";
import type { TransactionCategory, TransactionType } from "@shared/firestore-schema";
import {
  Home,
  Wrench,
  Zap,
  Shield,
  FileText,
  Landmark,
  Briefcase,
  MoreHorizontal,
  Banknote,
  Coins,
  PaintBucket,
  Hammer,
  Loader2,
} from "lucide-react";
import { cn } from "@ui/lib/utils";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";

// The existing manual activity being corrected. Sourced from the owner's
// Transaction row on the Activity page. When present the dialog opens in edit
// mode: pre-filled, starting on the details step, and PATCHing instead of
// POSTing. `null`/absent = the normal "record a new activity" flow.
export interface EditActivityValues {
  id: string;
  propertyId: string;
  name: string;
  amount: number;
  type: TransactionType;
  category: TransactionCategory;
  timestamp: string; // ISO — the activity date
  notes?: string;
}

interface RecordActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: EditActivityValues | null;
}

// Each UI category maps to the small set of schema categories that the
// server accepts (rent | maintenance | tax | fee | other) plus a type
// (income | expense). The label is what the owner picks; `category` is what
// we send to the API.
type UiCategory = {
  id: string;
  label: string;
  type: "income" | "expense";
  category: "rent" | "maintenance" | "tax" | "fee" | "other";
  icon: typeof Home;
};

const CATEGORIES: UiCategory[] = [
  { id: "rent", label: "Rent Payment", type: "income", category: "rent", icon: Home },
  { id: "deposit", label: "Security Deposit", type: "income", category: "other", icon: Banknote },
  { id: "fee", label: "Service/Late Fee", type: "income", category: "fee", icon: Coins },
  {
    id: "maintenance",
    label: "Maintenance",
    type: "expense",
    category: "maintenance",
    icon: Wrench,
  },
  { id: "repair", label: "Repairs", type: "expense", category: "maintenance", icon: Hammer },
  { id: "tax", label: "Property Tax", type: "expense", category: "tax", icon: Landmark },
  { id: "insurance", label: "Insurance", type: "expense", category: "other", icon: Shield },
  { id: "utility", label: "Utilities", type: "expense", category: "other", icon: Zap },
  {
    id: "cleaning",
    label: "Cleaning",
    type: "expense",
    category: "maintenance",
    icon: PaintBucket,
  },
  { id: "management", label: "Management Fee", type: "expense", category: "fee", icon: Briefcase },
  { id: "mortgage", label: "Mortgage Payment", type: "expense", category: "other", icon: FileText },
  { id: "other", label: "Other", type: "expense", category: "other", icon: MoreHorizontal },
];

export function RecordActivityDialog({ open, onOpenChange, editing }: RecordActivityDialogProps) {
  const isEditing = !!editing;
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [date, setDate] = useState<string>(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const { data: properties = [] } = useOwnerProperties();
  const updateTransaction = useUpdateOwnerTransaction();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const reset = () => {
    setStep(1);
    setSelectedCategory(null);
    setPropertyId("");
    setAmount("");
    setDate(new Date().toISOString().split("T")[0]);
    setNotes("");
  };

  // Seed the form when the dialog opens. In edit mode, pre-fill from the row
  // and skip straight to the details step (matching the stored category back to
  // its picker tile by label, falling back to the type+category pair). In
  // create mode, start fresh. Keyed on the row id (not the object identity) so
  // an unrelated re-render while the dialog is open never clobbers an in-flight
  // edit.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      const cat =
        CATEGORIES.find((c) => c.label === editing.name) ??
        CATEGORIES.find((c) => c.category === editing.category && c.type === editing.type);
      setSelectedCategory(cat?.id ?? null);
      setPropertyId(editing.propertyId);
      setAmount(String(editing.amount));
      setDate(isoToDateInput(editing.timestamp) || new Date().toISOString().split("T")[0]);
      setNotes(editing.notes ?? "");
      // No category tile matched (unexpected — names come from this list) →
      // drop to step 1 so the owner re-picks rather than seeing a blank header.
      setStep(cat ? 2 : 1);
    } else {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Defer the reset so the close animation has the prior state to render.
      setTimeout(reset, 300);
    }
    onOpenChange(newOpen);
  };

  const handleCategorySelect = (categoryId: string) => {
    setSelectedCategory(categoryId);
    setStep(2);
  };

  const selectedCategoryData = CATEGORIES.find((c) => c.id === selectedCategory);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCategoryData) return;
    const amountNum = Number(amount);
    if (!propertyId) {
      toast({ title: "Pick a property", variant: "destructive" });
      return;
    }
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    // The picker only yields a calendar date; anchor it to the current local
    // time so the entry doesn't store midnight UTC (which renders as "03:00" in
    // Cyprus — see dateInputToIso). On edit, keep the original timestamp when
    // the day is unchanged so re-saving doesn't bump the recorded time.
    const timestamp =
      isEditing && editing && date === isoToDateInput(editing.timestamp)
        ? editing.timestamp
        : dateInputToIso(date);

    setSaving(true);
    try {
      if (isEditing && editing) {
        await updateTransaction.mutateAsync({
          id: editing.id,
          propertyId,
          name: selectedCategoryData.label,
          amount: amountNum,
          type: selectedCategoryData.type,
          category: selectedCategoryData.category,
          timestamp,
          notes,
          prevPropertyId: editing.propertyId,
        });
        toast({ title: "Transaction updated" });
        onOpenChange(false);
        setTimeout(reset, 300);
        return;
      }
      await apiRequest("POST", "/api/owner/transactions", {
        propertyId,
        name: selectedCategoryData.label,
        amount: amountNum,
        type: selectedCategoryData.type,
        category: selectedCategoryData.category,
        timestamp,
        notes,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/owner/transactions"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/owner/summary"] });
      // PropertyDetailsPage reads /api/properties/:id/transactions via
      // useOwnerPropertyTransactions — invalidate that too so YTD +
      // Recent Activity refresh after a maintenance entry.
      if (propertyId) {
        await queryClient.invalidateQueries({
          queryKey: [`/api/properties/${propertyId}/transactions`],
        });
      }
      toast({ title: "Transaction recorded" });
      onOpenChange(false);
      setTimeout(reset, 300);
    } catch (err) {
      toast({
        title: "Could not save",
        description: (err as Error)?.message ?? "Try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const title =
    step === 1 ? "Select Category" : isEditing ? "Edit Transaction" : "Record Transaction";
  const subtitle =
    step === 1
      ? "Choose the type of income or expense to record."
      : `${isEditing ? "Update" : "Enter"} details for ${selectedCategoryData?.label.toLowerCase() ?? ""}.`;

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      subtitle={subtitle}
      onBack={step === 2 ? () => setStep(1) : undefined}
      footer={
        step === 2 ? (
          <Button
            type="submit"
            form="record-activity-form"
            disabled={saving}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-bold h-11"
          >
            {saving ? <Loader2 size={16} className="animate-spin mr-2" /> : null}
            {saving ? "Saving…" : isEditing ? "Save Changes" : "Save Record"}
          </Button>
        ) : undefined
      }
    >
      {step === 1 ? (
        <div className="grid grid-cols-2 gap-3">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => handleCategorySelect(cat.id)}
              className={cn(
                "flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-border hover:border-primary/50 hover:bg-secondary/50 transition duration-200 group text-center h-24",
                cat.type === "income" ? "hover:bg-emerald-50/50" : "hover:bg-red-50/50",
              )}
            >
              <cat.icon
                size={24}
                className={cn(
                  "transition-colors",
                  cat.type === "income"
                    ? "text-emerald-600 dark:text-emerald-400 group-hover:text-emerald-700"
                    : "text-red-500 dark:text-red-400 group-hover:text-red-600",
                )}
              />
              <span className="text-sm font-medium text-foreground">{cat.label}</span>
            </button>
          ))}
        </div>
      ) : (
        <form id="record-activity-form" onSubmit={handleSubmit} className="grid gap-4">
          <div className="flex items-center gap-3 p-3 bg-secondary/30 rounded-xl">
            <div
              className={cn(
                "w-10 h-10 rounded-full flex items-center justify-center",
                selectedCategoryData?.type === "income"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-red-500/10 text-red-600 dark:text-red-400",
              )}
            >
              {selectedCategoryData && <selectedCategoryData.icon size={20} />}
            </div>
            <div>
              <p className="font-semibold text-sm">{selectedCategoryData?.label}</p>
              <p className="text-xs text-muted-foreground capitalize">
                {selectedCategoryData?.type}
              </p>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="property">Property</Label>
            <Select value={propertyId} onValueChange={setPropertyId}>
              <SelectTrigger id="property">
                <SelectValue placeholder="Select property" />
              </SelectTrigger>
              <SelectContent className="z-[70]">
                {properties.map((prop) => (
                  <SelectItem key={prop.id} value={prop.id}>
                    {prop.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="amount">Amount (€)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold">
                  €
                </span>
                <Input
                  id="amount"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="pl-7 font-semibold"
                  autoFocus
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="date">Date</Label>
              {/* Owners back-date entries but never record activity in the
                  future — clamp max to today, matching MakePaymentDrawer. */}
              <Input
                id="date"
                type="date"
                value={date}
                max={new Date().toISOString().split("T")[0]}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add details about this transaction..."
              className="resize-none h-24"
            />
          </div>
        </form>
      )}
    </ResponsiveDrawer>
  );
}
