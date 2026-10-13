import { useState, useEffect, useCallback, useMemo } from "react";
import { Eye, Code, Save, RotateCcw } from "lucide-react";
import { cn } from "@ui/lib/utils";
import { useToast } from "@ui/hooks/use-toast";
import {
  type ComplianceDocKey,
  useComplianceDocs,
  saveComplianceDoc,
  defaultDocs,
} from "@ui/lib/complianceStore";
import { sanitizeComplianceHtml } from "@ui/lib/sanitizeHtml";
import { COMPLIANCE_DOC_GROUPS } from "@shared/firestore-schema";

type Tab = ComplianceDocKey;
type ViewMode = "editor" | "preview" | "split";

// Flat label lookup derived from the grouped definition in firestore-schema.
const tabLabels: Record<Tab, string> = COMPLIANCE_DOC_GROUPS.reduce(
  (acc, g) => {
    for (const d of g.docs) acc[d.key] = d.label;
    return acc;
  },
  {} as Record<Tab, string>,
);

export function ComplianceEditor() {
  const [activeGroup, setActiveGroup] = useState<string>(COMPLIANCE_DOC_GROUPS[0]?.group ?? "Core");
  const [activeTab, setActiveTab] = useState<Tab>("terms");
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const { docs, loading } = useComplianceDocs();
  // Per-tab drafts: switching tabs used to silently drop the previous
  // tab's unsaved content (and the "Save" button would happily write the
  // wrong content to the wrong doc). Each tab now holds its own draft so
  // the user can move between them without losing work.
  const [drafts, setDrafts] = useState<Partial<Record<Tab, string>>>({});
  const [dirty, setDirty] = useState<Partial<Record<Tab, boolean>>>({});
  const htmlContent = drafts[activeTab] ?? docs[activeTab] ?? "";
  const hasChanges = Boolean(dirty[activeTab]);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  // Flat list of every editable doc key (drawn from the grouped definition
  // in the schema), so the effect below only iterates real document tabs and
  // never picks up metadata fields like updatedAt / updatedBy.
  const allDocKeys = useMemo<Tab[]>(
    () => COMPLIANCE_DOC_GROUPS.flatMap((g) => g.docs.map((d) => d.key)),
    [],
  );

  // When the server pushes a fresh version of a doc the user hasn't edited
  // locally, pick it up. Tabs the user IS editing stay on their draft.
  useEffect(() => {
    if (loading) return;
    setDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of allDocKeys) {
        const serverVal = docs[key];
        if (!dirty[key] && next[key] !== serverVal) {
          next[key] = serverVal;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [docs, loading, dirty, allDocKeys]);

  const handleContentChange = useCallback(
    (value: string) => {
      setDrafts((prev) => ({ ...prev, [activeTab]: value }));
      setDirty((prev) => ({ ...prev, [activeTab]: true }));
    },
    [activeTab],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveComplianceDoc(activeTab as ComplianceDocKey, htmlContent);
      setDirty((prev) => ({ ...prev, [activeTab]: false }));
      toast({
        title: "Document saved",
        description: `${tabLabels[activeTab]} has been updated and is now live.`,
      });
    } catch (err: any) {
      toast({
        title: "Save failed",
        description: err?.message ?? "Could not update document.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const defaultContent = defaultDocs[activeTab];
    setSaving(true);
    try {
      await saveComplianceDoc(activeTab as ComplianceDocKey, defaultContent);
      setDrafts((prev) => ({ ...prev, [activeTab]: defaultContent }));
      setDirty((prev) => ({ ...prev, [activeTab]: false }));
      toast({
        title: "Document reset",
        description: `${tabLabels[activeTab]} has been reset to defaults.`,
      });
    } catch (err: any) {
      toast({
        title: "Reset failed",
        description: err?.message ?? "Could not reset document.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const groupTabs = useMemo(
    () =>
      COMPLIANCE_DOC_GROUPS.find((g) => g.group === activeGroup)?.docs ??
      COMPLIANCE_DOC_GROUPS[0]?.docs ??
      [],
    [activeGroup],
  );

  // If the user picks a new group, snap the active tab to the first doc in
  // that group so the editor never shows a tab that isn't in the visible row.
  useEffect(() => {
    if (!groupTabs.some((t) => t.key === activeTab)) {
      if (groupTabs[0]) setActiveTab(groupTabs[0].key);
    }
  }, [groupTabs, activeTab]);

  const viewModes: { key: ViewMode; icon: typeof Code; label: string }[] = [
    { key: "editor", icon: Code, label: "Editor" },
    { key: "split", icon: Eye, label: "Split" },
    { key: "preview", icon: Eye, label: "Preview" },
  ];

  return (
    <div className="space-y-4">
      <div className="bg-card p-4 rounded-xl border border-border shadow-sm space-y-4">
        <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-1">
          {COMPLIANCE_DOC_GROUPS.map((g) => (
            <button
              key={g.group}
              onClick={() => setActiveGroup(g.group)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider whitespace-nowrap transition-all",
                activeGroup === g.group
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {g.group}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex gap-2 overflow-x-auto hide-scrollbar">
            {groupTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "px-5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all",
                  activeTab === tab.key
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {dirty[tab.key] && (
                  <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle" />
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleReset}
              disabled={saving}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-secondary transition disabled:opacity-50"
            >
              <RotateCcw size={12} />
              Reset
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50",
                hasChanges
                  ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
                  : "bg-secondary text-muted-foreground",
              )}
            >
              <Save size={12} />
              {saving ? "Saving..." : hasChanges ? "Save Changes" : "Saved"}
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-1 bg-secondary/50 p-1 rounded-lg w-fit">
        {viewModes.map((mode) => (
          <button
            key={mode.key}
            onClick={() => setViewMode(mode.key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200",
              viewMode === mode.key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <mode.icon size={12} />
            {mode.label}
          </button>
        ))}
      </div>

      <div
        className={cn(
          "grid gap-4",
          viewMode === "split" ? "md:grid-cols-2 grid-cols-1" : "grid-cols-1",
        )}
      >
        {(viewMode === "editor" || viewMode === "split") && (
          <div className="flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 bg-secondary/50 rounded-t-xl border border-b-0 border-border">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                HTML Editor
              </span>
              <span className="text-[10px] text-muted-foreground">{htmlContent.length} chars</span>
            </div>
            <textarea
              value={htmlContent}
              onChange={(e) => handleContentChange(e.target.value)}
              className="w-full min-h-[500px] md:min-h-[600px] p-4 bg-card border border-border rounded-b-xl font-mono text-sm text-foreground leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition"
              spellCheck={false}
              placeholder="Enter HTML content..."
            />
          </div>
        )}

        {(viewMode === "preview" || viewMode === "split") && (
          <div className="flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 bg-secondary/50 rounded-t-xl border border-b-0 border-border">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Live Preview
              </span>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">
                  Real-time
                </span>
              </div>
            </div>
            <div className="w-full min-h-[500px] md:min-h-[600px] p-6 bg-card border border-border rounded-b-xl overflow-y-auto">
              <div
                className="compliance-preview text-sm text-muted-foreground leading-relaxed"
                dangerouslySetInnerHTML={{ __html: sanitizeComplianceHtml(htmlContent) }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
