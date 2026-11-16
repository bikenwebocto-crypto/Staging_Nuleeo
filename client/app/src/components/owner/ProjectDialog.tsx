import { useEffect, useState, type FormEvent } from "react";
import { FolderKanban, Loader2 } from "lucide-react";
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
import { useCreateProject, useUpdateProject } from "@/lib/projects";

const NAME_MAX = 120;

export function ProjectDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
}) {
  const { toast } = useToast();
  const create = useCreateProject();
  const update = useUpdateProject();
  const isEdit = !!project;
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setError(null);
  }, [open, project]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a project name.");
      return;
    }
    setError(null);
    try {
      if (project) {
        await update.mutateAsync({ id: project.id, name: trimmed });
        toast({ title: "Project updated" });
      } else {
        await create.mutateAsync(trimmed);
        toast({ title: "Project created" });
      }
      onOpenChange(false);
    } catch (err) {
      setError(
        parseApiError(
          err,
          isEdit ? "Couldn't update the project." : "Couldn't create the project.",
        ),
      );
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px] rounded-3xl border-0 bg-[#111618] p-7 text-[#F4F4F2]">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold tracking-[-0.02em]">
            <FolderKanban size={20} aria-hidden="true" />
            {isEdit ? "Edit project" : "Add project"}
          </DialogTitle>
          <DialogDescription className="text-sm text-[#A3A7AB]">
            {isEdit
              ? "Rename the project. Properties assigned to it stay linked."
              : "Group related properties under one project. You can assign properties from the portfolio table."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
          <div className="flex flex-col gap-2">
            <label htmlFor="project-name" className="text-xs font-medium text-[#A3A7AB]">
              Project name
            </label>
            <input
              id="project-name"
              autoFocus
              value={name}
              maxLength={NAME_MAX}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder="e.g. Limassol Seafront"
              aria-invalid={!!error}
              aria-describedby={error ? "project-name-error" : undefined}
              className="h-11 rounded-full bg-[#1C2325] px-4 text-sm text-[#F4F4F2] placeholder:text-[#7D8287] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
            />
            {error && (
              <p id="project-name-error" role="alert" className="text-xs text-[#FF7A7A]">
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
              disabled={pending}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-[#060A0B] transition hover:brightness-95 disabled:opacity-60"
            >
              {pending && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              {isEdit ? "Save changes" : "Create project"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
