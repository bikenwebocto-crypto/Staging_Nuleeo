import { useState } from "react";
import { useLocation } from "wouter";
import { Check, ChevronDown, LayoutGrid, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/components/ui/dropdown-menu";
import { cn } from "@ui/lib/utils";
import { useWorkspace } from "@/lib/workspaces";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { WorkspaceGlyph, workspaceSubtitle } from "./workspaceDisplay";

// Sidebar "Workspace" switcher (owner experience). Lists every workspace the
// user owns or has been granted, switches on select (and lands on that
// workspace's dashboard), and offers create + the full picker page.
export function WorkspaceSwitcher({ className }: { className?: string }) {
  const [, setLocation] = useLocation();
  const { workspaces, activeWorkspace, canCreate, isLoading, isError, refetch, selectWorkspace } =
    useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);

  if (isLoading && !activeWorkspace) {
    return (
      <div
        aria-hidden="true"
        className={cn("mb-3 h-[52px] animate-pulse rounded-2xl bg-[#1C2325]", className)}
      />
    );
  }

  if (isError && workspaces.length === 0) {
    return (
      <button
        type="button"
        onClick={refetch}
        className={cn(
          "mb-3 w-full rounded-2xl bg-[#1C2325] px-3 py-2.5 text-left text-xs text-[#A3A7AB] hover:bg-[#2A3134]",
          className,
        )}
      >
        Couldn't load workspaces. <span className="font-semibold text-[#F4F4F2]">Retry</span>
      </button>
    );
  }

  if (!activeWorkspace) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Workspace: ${activeWorkspace.name}. Switch workspace`}
            className={cn(
              "mb-3 flex w-full items-center gap-2.5 rounded-2xl bg-[#1C2325] px-3 py-2 text-left transition-colors hover:bg-[#2A3134] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]",
              className,
            )}
          >
            <WorkspaceGlyph type={activeWorkspace.type} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] leading-tight text-[#7D8287]">Workspace</span>
              <span className="block truncate text-[13px] font-semibold leading-tight text-[#F4F4F2]">
                {activeWorkspace.name}
              </span>
            </span>
            <ChevronDown size={14} className="shrink-0 text-[#A3A7AB]" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-[280px] rounded-2xl border-0 bg-[#111618] p-1.5 text-[#F4F4F2] shadow-xl"
        >
          <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-[#7D8287]">
            Switch workspace
          </DropdownMenuLabel>
          {workspaces.map((ws) => {
            const active = ws.id === activeWorkspace.id;
            return (
              <DropdownMenuItem
                key={ws.id}
                onSelect={() => {
                  if (!active) selectWorkspace(ws);
                  setLocation("/owner");
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 focus:bg-[#1C2325] focus:text-[#F4F4F2]",
                  active && "bg-[#1C2325]",
                )}
              >
                <WorkspaceGlyph type={ws.type} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{ws.name}</span>
                  <span className="block truncate text-[11px] text-[#A3A7AB]">
                    {workspaceSubtitle(ws)}
                  </span>
                </span>
                {active && <Check size={14} className="shrink-0" aria-label="Current workspace" />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator className="mx-2 my-1 bg-transparent" />
          {canCreate.length > 0 && (
            <DropdownMenuItem
              onSelect={() => setCreateOpen(true)}
              className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] focus:bg-[#1C2325] focus:text-[#F4F4F2]"
            >
              <Plus size={14} aria-hidden="true" />
              Add a portfolio or business
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => setLocation("/workspaces")}
            className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] focus:bg-[#1C2325] focus:text-[#F4F4F2]"
          >
            <LayoutGrid size={14} aria-hidden="true" />
            All workspaces
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => setLocation("/owner")}
      />
    </>
  );
}
