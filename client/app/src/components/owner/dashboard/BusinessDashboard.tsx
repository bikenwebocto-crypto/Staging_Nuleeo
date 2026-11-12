import { Link } from "wouter";
import { Calculator, Handshake, MessageCircle } from "lucide-react";
import type { WorkspaceListEntry } from "@shared/workspaces";
import { WorkspaceGlyph, workspaceSubtitle } from "@/components/owner/workspace/workspaceDisplay";
import { CARD } from "./tokens";

// Dashboard for a BUSINESS workspace. There is no company / business-ledger
// data model yet, so instead of inventing figures this shows the workspace and
// an honest empty state, plus the general tools that already work here.
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

export function BusinessDashboard({ workspace }: { workspace: WorkspaceListEntry }) {
  return (
    <main className="min-h-full w-full px-5 py-5 pb-[var(--mobile-nav-clearance)] sm:px-6 sm:py-6 md:pb-8 lg:px-8 lg:py-7">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[#F4F4F2]">
            {workspace.name}
          </h1>
          <p className="mt-1 text-sm text-[#A3A7AB]">{workspaceSubtitle(workspace)}</p>
        </div>

        <section className={`${CARD} flex flex-col items-center px-6 py-16 text-center`}>
          <WorkspaceGlyph type="business" size="lg" />
          <h2 className="mt-4 text-[15px] font-semibold text-[#F4F4F2]">No businesses yet</h2>
          <p className="mt-2 max-w-[440px] text-sm text-[#A3A7AB]">
            Companies, their bank accounts, VAT and reports will live here. Company management is on
            its way — your real estate workspace is unaffected.
          </p>
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
