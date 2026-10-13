import { useState } from "react";
import { FilePlus, Trash2 } from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { useTemplates } from "../model/useTemplates";
import { createTemplate, deleteTemplate } from "../api/templates";
import type { EmailTemplate } from "../api/types";
import { fmtDate } from "../lib/format";

export interface TemplatesDrawerProps {
  currentSubject: string;
  currentBody: string;
  onApply: (template: EmailTemplate) => void;
  onClose: () => void;
}

export function TemplatesDrawer({
  currentSubject,
  currentBody,
  onApply,
  onClose,
}: TemplatesDrawerProps) {
  const { templates, loading, reload } = useTemplates();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim() || !currentSubject || !currentBody) return;
    setSaving(true);
    setError(null);
    try {
      await createTemplate({ name: name.trim(), subject: currentSubject, body: currentBody });
      setName("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteTemplate(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete template");
    }
  };

  // Shared ResponsiveDrawer (bottom-sheet on mobile / centered modal on desktop)
  // — replaces the hand-rolled right-side overlay that had no role=dialog,
  // focus-trap, or Escape, and was unusable on a phone.
  return (
    <ResponsiveDrawer
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Templates"
      desktopMaxWidth="max-w-md"
    >
      <div className="space-y-5">
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Save the current subject + body as a reusable template.
          </p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Template name"
            className="w-full px-3 py-2 rounded-lg border border-border bg-muted text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            onClick={handleSave}
            disabled={saving || !name.trim() || !currentSubject || !currentBody}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FilePlus size={14} />
            {saving ? "Saving..." : "Save as template"}
          </button>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : templates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No templates yet</p>
          ) : (
            templates.map((t) => (
              <div
                key={t.id}
                className="group flex items-stretch gap-1 rounded-lg border border-border hover:bg-muted/50 transition"
              >
                {/* Apply = a real button (was a div onClick → no keyboard access). */}
                <button
                  type="button"
                  onClick={() => onApply(t)}
                  className="flex-1 min-w-0 text-left p-3 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <p className="text-sm font-medium truncate">{t.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{t.subject}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Updated {fmtDate(t.updatedAt)}
                  </p>
                </button>
                {/* Sibling (not nested) so it's valid HTML + keyboard-reachable.
                    Always visible on touch; hover/focus-reveal on desktop. */}
                <button
                  type="button"
                  onClick={() => void handleDelete(t.id)}
                  aria-label={`Delete template ${t.name}`}
                  title="Delete"
                  className="shrink-0 self-start m-1.5 p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </ResponsiveDrawer>
  );
}
