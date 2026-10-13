// Public, read-only property view for shareable links. Rendered for
// LOGGED-OUT visitors who open /properties/:id (App.tsx routes them here
// before the auth shell). Signed-in users get the owner page
// (PropertyDetailsPage), which itself falls back to the same public body
// when the viewer isn't the owner/granted reader.
//
// Only the public-safe subset from GET /api/public/properties/:id is
// shown — financials, tenant info, documents, ownership/compliance, and
// activity never reach this view.

import { Building } from "lucide-react";
import { Logo } from "@ui/components/Logo";
import { usePublicProperty } from "@/lib/publicQueries";
import { PublicPropertyView } from "@/components/common/PublicPropertyView";

// Thin top bar with the Olio wordmark and a sign-in CTA — gives the
// shareable page an identity and a path into the product without
// exposing any of the authenticated chrome.
function PublicHeader() {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 bg-background/80 backdrop-blur-md border-b border-border">
      <a href="/" aria-label="Olio" className="flex items-center">
        <Logo variant="wordmark" className="h-7 w-auto" />
      </a>
      <a
        href="/auth"
        className="text-sm font-semibold bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition"
      >
        Sign in
      </a>
    </header>
  );
}

export default function PublicPropertyPage({ id }: { id: string }) {
  const { data: property, isLoading, error } = usePublicProperty(id);

  if (isLoading) {
    return (
      <div className="min-h-dvh bg-background">
        <PublicHeader />
        <div className="animate-pulse">
          <div className="h-[40vh] w-full bg-secondary" />
          <div className="relative -mt-10 bg-background rounded-t-3xl px-6 pt-8 pb-10 space-y-6 max-w-3xl mx-auto">
            <div className="h-7 w-3/4 bg-secondary rounded-md" />
            <div className="h-4 w-1/2 bg-secondary rounded-md" />
            <div className="h-40 bg-secondary rounded-2xl" />
          </div>
        </div>
      </div>
    );
  }

  if (!property) {
    // The server returns an opaque 404 for both missing and (in theory)
    // hidden properties, so we keep the copy generic — no hint about
    // whether the id ever existed.
    const errMsg = error instanceof Error ? error.message : "";
    const isTransient = !!error && !/^404/.test(errMsg);
    return (
      <div className="min-h-dvh bg-background flex flex-col">
        <PublicHeader />
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <Building size={40} className="text-muted-foreground/40" />
          <p className="text-foreground font-semibold">
            {isTransient ? "Couldn't load this property" : "Property not found"}
          </p>
          <p className="text-sm text-muted-foreground max-w-md">
            {isTransient
              ? "Something went wrong while loading this page. Check your connection and try again."
              : "This property link may be incorrect or no longer available."}
          </p>
          <a
            href="/auth"
            className="mt-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium"
          >
            Go to Olio
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background">
      <PublicHeader />
      <PublicPropertyView property={property}>
        {/* Foot CTA — invite the visitor into the product. */}
        <div className="mt-8 bg-card p-6 rounded-2xl border border-border text-center">
          <p className="text-foreground font-semibold mb-1">Manage your properties with Olio</p>
          <p className="text-sm text-muted-foreground mb-4 max-w-sm mx-auto">
            Track value, rent, tenants, and documents — all in one place.
          </p>
          <a
            href="/auth"
            className="inline-flex items-center justify-center bg-primary text-primary-foreground px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-primary/90 transition"
          >
            Sign in or create an account
          </a>
        </div>

        <div className="mt-8 flex items-center justify-center gap-3 text-xs text-muted-foreground flex-wrap">
          <a href="/legal/privacy" className="hover:text-foreground underline underline-offset-2">
            Privacy
          </a>
          <span aria-hidden="true">·</span>
          <a href="/legal/terms" className="hover:text-foreground underline underline-offset-2">
            Terms
          </a>
        </div>
      </PublicPropertyView>
    </div>
  );
}
