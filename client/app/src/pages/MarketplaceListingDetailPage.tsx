import { useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import {
  ArrowLeft,
  Bath,
  Bed,
  ExternalLink,
  Home,
  MapPin,
  Maximize,
  TrendingUp,
} from "lucide-react";
import { motion } from "framer-motion";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { useMarketplaceListing, useCreateMarketplaceLead } from "@/lib/ownerQueries";
import { formatCurrency } from "@ui/lib/format";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { PropertyImage } from "@ui/components/common/PropertyImage";
import { useToast } from "@ui/hooks/use-toast";

export default function MarketplaceListingDetailPage() {
  const [, params] = useRoute("/marketplace/:id");
  const [, navigate] = useLocation();
  const listingId = params?.id;
  const { listing, isLoading, isError, refetch } = useMarketplaceListing(listingId);
  const createLead = useCreateMarketplaceLead();
  const { toast } = useToast();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");

  const handleSubmit = async () => {
    if (!listingId) return;
    try {
      await createLead.mutateAsync({
        listingId,
        message: message.trim() || undefined,
      });
      setSubmitted(true);
      toast({
        title: "Interest submitted",
        description: "Our team will reach out shortly.",
      });
    } catch (err) {
      toast({
        title: "Couldn't submit interest",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    // Reset after the close animation so the form is fresh next time.
    setTimeout(() => {
      setSubmitted(false);
      setMessage("");
    }, 300);
  };

  // A failed fetch must read as an error (retryable), not as a genuine miss —
  // otherwise a network blip looks identical to a removed listing.
  if (!isLoading && isError) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <Link
          href="/marketplace"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6"
        >
          <ArrowLeft size={16} /> Back to marketplace
        </Link>
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 p-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">We couldn't load this listing.</p>
            <p className="text-xs opacity-80 mt-0.5">Check your connection or try again.</p>
          </div>
          <button
            onClick={() => refetch()}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition shrink-0"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!isLoading && !listing) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <Link
          href="/marketplace"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6"
        >
          <ArrowLeft size={16} /> Back to marketplace
        </Link>
        <div className="bg-card border border-border/60 rounded-2xl py-16 text-center text-muted-foreground text-sm">
          Listing not found. It may have been removed.
        </div>
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <Link
        href="/marketplace"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6"
      >
        <ArrowLeft size={16} /> Back to marketplace
      </Link>

      {listing && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-card rounded-2xl overflow-hidden border border-border shadow-sm"
        >
          <div className="relative h-72 md:h-96 bg-secondary">
            <PropertyImage src={listing.image} alt={listing.title} icon={Home} iconSize={48} />

            {listing.tag && (
              <div className="absolute top-4 left-4 bg-card/90 backdrop-blur-sm px-3 py-1.5 rounded-md text-xs font-bold text-foreground shadow-sm">
                {listing.tag}
              </div>
            )}
          </div>

          <div className="p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
              <div>
                <h1 className="text-2xl md:text-3xl font-bold text-foreground tracking-tight">
                  {listing.title}
                </h1>
                <div className="flex items-center text-muted-foreground text-sm mt-2">
                  <MapPin size={14} className="mr-1.5" /> {listing.location}
                </div>
              </div>
              <div className="text-left md:text-right">
                <div className="text-3xl font-bold text-primary">
                  {formatCurrency(listing.price)}
                </div>
                {typeof listing.roi === "number" && (
                  <div className="flex items-center md:justify-end gap-1 text-xs text-green-600 mt-1">
                    <TrendingUp size={12} /> Projected ROI {listing.roi}%
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-5 border-t border-border text-sm text-muted-foreground">
              {typeof listing.beds === "number" && listing.beds > 0 && (
                <span className="flex items-center gap-1.5">
                  <Bed size={16} /> {listing.beds} {listing.beds === 1 ? "bed" : "beds"}
                </span>
              )}
              {typeof listing.baths === "number" && listing.baths > 0 && (
                <span className="flex items-center gap-1.5">
                  <Bath size={16} /> {listing.baths} {listing.baths === 1 ? "bath" : "baths"}
                </span>
              )}
              {typeof listing.sqm === "number" && (
                <span className="flex items-center gap-1.5">
                  <Maximize size={16} /> {listing.sqm} m²
                </span>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-3 mt-8">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="flex-1 bg-primary text-primary-foreground rounded-xl py-3 px-6 font-semibold text-sm hover:bg-primary/90 transition"
              >
                I'm interested
              </button>
              {listing.externalUrl && (
                <a
                  href={listing.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 sm:flex-none bg-muted text-foreground rounded-xl py-3 px-6 font-semibold text-sm hover:bg-muted/80 transition"
                >
                  View external listing <ExternalLink size={14} />
                </a>
              )}
            </div>
          </div>
        </motion.div>
      )}

      <ResponsiveDrawer
        open={drawerOpen}
        onOpenChange={(o) => (o ? setDrawerOpen(true) : closeDrawer())}
        title={submitted ? "Thanks — we'll be in touch" : "I'm interested"}
        subtitle={
          submitted
            ? undefined
            : listing
              ? `${listing.title} — ${formatCurrency(listing.price)}`
              : undefined
        }
        footer={
          submitted ? (
            <button
              type="button"
              onClick={() => {
                closeDrawer();
                navigate("/marketplace");
              }}
              className="w-full bg-primary text-primary-foreground rounded-xl py-3 font-semibold text-sm"
            >
              Back to marketplace
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={createLead.isPending}
              className="w-full bg-primary text-primary-foreground rounded-xl py-3 font-semibold text-sm disabled:opacity-60"
            >
              {createLead.isPending ? "Submitting…" : "Submit interest"}
            </button>
          )
        }
      >
        {submitted ? (
          <p className="text-sm text-muted-foreground">
            Your interest has been sent to the Olio team. We'll reach out by email with next steps
            for this property.
          </p>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm font-medium text-foreground">
              Add a note <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              maxLength={4000}
              placeholder="Anything specific you'd like to know — financing, viewing dates, etc."
              className="w-full bg-muted border-none rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />
            <p className="text-xs text-muted-foreground">
              We'll share your name and email with the listing team so they can follow up.
            </p>
          </div>
        )}
      </ResponsiveDrawer>
    </div>
  );
}
