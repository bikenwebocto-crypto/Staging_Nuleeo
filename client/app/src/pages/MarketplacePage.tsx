import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMarketplaceListings } from "@/lib/ownerQueries";
import { MapPin, Bed, Bath, Maximize, ArrowUpRight, Home } from "lucide-react";
import { motion } from "framer-motion";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { PageHeader } from "@ui/components/common/PageHeader";
import { PropertyImage } from "@ui/components/common/PropertyImage";
import { TableFiltersCard, TableSearchInput, FilterPills } from "@ui/components/ui/data-table";
import { formatCurrencyCompact } from "@ui/lib/format";
import type { MarketplaceListingTag } from "@shared/firestore-schema";

// Canonical badge order. We only surface a tag pill when at least one listing
// actually carries that tag, so the filter row never shows a dead option.
const TAG_ORDER: MarketplaceListingTag[] = ["Hot Deal", "New", "Featured", "Off-market"];

const BEDS_OPTIONS = [
  { id: "any", label: "Any beds" },
  { id: "1", label: "1+ beds" },
  { id: "2", label: "2+ beds" },
  { id: "3", label: "3+ beds" },
];

export default function MarketplacePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [bedsFilter, setBedsFilter] = useState("any");
  const { data: listings = [], isLoading } = useMarketplaceListings();

  // Build the tag pills from the tags actually present in the data, in
  // canonical order, with an "All" reset always first.
  const tagOptions = useMemo(() => {
    const present = new Set(listings.map((l) => l.tag).filter(Boolean));
    const opts = [{ id: "all", label: "All" }];
    for (const t of TAG_ORDER) if (present.has(t)) opts.push({ id: t, label: t });
    return opts;
  }, [listings]);

  // Search matches title + location + tag; the pills narrow by tag and a
  // minimum bedroom count (e.g. "2+ beds"). All three combine.
  const filteredListings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const minBeds = bedsFilter === "any" ? 0 : parseInt(bedsFilter, 10);
    return listings.filter((item) => {
      if (tagFilter !== "all" && item.tag !== tagFilter) return false;
      if ((item.beds ?? 0) < minBeds) return false;
      if (!q) return true;
      const hay = `${item.title} ${item.location} ${item.tag ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [listings, searchQuery, tagFilter, bedsFilter]);

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <PageHeader title="Marketplace" subtitle="Discover investment opportunities" />

      {/* Search + filters */}
      <TableFiltersCard>
        <TableSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search by location, title, or tag…"
        />
        {tagOptions.length > 1 && (
          <FilterPills options={tagOptions} value={tagFilter} onChange={setTagFilter} />
        )}
        <FilterPills options={BEDS_OPTIONS} value={bedsFilter} onChange={setBedsFilter} />
      </TableFiltersCard>

      {/* Listings */}
      {!isLoading && listings.length === 0 && (
        <div className="bg-card border border-border/60 rounded-2xl py-16 text-center text-muted-foreground text-sm">
          No marketplace listings yet. Check back soon.
        </div>
      )}
      {!isLoading && listings.length > 0 && filteredListings.length === 0 && (
        <div className="bg-card border border-border/60 rounded-2xl py-16 text-center text-muted-foreground text-sm">
          No listings match your search or filters.
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
        {filteredListings.map((item, i) => {
          return (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="bg-card rounded-2xl overflow-hidden shadow-sm border border-border group block"
            >
              <Link
                href={`/marketplace/${item.id}`}
                className="block cursor-pointer hover:shadow-md transition"
              >
                <div className="relative h-48 overflow-hidden bg-secondary">
                  <PropertyImage
                    src={item.image}
                    alt={item.title}
                    icon={Home}
                    iconSize={32}
                    className="group-hover:scale-105 transition duration-500"
                  />

                  {item.tag && (
                    <div className="absolute top-3 left-3 bg-card/90 backdrop-blur-sm px-2 py-1 rounded-md text-xs font-bold text-foreground shadow-sm">
                      {item.tag}
                    </div>
                  )}
                  {typeof item.roi === "number" && (
                    <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-md text-xs font-bold text-white flex items-center gap-1">
                      <ArrowUpRight size={12} className="text-green-400" /> Projected ROI:{" "}
                      {item.roi}%
                    </div>
                  )}
                </div>

                <div className="p-4">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <h3 className="font-bold text-foreground text-sm line-clamp-1">
                        {item.title}
                      </h3>
                      <div className="flex items-center text-muted-foreground text-xs mt-0.5">
                        <MapPin size={12} className="mr-1" /> {item.location}
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="font-bold text-primary text-base block">
                        {formatCurrencyCompact(item.price)}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t border-border text-xs text-muted-foreground">
                    <div className="flex items-center gap-3">
                      {typeof item.beds === "number" && item.beds > 0 && (
                        <span className="flex items-center gap-1">
                          <Bed size={14} /> {item.beds}
                        </span>
                      )}
                      {typeof item.baths === "number" && item.baths > 0 && (
                        <span className="flex items-center gap-1">
                          <Bath size={14} /> {item.baths}
                        </span>
                      )}
                      {typeof item.sqm === "number" && (
                        <span className="flex items-center gap-1">
                          <Maximize size={14} /> {item.sqm}m²
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
