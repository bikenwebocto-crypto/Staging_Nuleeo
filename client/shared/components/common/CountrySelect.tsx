import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Check, Search } from "lucide-react";
import { cn } from "@ui/lib/utils";
import { EUROPEAN_COUNTRIES, findCountryByName, type CountryInfo } from "@ui/data/countries";

interface CountrySelectProps {
  /** Selected country NAME (e.g. "Cyprus") — kept as the stored value. */
  value: string;
  /** Fires with the picked country's name and ISO2 code. */
  onChange: (name: string, code: string) => void;
  className?: string;
  testId?: string;
}

// Searchable country dropdown. Built on the same self-contained pattern as
// AddressAutocomplete (trigger + absolutely-positioned list + click-outside)
// rather than Radix Popover/Command, because that idiom is already proven to
// behave inside the property drawer's Dialog (no focus-trap fights).
export function CountrySelect({
  value,
  onChange,
  className,
  testId = "select-country",
}: CountrySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = findCountryByName(value);

  const filtered = useMemo<CountryInfo[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EUROPEAN_COUNTRIES;
    return EUROPEAN_COUNTRIES.filter((c) => c.name.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Focus the search box when the list opens, and reset transient state on close.
  useEffect(() => {
    if (open) {
      setHighlight(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    setQuery("");
  }, [open]);

  const pick = (c: CountryInfo) => {
    onChange(c.name, c.code);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlight]) pick(filtered[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 bg-background border-none rounded-xl px-4 py-3.5 text-left text-foreground font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
      >
        {selected ? (
          <span className="flex items-center gap-2 truncate">
            <span className="text-base leading-none">{selected.flag}</span>
            <span className="truncate">{selected.name}</span>
          </span>
        ) : (
          <span className={cn("truncate", value ? "text-foreground" : "text-muted-foreground/70")}>
            {value || "Select country"}
          </span>
        )}
        <ChevronDown
          size={16}
          className={cn(
            "ml-auto shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-xl shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search size={14} className="text-muted-foreground/70 shrink-0" />
            <input
              ref={inputRef}
              data-testid={`${testId}-search`}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search country…"
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              autoComplete="off"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">No matching country.</p>
            ) : (
              filtered.map((c, i) => {
                const isSelected = selected?.code === c.code;
                return (
                  <button
                    key={c.code}
                    type="button"
                    data-testid={`${testId}-option-${c.code}`}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pick(c)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition",
                      i === highlight ? "bg-secondary" : "hover:bg-secondary/50",
                    )}
                  >
                    <span className="text-base leading-none">{c.flag}</span>
                    <span className="text-foreground truncate">{c.name}</span>
                    {isSelected && <Check size={14} className="ml-auto shrink-0 text-primary" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
