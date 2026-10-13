// Presentational, read-only body for the public property view (hero +
// overview + amenities). Shared by:
//   - PublicPropertyPage      → logged-out visitors (standalone page)
//   - PropertyDetailsPage     → logged-in non-owners (fallback inside the
//                               authenticated app shell)
//
// Renders ONLY the public-safe subset. No financials, tenant, documents,
// ownership/compliance, or activity — there's deliberately nowhere here
// to surface them.

import type { ReactNode } from "react";
import { MapPin } from "lucide-react";
import { PropertyImage } from "@ui/components/common/PropertyImage";
import type { PublicProperty } from "@/lib/publicQueries";

// Same human labels the owner page uses for the coded form values.
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

interface Props {
  property: PublicProperty;
  // Rendered absolutely over the top-left of the hero (e.g. a back
  // button). Optional so the logged-out page can omit it.
  heroOverlay?: ReactNode;
  // Appended at the bottom of the content card (e.g. the sign-up CTA on
  // the logged-out page).
  children?: ReactNode;
}

export function PublicPropertyView({ property, heroOverlay, children }: Props) {
  const overviewItems = [
    { label: "Type", value: property.propertyType },
    {
      label: property.propertyType === "Plot" ? "Plot size" : "Size",
      value: property.sqm ? `${property.sqm} m²` : undefined,
    },
    { label: "Bedrooms", value: property.bedrooms ? String(property.bedrooms) : undefined },
    { label: "Bathrooms", value: property.baths ? String(property.baths) : undefined },
    { label: "Floor", value: property.floor },
    { label: "Built", value: property.builtYear },
    { label: "Energy class", value: property.energyClass },
    { label: "Building", value: property.buildingName },
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

  const location = [property.city, property.country].filter(Boolean).join(", ");

  return (
    <>
      {/* Hero Image */}
      <div className="h-[40vh] w-full relative bg-secondary">
        <PropertyImage src={property.image} alt={property.name || property.address} iconSize={48} />
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-background/90" />
        {heroOverlay && (
          <div className="absolute top-0 left-0 right-0 p-5 pt-12 flex justify-between items-center text-white">
            {heroOverlay}
          </div>
        )}
      </div>

      {/* Content Card */}
      <div className="relative -mt-10 bg-background rounded-t-3xl px-6 pt-8 pb-16 min-h-[400px] max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground mb-1">
            {property.name || property.address}
          </h1>
          {property.name && (
            <p className="text-sm text-muted-foreground font-medium">{property.address}</p>
          )}
          {location && (
            <div className="flex items-center text-muted-foreground text-sm mt-1">
              <MapPin size={14} className="mr-1" /> {location}
            </div>
          )}
        </div>

        {overviewItems.length > 0 && (
          <>
            <h3 className="font-bold text-foreground mb-4 text-lg">Property Details</h3>
            <div className="bg-card p-5 rounded-2xl shadow-sm border border-border mb-4">
              <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide block mb-3">
                Overview
              </span>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {overviewItems.map((item) => (
                  <div key={item.label}>
                    <span className="text-[11px] text-muted-foreground block">{item.label}</span>
                    <span className="text-sm font-semibold text-foreground">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {amenities.length > 0 && (
          <div className="bg-card p-5 rounded-2xl shadow-sm border border-border mb-4">
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

        {children}
      </div>
    </>
  );
}
