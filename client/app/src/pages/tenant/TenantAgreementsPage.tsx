import useEmblaCarousel from "embla-carousel-react";
import { FileText, Download, Check, X } from "lucide-react";
import { motion } from "framer-motion";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { useState, useEffect } from "react";
import { useToast } from "@ui/hooks/use-toast";
import { useAuth } from "@ui/lib/useAuth";
import {
  useTenantAgreements,
  useRespondToAgreement,
  type TenantAgreement,
} from "@/lib/tenantQueries";
import { formatDate } from "@ui/lib/format";
import {
  AgreementDocument,
  openAgreementPdf,
  fmtMoney,
  orDash,
  statusLabel,
  statusClass,
} from "@ui/components/agreements/AgreementDocument";
import { pickFallbackImage } from "@/lib/fallbackImage";

export default function TenantAgreementsPage() {
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: false, align: "start" });
  const [detailsOpenId, setDetailsOpenId] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const { toast } = useToast();
  const { profile } = useAuth();
  const { data: agreementsData, isLoading } = useTenantAgreements();
  const respond = useRespondToAgreement();

  const handleRespond = (id: string, action: "approve" | "decline") => {
    respond.mutate(
      { id, action },
      {
        onSuccess: () => {
          toast({
            title: action === "approve" ? "Lease accepted" : "Lease declined",
            description:
              action === "approve"
                ? "Your lease is now active."
                : "You've declined this lease. Your landlord has been notified.",
          });
        },
        onError: (err) => {
          toast({
            title: "Something went wrong",
            description: err.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const tenantName = profile
    ? `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || profile.email
    : "";

  const agreements: (TenantAgreement & { image: string })[] = (agreementsData ?? []).map((a) => ({
    ...a,
    image: a.image ?? pickFallbackImage(a.id),
  }));

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setCurrentIndex(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSelect);
    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi]);

  const handleDownloadPdf = (agreement: TenantAgreement) =>
    openAgreementPdf(agreement, {
      landlordName: agreement.landlord,
      tenantName,
      onPopupBlocked: () =>
        toast({
          title: "Please allow pop-ups",
          description: "Enable pop-ups for this site to download your lease as a PDF.",
          variant: "destructive",
        }),
    });

  const renderAgreementPdf = (agreement: TenantAgreement) => (
    <AgreementDocument
      agreement={agreement}
      landlordName={agreement.landlord}
      tenantName={tenantName || "—"}
    />
  );

  const showEmpty = !isLoading && agreements.length === 0;

  return (
    <>
      <div className="flex-1 h-full bg-background relative">
        {/* Mobile: Background image */}
        <div className="fixed top-0 left-0 right-0 h-full md:hidden z-0 overflow-hidden pointer-events-none bg-white dark:bg-black">
          {agreements.map((agreement, index) => (
            <motion.div
              key={agreement.id}
              initial={false}
              animate={{
                opacity: index === currentIndex ? 1 : 0,
                scale: index === currentIndex ? 1 : 1.1,
                filter: index === currentIndex ? "blur(0px)" : "blur(10px)",
              }}
              transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-0"
            >
              <img
                src={agreement.image}
                alt="Property"
                className="w-full h-full object-cover opacity-40 md:opacity-50"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-black/40 to-background dark:from-background/90 dark:via-background/70 dark:to-background" />
            </motion.div>
          ))}
        </div>

        {isLoading && (
          <div className="hidden md:block relative z-10 mt-16 px-10 pb-10">
            <div className="grid grid-cols-2 gap-6">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="rounded-2xl bg-card/40 border border-border/40 h-[340px] animate-pulse"
                />
              ))}
            </div>
          </div>
        )}

        {showEmpty && (
          <div className="relative z-10 flex flex-col items-center justify-center text-center px-6 pt-[var(--mobile-header-clearance)] pb-16">
            <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
              <FileText size={28} />
            </div>
            <h2 className="text-xl font-bold text-foreground mb-2">No agreements yet</h2>
            <p className="text-muted-foreground max-w-sm">
              When your landlord assigns you to a lease, it will appear here for download and
              review.
            </p>
          </div>
        )}

        {/* Mobile: Swipeable cards + details */}
        {!isLoading && !showEmpty && (
          <div
            className={`md:hidden relative z-10 mt-24 ${agreements.length === 1 ? "px-5" : "pl-5"}`}
          >
            <div
              className="w-full max-w-2xl overflow-visible"
              ref={agreements.length > 1 ? emblaRef : undefined}
            >
              <div className={agreements.length > 1 ? "flex touch-pan-y" : "flex flex-col"}>
                {agreements.map((agreement) => (
                  <div
                    key={agreement.id}
                    className={
                      agreements.length > 1 ? "flex-[0_0_90%] min-w-0 pr-4 last:pr-5" : "w-full"
                    }
                  >
                    {/* Agreement Card */}
                    <div className="rounded-[2.5rem] w-full relative overflow-hidden shadow-[0_16px_64px_rgba(0,0,0,0.3)] min-h-[340px]">
                      <img
                        src={agreement.image}
                        alt={agreement.address}
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/30" />
                      <div className="relative z-10 p-7 flex flex-col h-full">
                        <div className="mb-4">
                          <h2 className="text-2xl font-bold text-white mb-1">
                            {agreement.leaseType}
                          </h2>
                          <p className="text-sm text-white/80 font-medium">{agreement.address}</p>
                          <p className="text-xs text-white/60 font-bold mt-1 uppercase tracking-wider">
                            {agreement.landlord}
                          </p>
                        </div>
                        <div className="space-y-3">
                          {agreement.status === "pending_tenant" && (
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleRespond(agreement.id, "approve")}
                                disabled={respond.isPending}
                                className="flex-1 bg-success text-success-foreground font-bold py-3.5 rounded-2xl hover:bg-success/90 shadow-md transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2 disabled:opacity-60"
                              >
                                <Check size={18} /> Approve
                              </button>
                              <button
                                onClick={() => handleRespond(agreement.id, "decline")}
                                disabled={respond.isPending}
                                className="flex-1 bg-white/10 backdrop-blur-xl text-white font-bold py-3.5 rounded-2xl border border-white/20 hover:bg-white/20 shadow-sm transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2 disabled:opacity-60"
                              >
                                <X size={18} /> Decline
                              </button>
                            </div>
                          )}
                          <button
                            onClick={() => setDetailsOpenId(agreement.id)}
                            className="w-full bg-white text-neutral-900 font-bold py-3.5 rounded-2xl hover:bg-white/90 shadow-md transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2"
                          >
                            <FileText size={18} />
                            View Agreement
                          </button>
                          <button
                            onClick={() => handleDownloadPdf(agreement)}
                            className="w-full bg-white/10 backdrop-blur-xl text-white font-bold py-3.5 rounded-2xl border border-white/20 hover:bg-white/20 shadow-sm transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2"
                          >
                            <Download size={18} />
                            Download PDF
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Details drawer for this agreement */}
                    <ResponsiveDrawer
                      open={detailsOpenId === agreement.id}
                      onOpenChange={(open) => {
                        if (!open) setDetailsOpenId(null);
                      }}
                      title="Lease Agreement"
                      footer={
                        <div className="space-y-2.5">
                          <button
                            onClick={() => {
                              handleDownloadPdf(agreement);
                            }}
                            className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl hover:bg-primary/90 transition flex items-center justify-center gap-2"
                          >
                            <Download size={16} /> Download PDF
                          </button>
                          <button
                            onClick={() => setDetailsOpenId(null)}
                            className="w-full text-muted-foreground font-medium py-2.5 rounded-xl hover:bg-muted/50 transition text-sm"
                          >
                            Close
                          </button>
                        </div>
                      }
                    >
                      {renderAgreementPdf(agreement)}
                    </ResponsiveDrawer>

                    {/* Frosted glass info drawer */}
                    <div className="bg-black/30 dark:bg-white/10 backdrop-blur-xl border border-white/20 rounded-t-3xl pt-4 px-5 mt-4 pb-24">
                      <div className="flex justify-center mb-4">
                        <div className="w-10 h-1 bg-white/30 rounded-full" />
                      </div>

                      {/* Lease Details */}
                      <h4 className="text-white/40 text-[10px] font-bold uppercase tracking-wider mb-3">
                        Lease Details
                      </h4>
                      <div className="space-y-3 mb-6">
                        <div className="flex items-center justify-between">
                          <span className="text-white/60 text-sm">Landlord</span>
                          <span className="text-white text-sm font-semibold">
                            {agreement.landlord}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-white/60 text-sm">Monthly Rent</span>
                          <span className="text-white text-sm font-bold">
                            {fmtMoney(agreement.monthlyRent)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-white/60 text-sm">Deposit</span>
                          <span className="text-white text-sm font-semibold">
                            {fmtMoney(agreement.deposit)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-white/60 text-sm">Lease Period</span>
                          <span className="text-white text-sm font-semibold">
                            {formatDate(agreement.startDate)} – {formatDate(agreement.endDate)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-white/60 text-sm">Status</span>
                          <span
                            className={`text-sm font-semibold ${statusClass(agreement.status)}`}
                          >
                            {statusLabel(agreement.status)}
                          </span>
                        </div>
                      </div>

                      {/* Property Details */}
                      <div className="border-t border-white/10 pt-4 mb-6">
                        <h4 className="text-white/40 text-[10px] font-bold uppercase tracking-wider mb-3">
                          Property Details
                        </h4>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">Type</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.propertyType)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">Building</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.buildingName)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">Floor</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.floor)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">Size</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.sqm, agreement.sqm ? " m²" : "")}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">Built</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.builtYear)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">Energy Class</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.energyClass)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Location */}
                      <div className="border-t border-white/10 pt-4 mb-6">
                        <h4 className="text-white/40 text-[10px] font-bold uppercase tracking-wider mb-3">
                          Location
                        </h4>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">City</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.city)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">Postal Code</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.postalCode)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-white/60 text-sm">Country</span>
                            <span className="text-white text-sm font-semibold">
                              {orDash(agreement.country)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Building Features */}
                      <div className="border-t border-white/10 pt-4 mb-6">
                        <h4 className="text-white/40 text-[10px] font-bold uppercase tracking-wider mb-3">
                          Building Features
                        </h4>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="flex items-center gap-2">
                            <div
                              role="img"
                              aria-label={
                                agreement.heating ? "Heating included" : "Heating not included"
                              }
                              className={`w-2 h-2 rounded-full ${agreement.heating ? "bg-success" : "bg-white/20"}`}
                            />
                            <span className="text-white/70 text-sm">Heating</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div
                              role="img"
                              aria-label={
                                agreement.cooling ? "Cooling included" : "Cooling not included"
                              }
                              className={`w-2 h-2 rounded-full ${agreement.cooling ? "bg-success" : "bg-white/20"}`}
                            />
                            <span className="text-white/70 text-sm">Cooling</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div
                              role="img"
                              aria-label={
                                agreement.elevator ? "Elevator included" : "Elevator not included"
                              }
                              className={`w-2 h-2 rounded-full ${agreement.elevator ? "bg-success" : "bg-white/20"}`}
                            />
                            <span className="text-white/70 text-sm">Elevator</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div
                              role="img"
                              aria-label={
                                agreement.solarPanels
                                  ? "Solar panels included"
                                  : "Solar panels not included"
                              }
                              className={`w-2 h-2 rounded-full ${agreement.solarPanels ? "bg-success" : "bg-white/20"}`}
                            />
                            <span className="text-white/70 text-sm">Solar Panels</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div
                              role="img"
                              aria-label={
                                agreement.storageUnit
                                  ? "Storage unit included"
                                  : "Storage unit not included"
                              }
                              className={`w-2 h-2 rounded-full ${agreement.storageUnit ? "bg-success" : "bg-white/20"}`}
                            />
                            <span className="text-white/70 text-sm">Storage Unit</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-2 h-2 rounded-full ${(agreement.parking ?? 0) > 0 ? "bg-success" : "bg-white/20"}`}
                            />
                            <span className="text-white/70 text-sm">
                              Parking ({agreement.parking ?? 0})
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Desktop layout */}
        {!isLoading && !showEmpty && (
          <div className="hidden md:block relative z-10 mt-16 px-10 pb-10">
            <div className="grid grid-cols-2 gap-6">
              {agreements.map((agreement) => (
                <div key={agreement.id} className="flex flex-col gap-6">
                  {/* Agreement Card */}
                  <div className="rounded-[2rem] w-full relative overflow-hidden shadow-[0_16px_64px_rgba(0,0,0,0.3)] min-h-[340px]">
                    <img
                      src={agreement.image}
                      alt={agreement.address}
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/30" />
                    <div className="relative z-10 p-7 flex flex-col h-full">
                      <div className="mb-6">
                        <h2 className="text-2xl font-bold text-white mb-1">
                          {agreement.leaseType}
                        </h2>
                        <p className="text-sm text-white/80 font-medium">{agreement.address}</p>
                        <p className="text-xs text-white/60 font-bold mt-1 uppercase tracking-wider">
                          {agreement.landlord}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-white/80 font-medium mt-auto mb-6">
                        <span>{fmtMoney(agreement.monthlyRent)}/mo</span>
                        <span className="text-white/30">·</span>
                        <span>
                          {formatDate(agreement.startDate)} – {formatDate(agreement.endDate)}
                        </span>
                      </div>
                      <div className="space-y-3">
                        {agreement.status === "pending_tenant" && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleRespond(agreement.id, "approve")}
                              disabled={respond.isPending}
                              className="flex-1 bg-success text-success-foreground font-bold py-3.5 rounded-2xl hover:bg-success/90 shadow-md transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2 disabled:opacity-60"
                            >
                              <Check size={18} /> Approve
                            </button>
                            <button
                              onClick={() => handleRespond(agreement.id, "decline")}
                              disabled={respond.isPending}
                              className="flex-1 bg-white/10 backdrop-blur-xl text-white font-bold py-3.5 rounded-2xl border border-white/20 hover:bg-white/20 shadow-sm transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2 disabled:opacity-60"
                            >
                              <X size={18} /> Decline
                            </button>
                          </div>
                        )}
                        <button
                          onClick={() => setDetailsOpenId(agreement.id)}
                          className="w-full bg-white text-neutral-900 font-bold py-3.5 rounded-2xl hover:bg-white/90 shadow-md transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2"
                        >
                          <FileText size={18} /> View Agreement
                        </button>
                        <button
                          onClick={() => handleDownloadPdf(agreement)}
                          className="w-full bg-white/10 backdrop-blur-xl text-white font-bold py-3.5 rounded-2xl border border-white/20 hover:bg-white/20 shadow-sm transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2"
                        >
                          <Download size={18} /> Download PDF
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Property info */}
                  <div className="bg-card/60 dark:bg-white/[0.06] backdrop-blur-xl border border-border/50 dark:border-white/[0.08] rounded-2xl p-5 space-y-5">
                    {/* Lease Details */}
                    <div>
                      <h4 className="text-muted-foreground/60 text-[10px] font-bold uppercase tracking-wider mb-2.5">
                        Lease Details
                      </h4>
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Landlord</span>
                          <span className="font-semibold text-foreground">
                            {agreement.landlord}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Monthly Rent</span>
                          <span className="font-bold text-foreground">
                            {fmtMoney(agreement.monthlyRent)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Deposit</span>
                          <span className="font-semibold text-foreground">
                            {fmtMoney(agreement.deposit)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Lease Period</span>
                          <span className="font-semibold text-foreground">
                            {formatDate(agreement.startDate)} – {formatDate(agreement.endDate)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Status</span>
                          <span className={`font-semibold ${statusClass(agreement.status)}`}>
                            {statusLabel(agreement.status)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Property Details */}
                    <div className="border-t border-border/30 pt-4">
                      <h4 className="text-muted-foreground/60 text-[10px] font-bold uppercase tracking-wider mb-2.5">
                        Property Details
                      </h4>
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Type</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.propertyType)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Building</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.buildingName)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Floor</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.floor)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Size</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.sqm, agreement.sqm ? " m²" : "")}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Built</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.builtYear)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Energy Class</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.energyClass)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Location */}
                    <div className="border-t border-border/30 pt-4">
                      <h4 className="text-muted-foreground/60 text-[10px] font-bold uppercase tracking-wider mb-2.5">
                        Location
                      </h4>
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">City</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.city)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Postal Code</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.postalCode)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Country</span>
                          <span className="font-semibold text-foreground">
                            {orDash(agreement.country)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Building Features */}
                    <div className="border-t border-border/30 pt-4">
                      <h4 className="text-muted-foreground/60 text-[10px] font-bold uppercase tracking-wider mb-2.5">
                        Building Features
                      </h4>
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="flex items-center gap-2">
                          <div
                            role="img"
                            aria-label={
                              agreement.heating ? "Heating included" : "Heating not included"
                            }
                            className={`w-2 h-2 rounded-full ${agreement.heating ? "bg-success" : "bg-muted-foreground/20"}`}
                          />
                          <span className="text-sm text-muted-foreground">Heating</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div
                            role="img"
                            aria-label={
                              agreement.cooling ? "Cooling included" : "Cooling not included"
                            }
                            className={`w-2 h-2 rounded-full ${agreement.cooling ? "bg-success" : "bg-muted-foreground/20"}`}
                          />
                          <span className="text-sm text-muted-foreground">Cooling</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div
                            role="img"
                            aria-label={
                              agreement.elevator ? "Elevator included" : "Elevator not included"
                            }
                            className={`w-2 h-2 rounded-full ${agreement.elevator ? "bg-success" : "bg-muted-foreground/20"}`}
                          />
                          <span className="text-sm text-muted-foreground">Elevator</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div
                            role="img"
                            aria-label={
                              agreement.solarPanels
                                ? "Solar panels included"
                                : "Solar panels not included"
                            }
                            className={`w-2 h-2 rounded-full ${agreement.solarPanels ? "bg-success" : "bg-muted-foreground/20"}`}
                          />
                          <span className="text-sm text-muted-foreground">Solar Panels</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div
                            role="img"
                            aria-label={
                              agreement.storageUnit
                                ? "Storage unit included"
                                : "Storage unit not included"
                            }
                            className={`w-2 h-2 rounded-full ${agreement.storageUnit ? "bg-success" : "bg-muted-foreground/20"}`}
                          />
                          <span className="text-sm text-muted-foreground">Storage Unit</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div
                            className={`w-2 h-2 rounded-full ${(agreement.parking ?? 0) > 0 ? "bg-success" : "bg-muted-foreground/20"}`}
                          />
                          <span className="text-sm text-muted-foreground">
                            Parking ({agreement.parking ?? 0})
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ResponsiveDrawer for viewing agreement */}
                  <ResponsiveDrawer
                    open={detailsOpenId === agreement.id}
                    onOpenChange={(open) => {
                      if (!open) setDetailsOpenId(null);
                    }}
                    title="Lease Agreement"
                    desktopMaxWidth="max-w-[640px]"
                    footer={
                      <div className="space-y-2.5">
                        <button
                          onClick={() => handleDownloadPdf(agreement)}
                          className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl hover:bg-primary/90 transition flex items-center justify-center gap-2"
                        >
                          <Download size={16} /> Download PDF
                        </button>
                        <button
                          onClick={() => setDetailsOpenId(null)}
                          className="w-full text-muted-foreground font-medium py-2.5 rounded-xl hover:bg-muted/50 transition text-sm"
                        >
                          Close
                        </button>
                      </div>
                    }
                  >
                    {renderAgreementPdf(agreement)}
                  </ResponsiveDrawer>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
