import { useEffect, useState, type FormEvent } from "react";
import { Link2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { parseApiError } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import type { Project } from "@shared/firestore-schema";
import type { OwnerProperty } from "@/lib/ownerQueries";
import { useAssignPropertyProject } from "@/lib/projects";

function propertyLabel(property: OwnerProperty): string {
  return property.name?.trim() || property.address?.trim() || "this property";
}

export function AssignProjectDialog({
  open,
  onOpenChange,
  property,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: OwnerProperty | null;
  projects: Project[];
}) {
  const { toast } = useToast();
  const assign = useAssignPropertyProject();
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProjectId(property?.projectId ?? "");
    setError(null);
  }, [open, property]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!property) return;
    setError(null);
    try {
      await assign.mutateAsync({ propertyId: property.id, projectId: projectId || null });
      toast({
        title: projectId ? "Property assigned" : "Project assignment removed",
        description: projectId
          ? `${propertyLabel(property)} is now part of the selected project.`
          : `${propertyLabel(property)} is no longer part of a project.`,
      });
      onOpenChange(false);
    } catch (err) {
      setError(parseApiError(err, "Couldn't update the project assignment."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px] rounded-3xl border-0 bg-[#111618] p-7 text-[#F4F4F2]">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold tracking-[-0.02em]">
            <Link2 size={20} aria-hidden="true" />
            Assign to project
          </DialogTitle>
          <DialogDescription className="text-sm text-[#A3A7AB]">
            Choose which project {property ? propertyLabel(property) : "this property"} belongs to.
            The property and its building data stay unchanged.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor="assign-project" className="text-xs font-medium text-[#A3A7AB]">
              Project
            </label>
            <select
              id="assign-project"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setError(null);
              }}
              className="h-11 rounded-full bg-[#1C2325] px-4 text-sm text-[#F4F4F2] outline-none [color-scheme:dark] focus-visible:ring-2 focus-visible:ring-[#A78C68]"
            >
              <option value="">Not in a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {projects.length === 0 && (
              <p className="text-xs text-[#A3A7AB]">
                No projects yet. Add one from the Portfolio toolbar first.
              </p>
            )}
            {error && (
              <p role="alert" className="text-xs text-[#FF7A7A]">
                {error}
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-11 rounded-full bg-white/[0.08] px-5 text-sm font-semibold transition-colors hover:bg-white/[0.12]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={assign.isPending || !property}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-[#060A0B] transition hover:brightness-95 disabled:opacity-60"
            >
              {assign.isPending && (
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              )}
              Save assignment
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
