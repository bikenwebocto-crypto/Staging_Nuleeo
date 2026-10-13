import { Link } from "wouter";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Logo } from "@ui/components/Logo";
import { COMPLIANCE_DOC_GROUPS } from "@shared/firestore-schema";

// Public legal index. Lists every compliance document grouped by category so
// users can find the policy they need without hunting through footers. Linked
// from every LegalPage and from the landing + app footers.
export default function LegalIndexPage() {
  return (
    <div className="min-h-dvh bg-background font-sans">
      <header className="sticky top-0 z-10 bg-card/95 backdrop-blur-md border-b border-border">
        <div className="max-w-3xl mx-auto px-5 md:px-8 py-4 flex items-center gap-3">
          <Link href="/auth">
            <button
              className="w-9 h-9 bg-secondary rounded-full flex items-center justify-center hover:bg-secondary/80 transition"
              aria-label="Back"
            >
              <ArrowLeft size={18} className="text-foreground" />
            </button>
          </Link>
          <Logo variant="wordmark" color="dark" className="h-7 w-auto" />
          <h1 className="text-lg font-bold text-foreground ml-auto">Legal</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 md:px-8 py-8 space-y-6">
        <div className="bg-card p-6 md:p-8 rounded-2xl shadow-sm border border-border">
          <h2 className="text-xl font-bold text-foreground">Legal &amp; compliance</h2>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            Olio Wallet Ltd is incorporated in the Republic of Cyprus and operates under EU law.
            Every policy below is part of the agreement between you and Olio. If you have a
            question, contact us at <strong>legal@oliowallet.com</strong>.
          </p>
        </div>

        {COMPLIANCE_DOC_GROUPS.map((group) => (
          <section
            key={group.group}
            className="bg-card rounded-2xl shadow-sm border border-border overflow-hidden"
          >
            <div className="px-5 md:px-6 py-3 bg-secondary/40 border-b border-border">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {group.group}
              </h3>
            </div>
            <ul className="divide-y divide-border">
              {group.docs.map((d) => (
                <li key={d.key}>
                  <Link href={`/legal/${d.key}`}>
                    <a className="flex items-center justify-between px-5 md:px-6 py-4 hover:bg-secondary/30 transition">
                      <span className="text-sm font-medium text-foreground">{d.label}</span>
                      <ChevronRight size={16} className="text-muted-foreground" />
                    </a>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </div>
  );
}
