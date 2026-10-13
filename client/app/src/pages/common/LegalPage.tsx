import { Link } from "wouter";
import { ArrowLeft, FileText } from "lucide-react";
import { Logo } from "@ui/components/Logo";
import { useComplianceDoc, type ComplianceDocKey } from "@ui/lib/complianceStore";
import { sanitizeComplianceHtml } from "@ui/lib/sanitizeHtml";
import { COMPLIANCE_DOC_GROUPS } from "@shared/firestore-schema";

interface LegalPageProps {
  docKey: ComplianceDocKey;
}

// Flat title map derived from the grouped definition in the shared schema.
const TITLES: Record<ComplianceDocKey, string> = COMPLIANCE_DOC_GROUPS.reduce(
  (acc, g) => {
    for (const d of g.docs) acc[d.key] = d.label;
    return acc;
  },
  {} as Record<ComplianceDocKey, string>,
);

// Public, unauthenticated legal page. Used for every compliance document
// reachable at app.oliowallet.com/legal/<slug>, plus the legacy /terms and
// /privacy short paths linked from the signup checkbox and the OAuth
// consent screen.
export default function LegalPage({ docKey }: LegalPageProps) {
  const { html: content } = useComplianceDoc(docKey);

  return (
    <div className="min-h-dvh bg-background font-sans">
      <header className="sticky top-0 z-10 bg-card/95 backdrop-blur-md border-b border-border">
        <div className="max-w-3xl mx-auto px-5 md:px-8 py-4 flex items-center gap-3">
          <Link href="/legal">
            <button
              className="w-9 h-9 bg-secondary rounded-full flex items-center justify-center hover:bg-secondary/80 transition"
              aria-label="Back to legal index"
            >
              <ArrowLeft size={18} className="text-foreground" />
            </button>
          </Link>
          <Logo variant="wordmark" color="dark" className="h-7 w-auto" />
          <h1 className="text-lg font-bold text-foreground ml-auto truncate">
            {TITLES[docKey] ?? "Legal"}
          </h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 md:px-8 py-8">
        <div className="bg-card p-6 md:p-10 rounded-2xl shadow-sm border border-border">
          <div
            className="compliance-preview text-sm text-muted-foreground leading-relaxed"
            dangerouslySetInnerHTML={{ __html: sanitizeComplianceHtml(content) }}
          />
        </div>
        <div className="mt-6 text-center">
          <Link href="/legal">
            <a className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition">
              <FileText size={12} /> See all legal documents
            </a>
          </Link>
        </div>
      </main>
    </div>
  );
}
