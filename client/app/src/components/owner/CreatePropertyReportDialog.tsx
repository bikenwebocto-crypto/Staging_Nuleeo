import { useState } from "react";
import { Building, Loader2 } from "lucide-react";
import { Button } from "@ui/components/ui/button";
import { Label } from "@ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/components/ui/select";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { useOwnerProperties } from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { useToast } from "@ui/hooks/use-toast";
import { openBriefing } from "@ui/lib/briefing";

interface CreatePropertyReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Prompts the owner to pick one property, then generates that property's
// report PDF through the same briefing gateway as the portfolio briefing —
// only with a propertyId (server renders the single-property variant, gated
// on briefing.property). Active-portfolio scoped so a granted contact gets
// the right portfolio's properties and plan.
export function CreatePropertyReportDialog({
  open,
  onOpenChange,
}: CreatePropertyReportDialogProps) {
  const { data: properties } = useOwnerProperties();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const { plan: activePlan } = useActivePortfolioPlan();
  const canPrintBriefing = useCanOwnerPlan(activePlan)("briefing.property");
  const { toast } = useToast();

  const [propertyId, setPropertyId] = useState("");
  const [generating, setGenerating] = useState(false);

  const propertyList = properties ?? [];

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setPropertyId("");
      setGenerating(false);
    }
    onOpenChange(next);
  };

  const handleGenerate = async () => {
    if (!canPrintBriefing) {
      toast({
        title: "Property reports are a premium feature",
        description: "Upgrade your plan to download a property report as a PDF.",
      });
      return;
    }
    if (!propertyId) return;
    setGenerating(true);
    const r = await openBriefing(
      { propertyId },
      { ownerId: activeOwnerId, isSelf, portfolioDocId: activePortfolioDocId },
    );
    setGenerating(false);
    if (!r.ok) {
      toast({ title: "Report failed", description: r.error, variant: "destructive" });
      return;
    }
    handleOpenChange(false);
  };

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={handleOpenChange}
      title="Create property report"
      subtitle="Choose a property to generate its report"
      footer={
        <Button
          onClick={handleGenerate}
          disabled={generating || !propertyId}
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-bold h-11"
        >
          {generating ? <Loader2 size={16} className="animate-spin mr-2" /> : null}
          {generating ? "Generating…" : "Generate report"}
        </Button>
      }
    >
      <div className="grid gap-2">
        <Label htmlFor="report-property">Property</Label>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger id="report-property">
            <div className="flex items-center gap-2 min-w-0">
              <Building size={14} className="text-muted-foreground shrink-0" />
              <SelectValue placeholder="Select property" />
            </div>
          </SelectTrigger>
          <SelectContent className="z-[70]">
            {propertyList.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name?.trim() || p.address}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {propertyList.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            You don't have any properties yet. Add a property first.
          </p>
        ) : null}
      </div>
    </ResponsiveDrawer>
  );
}
