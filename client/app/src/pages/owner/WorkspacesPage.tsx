import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Plus, RefreshCw } from "lucide-react";
import { Logo } from "@ui/components/Logo";
import { useAuth } from "@ui/lib/useAuth";
import { cn } from "@ui/lib/utils";
import { WORKSPACE_TYPE_LABEL, type WorkspaceListEntry } from "@shared/workspaces";
import { useWorkspace } from "@/lib/workspaces";
import { CreateWorkspaceDialog } from "@/components/owner/workspace/CreateWorkspaceDialog";
import {
  WORKSPACE_TONE,
  WorkspaceGlyph,
  workspaceRoleLabel,
  workspaceSubtitle,
} from "@/components/owner/workspace/workspaceDisplay";

// Standalone workspace picker ("Welcome back" / "You're all set"). Lists every
// workspace the user owns or was granted, opens one, and creates new ones.

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-[#A3A7AB]">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums text-[#F4F4F2]">{value}</p>
    </div>
  );
}

function WorkspaceCard({
  ws,
  highlighted,
  lastOpened,
  onOpen,
}: {
  ws: WorkspaceListEntry;
  highlighted: boolean;
  lastOpened: boolean;
  onOpen: () => void;
}) {
  const isNew = ws.stats ? ws.stats.properties === 0 && ws.stats.activeTenants === 0 : true;
  const verb = ws.isSelf && isNew ? "Start with" : "Open";
  const noun = ws.type === "real_estate" ? "real estate" : "business";
  return (
    <article
      className={cn(
        "flex flex-col gap-4 rounded-[24px] p-7",
        highlighted ? "bg-[#1C2325]" : "bg-[#111618]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <WorkspaceGlyph type={ws.type} size="lg" className="bg-white/[0.06]" />
        {lastOpened && (
          <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-[#060A0B]">
            Last opened
          </span>
        )}
      </div>
      <div>
        <p className="text-xs font-medium" style={{ color: WORKSPACE_TONE[ws.type] }}>
          {WORKSPACE_TYPE_LABEL[ws.type]}
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-[#F4F4F2]">{ws.name}</h2>
        <p className="mt-1 text-sm text-[#A3A7AB]">{workspaceSubtitle(ws)}</p>
      </div>

      {ws.stats ? (
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Properties" value={ws.stats.properties} />
          <Stat label="Active tenants" value={ws.stats.activeTenants} />
          <Stat
            label="Access"
            value={ws.isSelf ? "Owner" : workspaceRoleLabel(ws).split(" · ")[0]}
          />
        </div>
      ) : (
        <p className="text-sm text-[#7D8287]">
          Companies, accounts and VAT will show here once company management is available.
        </p>
      )}

      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "mt-auto flex h-12 items-center justify-between rounded-2xl px-5 text-[15px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]",
          highlighted
            ? "bg-white text-[#060A0B] hover:brightness-95"
            : "bg-[#1C2325] text-[#F4F4F2] hover:bg-[#2A3134]",
        )}
      >
        {verb} {noun}
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </article>
  );
}

export default function WorkspacesPage() {
  const [, setLocation] = useLocation();
  const { profile } = useAuth();
  const {
    workspaces,
    activeWorkspace,
    lastWorkspaceId,
    canCreate,
    isLoading,
    isError,
    refetch,
    selectWorkspace,
  } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);

  const firstName = profile?.firstName?.trim();
  const initials =
    `${profile?.firstName?.[0] ?? ""}${profile?.lastName?.[0] ?? ""}`.toUpperCase() || "·";
  const allEmpty = workspaces.every(
    (w) => !w.stats || (w.stats.properties === 0 && w.stats.activeTenants === 0),
  );
  const highlightId = lastWorkspaceId ?? activeWorkspace?.id ?? workspaces[0]?.id;

  const open = (ws: WorkspaceListEntry) => {
    selectWorkspace(ws);
    setLocation("/owner");
  };

  return (
    <div className="min-h-screen bg-[#060A0B] bg-[linear-gradient(180deg,#0F3A3D_0%,#060A0B_220px)] text-[#F4F4F2]">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-10 px-4 py-10 sm:px-6">
        <header className="flex items-center justify-between gap-4">
          <button type="button" onClick={() => setLocation("/owner")} aria-label="Go to dashboard">
            <Logo variant="wordmark" className="h-7 w-auto" />
          </button>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-[#A3A7AB] sm:inline">{profile?.email}</span>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#E2F645] text-sm font-semibold text-[#060A0B]">
              {initials}
            </span>
          </div>
        </header>

        <div>
          <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.02em]">
            {allEmpty ? "You're all set" : "Welcome back"}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="mt-2 text-base text-[#A3A7AB]">
            {allEmpty
              ? "Which workspace do you want to start with? You can switch anytime from the top of the menu."
              : "Which workspace do you want to open?"}
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="h-[320px] animate-pulse rounded-[24px] bg-[#111618]" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex flex-col items-start gap-3 rounded-[24px] bg-[#111618] p-7">
            <p className="font-semibold">Couldn't load your workspaces</p>
            <p className="text-sm text-[#A3A7AB]">Check your connection and try again.</p>
            <button
              type="button"
              onClick={refetch}
              className="flex items-center gap-2 rounded-full bg-[#1C2325] px-4 py-2 text-sm font-semibold hover:bg-[#2A3134]"
            >
              <RefreshCw size={14} aria-hidden="true" /> Retry
            </button>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="rounded-[24px] bg-[#111618] p-7 text-sm text-[#A3A7AB]">
            You don't have a workspace yet.
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {workspaces.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                highlighted={ws.id === highlightId}
                lastOpened={ws.id === lastWorkspaceId}
                onOpen={() => open(ws)}
              />
            ))}
          </div>
        )}

        {canCreate.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-2 rounded-2xl bg-[#111618] px-4 py-3 text-[15px] font-medium hover:bg-[#1C2325] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
            >
              <Plus size={16} aria-hidden="true" /> Add a portfolio or business
            </button>
          </div>
        )}

        <p className="text-xs text-[#A3A7AB]">
          One login. Each workspace keeps its own accounts, cards, books and reports, so your
          property portfolio and your companies never mix.
        </p>
      </div>

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => setLocation("/owner")}
      />
    </div>
  );
}
