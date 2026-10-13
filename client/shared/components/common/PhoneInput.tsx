import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/components/ui/select";
import { cn } from "@ui/lib/utils";
import {
  COUNTRY_CODES,
  DEFAULT_PHONE_COUNTRY,
  findPhoneCountry,
  parseStoredPhone,
  combinePhone,
} from "@ui/data/phoneCountries";

interface PhoneInputProps {
  /** Stored phone value in the canonical "+357 99123456" format (or "" / legacy). */
  value: string;
  /** Receives the new stored value — "" when the number is cleared. */
  onChange: (value: string) => void;
  id?: string;
  autoComplete?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Overrides the wrapper class — defaults to the muted settings-form look. */
  className?: string;
}

// Phone field with a country-code dropdown prefix, matching the signup form.
// It is a drop-in for a plain `<input value onChange>`: callers keep storing a
// single string, while this component handles the dial-code prefix internally.
// Theme-aware (uses popover/accent tokens), so it works on the light/dark
// settings pages — unlike the signup form's always-dark bespoke version.
export function PhoneInput({
  value,
  onChange,
  id,
  autoComplete = "tel-national",
  placeholder = "Phone number",
  disabled,
  className,
}: PhoneInputProps) {
  const parsed = useMemo(() => parseStoredPhone(value), [value]);
  const [country, setCountry] = useState(parsed.country);

  // When the stored value carries an explicit dial code (e.g. the profile
  // loads or refreshes), mirror it into the dropdown. We intentionally don't
  // sync from an empty/local value, so the user's chosen country survives
  // clearing the number.
  useEffect(() => {
    if (!(value ?? "").trim().startsWith("+")) return;
    // Resync the dropdown to the stored value's country, but DON'T relabel when
    // the dial code is unchanged — otherwise an explicitly-picked country that
    // shares a dial code (e.g. Canada vs the US, both +1) would snap to the
    // first-listed one the moment a digit is typed.
    if (findPhoneCountry(country)?.dial !== findPhoneCountry(parsed.country)?.dial) {
      setCountry(parsed.country);
    }
  }, [value, parsed.country, country]);

  const meta = findPhoneCountry(country) ?? DEFAULT_PHONE_COUNTRY;
  const national = parsed.national;

  function handleCountry(next: string) {
    const nextMeta = findPhoneCountry(next) ?? DEFAULT_PHONE_COUNTRY;
    setCountry(next);
    onChange(combinePhone(next, national.slice(0, nextMeta.len)));
  }

  function handleNational(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, meta.len);
    onChange(combinePhone(country, digits));
  }

  return (
    <div
      className={cn(
        "flex items-stretch w-full rounded-lg border border-border bg-muted focus-within:ring-2 focus-within:ring-primary/20 transition",
        disabled && "opacity-60 cursor-not-allowed",
        className,
      )}
    >
      <Select value={country} onValueChange={handleCountry} disabled={disabled}>
        <SelectTrigger
          aria-label="Country code"
          className="w-auto h-auto shrink-0 border-0 shadow-none rounded-l-lg rounded-r-none pl-3 pr-2 py-2.5 bg-transparent text-sm font-medium text-foreground focus:ring-0 focus:outline-none disabled:opacity-100 gap-1.5 [&>span]:line-clamp-none [&>span]:flex [&>span]:items-center"
        >
          <SelectValue>
            <span className="flex items-center gap-1.5">
              <span>{meta.flag}</span>
              <span>{meta.dial}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-72 min-w-[16rem]">
          {COUNTRY_CODES.map((c) => (
            <SelectItem key={c.code} value={c.code}>
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1.5">
                  <span>{c.flag}</span>
                  <span className="font-medium">{c.dial}</span>
                </span>
                <span className="text-muted-foreground">{c.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="w-px bg-border my-2" aria-hidden="true" />
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={national}
        maxLength={meta.len}
        disabled={disabled}
        onChange={(e) => handleNational(e.target.value)}
        className="flex-1 min-w-0 bg-transparent border-none rounded-r-lg px-4 py-2.5 text-foreground text-sm focus:outline-none transition placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
      />
    </div>
  );
}
