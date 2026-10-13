import { useEffect, useRef, useState } from "react";
import { MapPin, Loader2 } from "lucide-react";
import { cn } from "@ui/lib/utils";

export interface AddressPick {
  fullAddress: string;
  city: string;
  postalCode: string;
  country: string;
  lat: number;
  lng: number;
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  address?: {
    house_number?: string;
    road?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    county?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (val: string) => void;
  onPick: (pick: AddressPick) => void;
  placeholder?: string;
  className?: string;
  countryCodes?: string;
  testId?: string;
}

export function AddressAutocomplete({
  value,
  onChange,
  onPick,
  placeholder = "Start typing an address...",
  className,
  countryCodes = "cy",
  testId = "input-address",
}: AddressAutocompleteProps) {
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastQueryRef = useRef<string>("");

  useEffect(() => {
    const q = value.trim();
    if (q.length < 3 || q === lastQueryRef.current) {
      if (q.length < 3) setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("q", q);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("limit", "5");
        if (countryCodes) url.searchParams.set("countrycodes", countryCodes);
        const res = await fetch(url.toString(), {
          signal: ctrl.signal,
          headers: { "Accept-Language": "en" },
        });
        if (!res.ok) throw new Error("Lookup failed");
        const data = (await res.json()) as NominatimResult[];
        lastQueryRef.current = q;
        setResults(data);
        setHighlight(0);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [value, countryCodes]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const select = (r: NominatimResult) => {
    const a = r.address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? a.county ?? "";
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    const fullAddress = street || r.display_name.split(",")[0];
    const pick: AddressPick = {
      fullAddress,
      city,
      postalCode: a.postcode ?? "",
      country: a.country ?? "",
      lat: Number(r.lat),
      lng: Number(r.lon),
    };
    // Mark this value as already-searched so the debounced effect below
    // doesn't re-fetch (and re-open the dropdown) when `value` updates.
    lastQueryRef.current = fullAddress;
    onChange(fullAddress);
    onPick(pick);
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
      <MapPin
        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
        size={16}
      />
      <input
        data-testid={testId}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (e.target.value.length >= 3) setOpen(true);
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
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-xl shadow-lg overflow-hidden max-h-72 overflow-y-auto">
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
              <MapPin size={14} className="text-muted-foreground/70 mt-0.5 shrink-0" />
              <span className="text-foreground truncate">{r.display_name}</span>
            </button>
          ))}
        </div>
      )}
      {open && !loading && results.length === 0 && value.trim().length >= 3 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-xl shadow-lg px-4 py-3 text-xs text-muted-foreground">
          No matches. Keep typing or check spelling.
        </div>
      )}
    </div>
  );
}
