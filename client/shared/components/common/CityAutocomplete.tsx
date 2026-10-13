import { useEffect, useRef, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { cn } from "@ui/lib/utils";

interface NominatimCity {
  place_id: number;
  display_name: string;
  name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    country?: string;
  };
}

interface CityAutocompleteProps {
  value: string;
  onChange: (val: string) => void;
  /** ISO2 country code (lowercase) to scope suggestions to, e.g. "cy". */
  countryCode: string;
  placeholder?: string;
  className?: string;
  testId?: string;
}

// Pulls the cleanest place name out of a Nominatim hit.
function cityNameOf(r: NominatimCity): string {
  const a = r.address ?? {};
  return a.city ?? a.town ?? a.village ?? a.municipality ?? r.name ?? r.display_name.split(",")[0];
}

// Type-ahead city picker. Queries Nominatim's `city` field scoped to the chosen
// country (so suggestions follow the selected Country), but still allows free
// typing for places OSM doesn't list. Same free-OSM stack as AddressAutocomplete.
export function CityAutocomplete({
  value,
  onChange,
  countryCode,
  placeholder = "Start typing a city…",
  className,
  testId = "input-city",
}: CityAutocompleteProps) {
  const [results, setResults] = useState<NominatimCity[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastPickRef = useRef<string>("");

  useEffect(() => {
    const q = value.trim();
    // Don't re-query the value we just picked (avoids reopening the list).
    if (q.length < 2 || q === lastPickRef.current) {
      if (q.length < 2) setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("city", q);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("limit", "6");
        if (countryCode) url.searchParams.set("countrycodes", countryCode);
        const res = await fetch(url.toString(), {
          signal: ctrl.signal,
          headers: { "Accept-Language": "en" },
        });
        if (!res.ok) throw new Error("Lookup failed");
        const data = (await res.json()) as NominatimCity[];
        // De-dupe by resolved city name — Nominatim often returns several rows
        // (suburb, admin boundary, node) that collapse to the same city.
        const seen = new Set<string>();
        const unique = data.filter((r) => {
          const n = cityNameOf(r).toLowerCase();
          if (!n || seen.has(n)) return false;
          seen.add(n);
          return true;
        });
        setResults(unique);
        setHighlight(0);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    }, 450);
    return () => clearTimeout(handle);
  }, [value, countryCode]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const select = (r: NominatimCity) => {
    const name = cityNameOf(r);
    lastPickRef.current = name;
    onChange(name);
    setOpen(false);
    setResults([]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(results.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(results[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <Building2
        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
        size={16}
      />
      <input
        data-testid={testId}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (e.target.value.length >= 2) setOpen(true);
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={cn(
          "w-full bg-background border-none rounded-xl pl-10 pr-10 py-3.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition",
          className,
        )}
        autoComplete="off"
      />
      {loading && (
        <Loader2
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin"
          size={16}
        />
      )}
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-xl shadow-lg overflow-hidden max-h-64 overflow-y-auto">
          {results.map((r, i) => (
            <button
              key={r.place_id}
              type="button"
              onMouseEnter={() => setHighlight(i)}
              onClick={() => select(r)}
              className={cn(
                "w-full text-left px-4 py-2.5 text-sm transition flex items-start gap-2",
                i === highlight ? "bg-secondary" : "hover:bg-secondary/50",
              )}
            >
              <Building2 size={14} className="text-muted-foreground/70 mt-0.5 shrink-0" />
              <span className="flex flex-col">
                <span className="text-foreground">{cityNameOf(r)}</span>
                <span className="text-[11px] text-muted-foreground truncate">{r.display_name}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
