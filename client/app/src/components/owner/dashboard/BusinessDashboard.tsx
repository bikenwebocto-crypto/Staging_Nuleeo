import { Link } from "wouter";
import {
  Building2,
  Calculator,
  Handshake,
  MessageCircle,
  Plus,
  RefreshCw,
  User,
} from "lucide-react";
import type { WorkspaceListEntry } from "@shared/workspaces";
import { ENTITY_STATUS_LABEL, ENTITY_TYPE_LABEL } from "@shared/entities";
import { WorkspaceGlyph, workspaceSubtitle } from "@/components/owner/workspace/workspaceDisplay";
import { useEntities } from "@/lib/entities";
import { CARD } from "./tokens";

// Dashboard for a BUSINESS workspace: the owner's companies (Entities, which
// are owner-scoped and shared with the real-estate workspace) plus tools.
// Ledgers, banking, VAT and reports are not built yet, so no figures are shown.
const TOOLS = [
  {
    href: "/calculator",
    icon: Calculator,
    title: "Smart Calculator",
    hint: "Yield, LTV and affordability",
  },
  { href: "/network", icon: Handshake, title: "Network", hint: "Lenders, legal and accounting" },
  { href: "/owner/messages", icon: MessageCircle, title: "Messages", hint: "Your conversations" },
];

const STATUS_TONE = { SETTING_UP: "#F5B65C", ACTIVE: "#7BD88F", INACTIVE: "#7D8287" } as const;

export function BusinessDashboard({ workspace }: { workspace: WorkspaceListEntry }) {
  const { data, isLoading, isError, refetch } = useEntities();
  const entities = data?.entities ?? [];
  // Only the owner manages their companies; granted viewers just see the workspace.
  const canManage = workspace.isSelf;

  return (
    <main className="min-h-full w-full px-5 py-5 pb-[var(--mobile-nav-clearance)] sm:px-6 sm:py-6 md:pb-8 lg:px-8 lg:py-7">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[#F4F4F2]">
              {workspace.name}
            </h1>
            <p className="mt-1 text-sm text-[#A3A7AB]">{workspaceSubtitle(workspace)}</p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/business"
              className="flex h-11 items-center rounded-full bg-[#1C2325] px-5 text-sm font-semibold text-[#F4F4F2] hover:bg-[#2A3134]"
            >
              View portfolio
            </Link>
            {canManage && (
              <Link
                href="/business/new"
                className="flex h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-[#060A0B] transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
              >
                <Plus size={16} aria-hidden="true" /> Add business
              </Link>
            )}
          </div>
        </div>

        <section aria-label="Companies" className={`${CARD} p-6`}>
          <h2 className="text-[15px] font-semibold text-[#F4F4F2]">Companies</h2>
          {isLoading ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2" aria-busy="true">
              {[0, 1].map((i) => (
                <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-[#1C2325]" />
              ))}
            </div>
          ) : isError ? (
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-4 flex items-center gap-2 rounded-full bg-[#1C2325] px-4 py-2 text-sm font-semibold text-[#F4F4F2] hover:bg-[#2A3134]"
            >
              <RefreshCw size={14} aria-hidden="true" /> Couldn't load companies — retry
            </button>
          ) : entities.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <WorkspaceGlyph type="business" size="lg" />
              <h3 className="mt-4 text-[15px] font-semibold text-[#F4F4F2]">No companies yet</h3>
              <p className="mt-2 max-w-[440px] text-sm text-[#A3A7AB]">
                Add the companies you trade or hold assets through. Bank accounts, VAT and reports
                will build on them.
              </p>
              {canManage && (
                <Link
                  href="/business/new"
                  className="mt-5 flex h-11 items-center gap-2 rounded-full bg-[#1C2325] px-5 text-sm font-semibold text-[#F4F4F2] hover:bg-[#2A3134]"
                >
                  <Plus size={16} aria-hidden="true" /> Add your first business
                </Link>
              )}
            </div>
          ) : (
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              {entities.map((e) => {
                const Icon = e.entityType === "PERSONAL" ? User : Building2;
                return (
                  <li
                    key={e.id}
                    className="flex items-center gap-3 rounded-2xl bg-[#1C2325] px-4 py-3"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[#F4F4F2]">
                      <Icon size={18} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[#F4F4F2]">
                        {e.name}
                      </span>
                      <span className="block truncate text-xs text-[#A3A7AB]">
                        {[
                          ENTITY_TYPE_LABEL[e.entityType],
                          e.registrationNumber,
                          e.vatNumber && `VAT ${e.vatNumber}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span
                      className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                      style={{
                        color: STATUS_TONE[e.status],
                        backgroundColor: `${STATUS_TONE[e.status]}1F`,
                      }}
                    >
                      {ENTITY_STATUS_LABEL[e.status]}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Tools" className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {TOOLS.map(({ href, icon: Icon, title, hint }) => (
            <Link
              key={href}
              href={href}
              className={`${CARD} flex items-center gap-3 p-6 transition-colors hover:bg-[#1C2325]`}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1C2325] text-[#F4F4F2]">
                <Icon size={18} aria-hidden="true" />
              </span>
              <span>
                <span className="block text-[15px] font-semibold text-[#F4F4F2]">{title}</span>
                <span className="block text-xs text-[#A3A7AB]">{hint}</span>
              </span>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
