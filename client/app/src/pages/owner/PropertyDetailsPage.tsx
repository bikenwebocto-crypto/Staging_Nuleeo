import { Link, useRoute } from "wouter";
import {
  useOwnerProperty,
  useOwnerPropertyTransactions,
  useOwnerTenants,
  useOwnerAgreements,
} from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { AddTenantDrawer } from "@ui/components/owner/AddTenantDrawer";
import { EditPropertyDrawer } from "@/components/owner/EditPropertyDrawer";
import { DeletePropertyDialog } from "@/components/owner/DeletePropertyDialog";
import { PricingModal } from "@ui/components/common/PricingModal";
import { PropertyImage } from "@ui/components/common/PropertyImage";
import { PropertyDocumentsSection } from "@/components/owner/PropertyDocumentsSection";
import { usePublicProperty } from "@/lib/publicQueries";
import { PublicPropertyView } from "@/components/common/PublicPropertyView";
import { useHideMobileHeader } from "@/components/common/AppLayout";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { useToast } from "@ui/hooks/use-toast";
import { openBriefing } from "@ui/lib/briefing";
import { useState } from "react";
import {
  ArrowLeft,
  MapPin,
  Home,
  User,
  MoreVertical,
  Plus,
  Edit,
  Trash2,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Download,
  FileText,
  Eye,
  Info,
  Mail,
  Phone,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ui/components/ui/dropdown-menu";
import { formatCurrency, formatCurrencyCompact, formatDate, formatDateTime } from "@ui/lib/format";
import { isRealizedRent } from "@shared/realizedRent";

// Human labels for the coded values the Add Property form stores. Keeps the
// detail page readable ("Completed" not "fully_developed") and falls back to
// the raw value if an unknown code ever shows up.
const DEVELOPMENT_STATUS_LABELS: Record<string, string> = {
  off_plan: "Off plan",
  under_construction: "Under construction",
  fully_developed: "Completed",
};
const PROPERTY_USE_LABELS: Record<string, string> = {
  rent: "Rented out",
  hold: "Held",
  owner_occupied: "Owner-occupied",
};
const OCCUPANCY_STATUS_LABELS: Record<string, string> = {
  rented: "Rented",
  vacant: "Vacant",
  owner_occupied: "Owner-occupied",
};
const titleCase = (s?: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

export default function PropertyDetailsPage() {
  const [match, params] = useRoute("/properties/:id");
  // Hide the global mobile top bar (search + create + calculator + bell) on
  // this page — the full-bleed hero owns the top of the screen and carries its
  // own in-hero back/menu controls. No-op on desktop (that bar is md:hidden).
  useHideMobileHeader();
  const [isAddTenantOpen, setIsAddTenantOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const { toast } = useToast();

  const propertyId = params?.id;
  const { data: property, isLoading, error } = useOwnerProperty(propertyId);
  // When the owner read resolves with no access — the server 404s (or
  // 403s) for a non-owner/non-reader caller, indistinguishably from a true
  // miss — fall back to the public, read-only view so a logged-in visitor
  // who opened a shared link still sees the property. The owner themselves
  // never hits this: their read succeeds, so `tryPublic` stays false and no
  // second request fires. A transient 5xx is excluded so the retry UI shows
  // instead of being masked as a public view.
  const ownerErrMsg = error instanceof Error ? error.message : "";
  const ownerTransient = !!error && !/^40[34]/.test(ownerErrMsg);
  const tryPublic = !isLoading && !property && !ownerTransient;
  const { data: publicProperty, isLoading: publicLoading } = usePublicProperty(
    propertyId,
    tryPublic,
  );
  const { data: transactions = [] } = useOwnerPropertyTransactions(propertyId);
  // Pull the active tenancy + agreement for this property so the Current
  // Tenant card can show real dates/status instead of "—" placeholders.
  const { data: tenants = [] } = useOwnerTenants();
  const { data: agreements = [] } = useOwnerAgreements();
  const activeTenant = tenants.find((t) => t.propertyId === propertyId && t.status === "active");
  const activeAgreement = agreements.find(
    (a) => a.propertyId === propertyId && a.status === "active",
  );
  // A tenancy the owner just created sits in "pending" (tenant has an Olio
  // account, lease awaiting their approval) or "invited" (no account yet,
  // linked on signup) — it only flips to "active" when the tenant approves.
  // It's still a real tenant on this property, so the card must surface it
  // instead of falling through to the "Invite Tenant" empty state, which made
  // a just-added tenant look like the invite never happened.
  const pendingTenant = tenants.find(
    (t) => t.propertyId === propertyId && (t.status === "pending" || t.status === "invited"),
  );
  const pendingAgreement = agreements.find(
    (a) => a.propertyId === propertyId && a.status === "pending_tenant",
  );
  // Active wins over pending if both somehow exist; otherwise show whichever
  // we have. These drive the Current Tenant card.
  const displayTenant = activeTenant ?? pendingTenant;
  // Pair the agreement to the SAME tenancy by tenantId (a tenant and its
  // agreement share a deterministic id) so the card can never mix one invite's
  // name with another invite's dates when a property has more than one pending
  // invite. Falls back to the status-matched agreements if no id match.
  const displayAgreement =
    (displayTenant && agreements.find((a) => a.tenantId === displayTenant.id)) ||
    activeAgreement ||
    pendingAgreement;
  const isPendingTenant = !activeTenant && !!pendingTenant;
  // Cross-portfolio readers can't edit/transfer/delete — those mutations
  // would target the caller's own data, which is the wrong scope.
  const { isSelf, activeOwnerId, activePortfolioDocId } = useActivePortfolio();

  // Occupancy + rent come from the active tenancy/agreement, not
  // property.occupied/rentAmount: those are derived server-side from Unit
  // docs, which owner-created properties never have (the agreement reuses
  // propertyId as unitId, no separate Unit row). So the moment an owner
  // adds a tenant, the unit-based fields read vacant/0 even though the
  // tenancy + lease exist. activeTenant/activeAgreement are the real source.
  const isRented = !!activeTenant;
  // A hold/invest or owner-occupied property has no tenant dimension, so we
  // suppress the "Invite Tenant" CTA and explain why instead of offering it.
  const isHold = property?.propertyUse === "hold";
  const isOwnerOccupied = property?.propertyUse === "owner_occupied";
  // The header chip shows the agreed monthly rent. For a pending invite (no
  // active lease yet) fall through to the pending agreement's figure so the
  // chip reads the real asking rent instead of €0 next to a visible pending
  // tenant. This is a label only — income/yield stay gated on isRented below.
  const displayRent =
    activeAgreement?.monthlyRent ??
    activeTenant?.rentAmount ??
    pendingAgreement?.monthlyRent ??
    pendingTenant?.rentAmount ??
    property?.rentAmount ??
    0;
  const hasAcquisitionPrice = !!(
    property &&
    property.acquisitionPrice !== undefined &&
    property.acquisitionPrice > 0
  );
  const calculatedYield =
    hasAcquisitionPrice && property
      ? ((displayRent * 12) / property.acquisitionPrice!) * 100
      : null;

  const currentYear = new Date().getFullYear();
  // Realized income only — unverified pending offline rent must not inflate
  // this property's YTD income figure (shared predicate, matches the server).
  const ytdIncome = transactions
    .filter((t) => isRealizedRent(t) && new Date(t.timestamp).getFullYear() === currentYear)
    .reduce((sum, t) => sum + (t.amount ?? 0), 0);
  const ytdExpenses = transactions
    .filter((t) => t.type === "expense" && new Date(t.timestamp).getFullYear() === currentYear)
    .reduce((sum, t) => sum + (t.amount ?? 0), 0);

  const { plan } = useActivePortfolioPlan();
  const canPlan = useCanOwnerPlan(plan);

  const handleAddTenantClick = () => {
    // Open the invite drawer for plans that allow it; bump non-permitted
    // plans to the pricing modal instead of silently opening + 402-ing.
    if (canPlan("tenants.invite")) {
      setIsAddTenantOpen(true);
    } else {
      setIsPricingOpen(true);
    }
  };

  const handleDownloadBriefing = async () => {
    if (!property) return;
    // Gate the property briefing on briefing.property. The server re-checks
    // this, but gating here lets us surface the pricing modal instead of a
    // bare error toast for a plan that can't use it.
    if (!canPlan("briefing.property")) {
      setIsPricingOpen(true);
      return;
    }
    // Single source of truth: the same server-rendered, image-led PDF the
    // "Create property report" dialog produces. Active-portfolio scoped so a
    // granted contact gets the right portfolio's data and plan gate. The
    // dropdown closes on click, so progress is surfaced via a toast we
    // dismiss once the download (or its error) resolves.
    const pending = toast({
      title: "Preparing report…",
      description: "Your property PDF will download in a moment.",
    });
    const result = await openBriefing(
      { propertyId: property.id },
      { ownerId: activeOwnerId, isSelf, portfolioDocId: activePortfolioDocId },
    );
    pending.dismiss();
    if (!result.ok) {
      toast({
        title: "Report failed",
        description: result.error,
        variant: "destructive",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 relative animate-pulse">
        <div className="h-[40vh] w-full bg-secondary" />
        <div className="relative -mt-10 bg-background rounded-t-3xl px-6 pt-8 pb-10 space-y-6">
          <div className="h-7 w-3/4 bg-secondary rounded-md" />
          <div className="h-4 w-1/2 bg-secondary rounded-md" />
          <div className="grid grid-cols-3 gap-3">
            <div className="h-20 bg-secondary rounded-2xl" />
            <div className="h-20 bg-secondary rounded-2xl" />
            <div className="h-20 bg-secondary rounded-2xl" />
          </div>
          <div className="h-40 bg-secondary rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!property) {
    // No owner access (404/403). Before showing a dead-end, try the
    // public read-only view so a logged-in visitor who followed a shared
    // link still sees the property — rendered inside the app shell, with a
    // back button, so they keep the sidebar/navigation.
    if (tryPublic) {
      if (publicLoading) {
        return (
          <div className="flex-1 relative animate-pulse">
            <div className="h-[40vh] w-full bg-secondary" />
            <div className="relative -mt-10 bg-background rounded-t-3xl px-6 pt-8 pb-10 space-y-6 max-w-3xl mx-auto">
              <div className="h-7 w-3/4 bg-secondary rounded-md" />
              <div className="h-4 w-1/2 bg-secondary rounded-md" />
              <div className="h-40 bg-secondary rounded-2xl" />
            </div>
          </div>
        );
      }
      if (publicProperty) {
        return (
          <div className="flex-1 relative">
            <PublicPropertyView
              property={publicProperty}
              heroOverlay={
                <Link href="/">
                  <button
                    type="button"
                    aria-label="Back"
                    className="w-10 h-10 bg-card/20 backdrop-blur-md rounded-full flex items-center justify-center hover:bg-card/30 transition"
                  >
                    <ArrowLeft size={20} />
                  </button>
                </Link>
              }
            />
          </div>
        );
      }
    }

    // Distinguish real 404 from transient errors. apiRequest throws
    // errors of shape "${status}: ${body}" — so a 5xx / network failure
    // produces a useful message instead of the misleading "not found".
    const errMsg = error instanceof Error ? error.message : "";
    const isReal404 = !error || /^404/.test(errMsg);
    const isForbidden = /^403/.test(errMsg);
    const isTransient = error && !isReal404 && !isForbidden;
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 min-h-[60vh] px-6 text-center">
        <p className="text-foreground font-semibold">
          {isForbidden
            ? "You don't have access to this property"
            : isTransient
              ? "Couldn't load this property"
              : "Property not found"}
        </p>
        {isTransient && (
          <p className="text-sm text-muted-foreground max-w-md">
            Something went wrong while fetching the property. Check your connection and try again.
          </p>
        )}
        <Link href="/properties">
          <button className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2">
            <ArrowLeft size={16} /> Back to properties
          </button>
        </Link>
      </div>
    );
  }

  // Everything the Add Property form captures, grouped for display. Each item
  // is dropped when empty so a sparsely-filled property doesn't render a wall
  // of "—". Boolean amenities/compliance collapse to chips (only the enabled
  // ones show).
  const overviewItems = [
    { label: "Type", value: property.propertyType },
    {
      label: property.propertyType === "Plot" ? "Plot size" : "Size",
      value: property.sqm ? `${property.sqm} m²` : undefined,
    },
    { label: "Floor", value: property.floor },
    { label: "Built", value: property.builtYear },
    { label: "Energy class", value: property.energyClass },
    { label: "Building", value: property.buildingName },
    { label: "Address number", value: property.addressNumber },
    { label: "Postal code", value: property.postalCode },
    {
      label: "Status",
      value: property.developmentStatus
        ? (DEVELOPMENT_STATUS_LABELS[property.developmentStatus] ?? property.developmentStatus)
        : undefined,
    },
    {
      label: "Use",
      value: property.propertyUse
        ? (PROPERTY_USE_LABELS[property.propertyUse] ?? property.propertyUse)
        : undefined,
    },
    {
      label: "Current status",
      // Status only applies to a rented-out property — hold/invest and
      // owner-occupied have no tenancy, so don't surface a (possibly stale) row.
      value:
        property.propertyUse === "owner_occupied" || property.propertyUse === "hold"
          ? undefined
          : property.occupancyStatus
            ? (OCCUPANCY_STATUS_LABELS[property.occupancyStatus] ?? property.occupancyStatus)
            : undefined,
    },
  ].filter((i) => i.value != null && i.value !== "");

  const financialItems = [
    {
      label: "Current value",
      value: property.propertyValue ? formatCurrencyCompact(property.propertyValue) : undefined,
    },
    {
      label: "Acquisition price",
      value: property.acquisitionPrice
        ? formatCurrencyCompact(property.acquisitionPrice)
        : undefined,
    },
    {
      label: property.acquisitionYear ? "Purchased" : "Developed",
      value: property.acquisitionYear || property.developmentYear,
    },
  ].filter((i) => i.value != null && i.value !== "");

  const amenities = [
    property.parking && property.parking > 0
      ? `${property.parking} parking ${property.parking === 1 ? "space" : "spaces"}`
      : null,
    property.elevator ? "Elevator" : null,
    property.heating ? "Heating" : null,
    property.cooling ? "Cooling" : null,
    property.solarPanels ? "Solar panels" : null,
    property.storageUnit ? "Storage unit" : null,
  ].filter(Boolean) as string[];

  const ownershipItems = [
    {
      label: "Ownership",
      value: property.ownershipType ? titleCase(property.ownershipType) : undefined,
    },
    { label: "Company", value: property.companyName },
    {
      label: "Title deeds",
      value: property.titleDeedsStatus ? titleCase(property.titleDeedsStatus) : undefined,
    },
  ].filter((i) => i.value != null && i.value !== "");

  const hasDetails =
    overviewItems.length > 0 ||
    financialItems.length > 0 ||
    amenities.length > 0 ||
    ownershipItems.length > 0;

  return (
    <div className="flex-1 relative">
      <AddTenantDrawer
        open={isAddTenantOpen}
        onOpenChange={setIsAddTenantOpen}
        propertyAddress={property.address}
      />

      <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />

      <EditPropertyDrawer open={isEditOpen} onOpenChange={setIsEditOpen} property={property} />

      <DeletePropertyDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        propertyId={property.id}
        propertyAddress={property.address}
      />

      {/* Hero Image */}
      <div className="h-[40vh] w-full relative bg-secondary">
        <PropertyImage src={property.image} alt={property.address} iconSize={48} />
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-background/90" />

        {/* Navbar inside hero */}
        <div className="absolute top-0 left-0 right-0 p-5 pt-12 flex justify-between items-center text-white">
          <Link href="/properties">
            <button
              type="button"
              aria-label="Back to properties"
              className="w-10 h-10 bg-card/20 backdrop-blur-md rounded-full flex items-center justify-center hover:bg-card/30 transition"
            >
              <ArrowLeft size={20} />
            </button>
          </Link>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More options"
                className="w-10 h-10 bg-card/20 backdrop-blur-md rounded-full flex items-center justify-center hover:bg-card/30 transition"
              >
                <MoreVertical size={20} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 rounded-xl p-2">
              {isSelf && (
                <DropdownMenuItem
                  onClick={() => setIsEditOpen(true)}
                  className="flex items-center gap-2 cursor-pointer p-2.5 rounded-lg"
                >
                  <Edit size={16} />
                  <span>Edit Property</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={handleDownloadBriefing}
                className="flex items-center gap-2 cursor-pointer p-2.5 rounded-lg"
              >
                <Download size={16} />
                <span>Download PDF Briefing</span>
              </DropdownMenuItem>

              {isSelf && (
                <DropdownMenuItem
                  onClick={() => setIsDeleteOpen(true)}
                  className="flex items-center gap-2 cursor-pointer p-2.5 rounded-lg text-red-500 focus:text-red-500 focus:bg-red-500/10"
                >
                  <Trash2 size={16} />
                  <span>Delete Property</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Content Card */}
      <div className="relative -mt-10 bg-background rounded-t-3xl px-6 pt-8 pb-[var(--mobile-nav-clearance)] md:pb-10 min-h-[500px]">
        {/* Header Info */}
        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1">
              {property.name || property.address}
            </h1>
            {property.name && (
              <p className="text-sm text-muted-foreground font-medium">{property.address}</p>
            )}
            {(property.city || property.country) && (
              <div className="flex items-center text-muted-foreground text-sm">
                <MapPin size={14} className="mr-1" />{" "}
                {[property.city, property.country].filter(Boolean).join(", ")}
              </div>
            )}
          </div>
          {/* Income chip — hidden for vacant or zero-rent properties so we
              never advertise €0/mo income. A pending invite still shows its
              real asking rent (displayRent falls through to the pending lease). */}
          {(isRented || isPendingTenant) && displayRent > 0 && (
            <div className="bg-primary/10 px-3 py-1.5 rounded-lg">
              <span className="text-lg font-bold text-primary">
                {formatCurrencyCompact(displayRent)}
              </span>
              <span className="text-xs text-muted-foreground">/mo</span>
            </div>
          )}
        </div>

        {/* Performance Metrics - Compact Row */}
        {isRented && (
          <>
            <h3 className="font-bold text-foreground mb-3 text-sm uppercase tracking-wide">
              Performance
            </h3>
            <div className="bg-card p-4 rounded-2xl shadow-sm border border-border mb-3 flex justify-between items-center divide-x divide-border">
              {hasAcquisitionPrice && (
                <div className="flex-1 text-center">
                  <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-1">
                    Gross Yield
                  </span>
                  <span className="font-bold text-foreground text-lg">
                    {calculatedYield?.toFixed(1)}%
                  </span>
                </div>
              )}
              <div className={`flex-1 text-center ${hasAcquisitionPrice ? "px-2" : ""}`}>
                <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-1">
                  Income (YTD)
                </span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400 text-lg">
                  +{formatCurrencyCompact(ytdIncome)}
                </span>
              </div>
              <div className="flex-1 text-center">
                <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-1">
                  Expenses
                </span>
                <span className="font-bold text-red-500 text-lg">
                  -{formatCurrencyCompact(ytdExpenses)}
                </span>
              </div>
            </div>
            {hasAcquisitionPrice && (
              <p className="text-xs text-muted-foreground mb-8 px-2 flex items-start gap-1.5">
                <Info size={14} className="shrink-0 mt-0.5 text-muted-foreground/70" />
                <span>
                  Gross Yield shows how much annual rental income your property generates compared
                  to its purchase price &mdash; before expenses.
                </span>
              </p>
            )}
            {!hasAcquisitionPrice && <div className="mb-8" />}
          </>
        )}

        {/* Property Details — everything captured in the Add Property form */}
        {hasDetails && (
          <>
            <h3 className="font-bold text-foreground mb-4 text-lg">Property Details</h3>
            <div className="space-y-3 mb-8">
              {overviewItems.length > 0 && (
                <div className="bg-card p-5 rounded-2xl shadow-sm border border-border">
                  <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-3">
                    Overview
                  </span>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    {overviewItems.map((item) => (
                      <div key={item.label}>
                        <span className="text-[11px] text-muted-foreground block">
                          {item.label}
                        </span>
                        <span className="text-sm font-semibold text-foreground">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {financialItems.length > 0 && (
                <div className="bg-card p-5 rounded-2xl shadow-sm border border-border">
                  <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-3">
                    Financials
                  </span>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    {financialItems.map((item) => (
                      <div key={item.label}>
                        <span className="text-[11px] text-muted-foreground block">
                          {item.label}
                        </span>
                        <span className="text-sm font-semibold text-foreground">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {amenities.length > 0 && (
                <div className="bg-card p-5 rounded-2xl shadow-sm border border-border">
                  <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-3">
                    Features &amp; Amenities
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {amenities.map((a) => (
                      <span
                        key={a}
                        className="inline-flex items-center bg-background text-foreground text-xs font-medium px-3 py-1.5 rounded-full border border-border"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {ownershipItems.length > 0 && (
                <div className="bg-card p-5 rounded-2xl shadow-sm border border-border">
                  <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-3">
                    Ownership
                  </span>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    {ownershipItems.map((item) => (
                      <div key={item.label}>
                        <span className="text-[11px] text-muted-foreground block">
                          {item.label}
                        </span>
                        <span className="text-sm font-semibold text-foreground">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Property Documents */}
        {propertyId && <PropertyDocumentsSection propertyId={propertyId} />}

        {/* Tenant Card */}
        <h3 className="font-bold text-foreground mb-4 text-lg">Current Tenant</h3>
        {displayTenant ? (
          <div className="bg-card p-5 rounded-2xl shadow-sm border border-border mb-8">
            <div className="flex items-center gap-4 mb-4">
              {/* Local initials avatar — no PII to a third-party CDN. */}
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center text-base font-semibold shrink-0 ${
                  isPendingTenant
                    ? "bg-orange-500/10 text-orange-600 dark:text-orange-400"
                    : "bg-primary/10 text-primary"
                }`}
              >
                {(displayTenant.name?.[0] ?? "?").toUpperCase()}
              </div>
              <div className="min-w-0">
                <h4 className="font-bold text-foreground truncate">{displayTenant.name}</h4>
                <p className="text-xs text-muted-foreground">
                  {isPendingTenant
                    ? displayTenant.status === "invited"
                      ? "Invitation sent — awaiting sign-up"
                      : "Lease sent — awaiting tenant approval"
                    : `Contract ends: ${displayAgreement?.endDate ? formatDate(displayAgreement.endDate) : "—"}`}
                </p>
              </div>
              {isPendingTenant && (
                <span className="ml-auto shrink-0 text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400">
                  {displayTenant.status === "invited" ? "Invited" : "Pending"}
                </span>
              )}
            </div>

            {isPendingTenant ? (
              <div className="bg-background p-3 rounded-xl flex items-start gap-2">
                <Info size={16} className="text-muted-foreground mt-0.5 shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {displayTenant.status === "invited"
                    ? `We've emailed ${displayTenant.name} to join Olio and approve the lease. Rent tracking starts once they accept.`
                    : `We've notified ${displayTenant.name} to review and approve the lease. Rent tracking starts once they accept.`}
                </span>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-background p-3 rounded-xl">
                  <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-1">
                    Status
                  </span>
                  <span className="text-sm font-bold text-foreground capitalize">
                    {activeTenant?.paymentStatus ?? activeTenant?.status ?? "—"}
                  </span>
                </div>
                <div className="bg-background p-3 rounded-xl">
                  <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-1">
                    Next Payment
                  </span>
                  <span className="text-sm font-bold text-foreground">
                    {activeTenant?.nextPayment ? formatDate(activeTenant.nextPayment) : "—"}
                  </span>
                </div>
              </div>
            )}
            {/* Tenant contact — email + phone (from the linked User), tappable.
     Email is skipped when it's still the display name (invited tenant
     with no real name on file) so it isn't shown twice. */}
            {(displayTenant.phone ||
              (displayTenant.email && displayTenant.email !== displayTenant.name)) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-sm">
                {displayTenant.email && displayTenant.email !== displayTenant.name && (
                  <a
                    href={`mailto:${displayTenant.email}`}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition break-all"
                  >
                    <Mail size={14} className="shrink-0" /> {displayTenant.email}
                  </a>
                )}
                {displayTenant.phone && (
                  <a
                    href={`tel:${displayTenant.phone}`}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition"
                  >
                    <Phone size={14} className="shrink-0" /> {displayTenant.phone}
                  </a>
                )}
              </div>
            )}
          </div>
        ) : isHold ? (
          <div className="bg-card p-8 rounded-2xl shadow-sm border border-border mb-8 text-center flex flex-col items-center">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4 text-primary">
              <TrendingUp size={32} />
            </div>
            <h3 className="font-bold text-foreground mb-1 text-lg">Held for investment</h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              This property is held for capital growth, so there's no tenant to add. Switch its use
              to &ldquo;Rented out&rdquo; in Edit to invite a tenant.
            </p>
          </div>
        ) : isOwnerOccupied ? (
          <div className="bg-card p-8 rounded-2xl shadow-sm border border-border mb-8 text-center flex flex-col items-center">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4 text-primary">
              <Home size={32} />
            </div>
            <h3 className="font-bold text-foreground mb-1 text-lg">Owner-occupied</h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              You live in this property, so there&rsquo;s no tenant to add. Switch its use to
              &ldquo;Rented out&rdquo; in Edit to invite a tenant.
            </p>
          </div>
        ) : (
          <div className="bg-card p-8 rounded-2xl shadow-sm border border-border mb-8 text-center flex flex-col items-center">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4 text-primary">
              <User size={32} />
            </div>
            <h3 className="font-bold text-foreground mb-1 text-lg">No Tenant Assigned</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-xs mx-auto">
              This property is currently vacant. Invite a tenant to manage their rent payments.
            </p>
            <button
              onClick={handleAddTenantClick}
              className="w-full max-w-sm bg-primary text-primary-foreground py-3.5 rounded-xl font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition flex items-center justify-center gap-2"
            >
              <Plus size={20} /> Invite Tenant
            </button>
          </div>
        )}

        {/* Activity Log */}
        <h3 className="font-bold text-foreground mb-4 text-lg mt-8">Recent Activity</h3>
        <div className="space-y-4 mb-8">
          {transactions.length > 0 ? (
            transactions.map((tx) => {
              const formattedDate = formatDateTime(tx.timestamp);
              return (
                <div
                  key={tx.id}
                  className="flex items-center justify-between bg-card p-4 rounded-2xl shadow-sm border border-border"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-12 h-12 rounded-full flex items-center justify-center text-lg overflow-hidden border ${
                        tx.type === "neutral"
                          ? "bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400"
                          : tx.type === "income"
                            ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                            : "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400"
                      }`}
                    >
                      {tx.type === "income" ? (
                        <TrendingUp size={20} />
                      ) : tx.type === "expense" ? (
                        <TrendingDown size={20} />
                      ) : (
                        <AlertTriangle size={20} />
                      )}
                    </div>
                    <div className="flex flex-col">
                      <span className="font-semibold text-sm text-foreground line-clamp-1">
                        {tx.name}
                      </span>
                      <span className="text-xs text-muted-foreground">{formattedDate}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end min-w-[80px]">
                    <span
                      className={`font-bold text-sm ${
                        tx.type === "income"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : tx.type === "expense"
                            ? "text-foreground"
                            : "text-orange-500 dark:text-orange-400"
                      }`}
                    >
                      {tx.type === "expense" ? "-" : tx.type === "income" ? "+" : ""}
                      {formatCurrency(tx.amount, { currency: tx.currency })}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70 capitalize">
                      {tx.category}
                    </span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="bg-card p-8 rounded-2xl shadow-sm border border-border text-center">
              <p className="text-muted-foreground text-sm">No recent activity for this property.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
