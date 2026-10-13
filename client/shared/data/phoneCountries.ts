// Country dial codes for the phone-number fields (signup + profile settings).
// Distinct from `countries.ts`, which is a Europe-only ADDRESS dataset (postal
// rules, no dial codes). This list is global and carries the data the phone
// picker needs:
//  - `dial` international dial code, stored alongside the number (e.g. "+357").
//  - `flag` emoji, renders cross-platform from the regional-indicator pair.
//  - `len`  the national subscriber-number length (excluding the dial code);
//           for variable-length countries we use the typical upper bound.
//
// Cyprus (the home market) is the default and first in the list.

export interface PhoneCountry {
  code: string;
  dial: string;
  flag: string;
  name: string;
  len: number;
}

export const COUNTRY_CODES: PhoneCountry[] = [
  { code: "CY", dial: "+357", flag: "🇨🇾", name: "Cyprus", len: 8 },
  { code: "GR", dial: "+30", flag: "🇬🇷", name: "Greece", len: 10 },
  { code: "GB", dial: "+44", flag: "🇬🇧", name: "United Kingdom", len: 10 },
  { code: "US", dial: "+1", flag: "🇺🇸", name: "United States", len: 10 },
  { code: "AE", dial: "+971", flag: "🇦🇪", name: "United Arab Emirates", len: 9 },
  { code: "AU", dial: "+61", flag: "🇦🇺", name: "Australia", len: 9 },
  { code: "AT", dial: "+43", flag: "🇦🇹", name: "Austria", len: 13 },
  { code: "BE", dial: "+32", flag: "🇧🇪", name: "Belgium", len: 9 },
  { code: "BG", dial: "+359", flag: "🇧🇬", name: "Bulgaria", len: 9 },
  { code: "CA", dial: "+1", flag: "🇨🇦", name: "Canada", len: 10 },
  { code: "CN", dial: "+86", flag: "🇨🇳", name: "China", len: 11 },
  { code: "HR", dial: "+385", flag: "🇭🇷", name: "Croatia", len: 9 },
  { code: "CZ", dial: "+420", flag: "🇨🇿", name: "Czech Republic", len: 9 },
  { code: "DK", dial: "+45", flag: "🇩🇰", name: "Denmark", len: 8 },
  { code: "EG", dial: "+20", flag: "🇪🇬", name: "Egypt", len: 10 },
  { code: "EE", dial: "+372", flag: "🇪🇪", name: "Estonia", len: 8 },
  { code: "FI", dial: "+358", flag: "🇫🇮", name: "Finland", len: 10 },
  { code: "FR", dial: "+33", flag: "🇫🇷", name: "France", len: 9 },
  { code: "DE", dial: "+49", flag: "🇩🇪", name: "Germany", len: 11 },
  { code: "HK", dial: "+852", flag: "🇭🇰", name: "Hong Kong", len: 8 },
  { code: "HU", dial: "+36", flag: "🇭🇺", name: "Hungary", len: 9 },
  { code: "IS", dial: "+354", flag: "🇮🇸", name: "Iceland", len: 7 },
  { code: "IN", dial: "+91", flag: "🇮🇳", name: "India", len: 10 },
  { code: "ID", dial: "+62", flag: "🇮🇩", name: "Indonesia", len: 12 },
  { code: "IE", dial: "+353", flag: "🇮🇪", name: "Ireland", len: 9 },
  { code: "IL", dial: "+972", flag: "🇮🇱", name: "Israel", len: 9 },
  { code: "IT", dial: "+39", flag: "🇮🇹", name: "Italy", len: 10 },
  { code: "JP", dial: "+81", flag: "🇯🇵", name: "Japan", len: 11 },
  { code: "JO", dial: "+962", flag: "🇯🇴", name: "Jordan", len: 9 },
  { code: "LV", dial: "+371", flag: "🇱🇻", name: "Latvia", len: 8 },
  { code: "LB", dial: "+961", flag: "🇱🇧", name: "Lebanon", len: 8 },
  { code: "LT", dial: "+370", flag: "🇱🇹", name: "Lithuania", len: 8 },
  { code: "LU", dial: "+352", flag: "🇱🇺", name: "Luxembourg", len: 9 },
  { code: "MT", dial: "+356", flag: "🇲🇹", name: "Malta", len: 8 },
  { code: "MX", dial: "+52", flag: "🇲🇽", name: "Mexico", len: 10 },
  { code: "NL", dial: "+31", flag: "🇳🇱", name: "Netherlands", len: 9 },
  { code: "NZ", dial: "+64", flag: "🇳🇿", name: "New Zealand", len: 9 },
  { code: "NO", dial: "+47", flag: "🇳🇴", name: "Norway", len: 8 },
  { code: "PL", dial: "+48", flag: "🇵🇱", name: "Poland", len: 9 },
  { code: "PT", dial: "+351", flag: "🇵🇹", name: "Portugal", len: 9 },
  { code: "QA", dial: "+974", flag: "🇶🇦", name: "Qatar", len: 8 },
  { code: "RO", dial: "+40", flag: "🇷🇴", name: "Romania", len: 9 },
  { code: "RU", dial: "+7", flag: "🇷🇺", name: "Russia", len: 10 },
  { code: "SA", dial: "+966", flag: "🇸🇦", name: "Saudi Arabia", len: 9 },
  { code: "RS", dial: "+381", flag: "🇷🇸", name: "Serbia", len: 9 },
  { code: "SG", dial: "+65", flag: "🇸🇬", name: "Singapore", len: 8 },
  { code: "SK", dial: "+421", flag: "🇸🇰", name: "Slovakia", len: 9 },
  { code: "SI", dial: "+386", flag: "🇸🇮", name: "Slovenia", len: 8 },
  { code: "ZA", dial: "+27", flag: "🇿🇦", name: "South Africa", len: 9 },
  { code: "KR", dial: "+82", flag: "🇰🇷", name: "South Korea", len: 10 },
  { code: "ES", dial: "+34", flag: "🇪🇸", name: "Spain", len: 9 },
  { code: "SE", dial: "+46", flag: "🇸🇪", name: "Sweden", len: 9 },
  { code: "CH", dial: "+41", flag: "🇨🇭", name: "Switzerland", len: 9 },
  { code: "TR", dial: "+90", flag: "🇹🇷", name: "Turkey", len: 10 },
  { code: "UA", dial: "+380", flag: "🇺🇦", name: "Ukraine", len: 9 },
];

// Cyprus — used when a stored value has no recognizable dial code.
export const DEFAULT_PHONE_COUNTRY: PhoneCountry = COUNTRY_CODES[0];

export function findPhoneCountry(code: string | undefined | null): PhoneCountry | undefined {
  return code ? COUNTRY_CODES.find((c) => c.code === code) : undefined;
}

// Splits a stored phone value into the picker selection + national digits.
// Stored values look like "+357 99123456" (signup/settings format). We match
// the LONGEST dial-code prefix so e.g. "+357…" resolves to Cyprus, not a
// shorter coincidental code. Legacy free-text values without a "+" keep their
// digits as the national number under the default country (Cyprus), so we
// never silently relabel an existing number.
export function parseStoredPhone(stored: string | undefined | null): {
  country: string;
  national: string;
} {
  const raw = (stored ?? "").trim();
  if (!raw) return { country: DEFAULT_PHONE_COUNTRY.code, national: "" };

  // Treat a leading "00" international trunk prefix the same as "+", so e.g.
  // "0035799123456" resolves to Cyprus rather than being mistaken for a raw
  // national number.
  const normalized = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
  const digits = normalized.replace(/\D/g, "");
  if (normalized.startsWith("+")) {
    let best: PhoneCountry | undefined;
    let bestLen = 0;
    for (const c of COUNTRY_CODES) {
      const dialDigits = c.dial.replace(/\D/g, "");
      if (digits.startsWith(dialDigits) && dialDigits.length > bestLen) {
        best = c;
        bestLen = dialDigits.length;
      }
    }
    if (best) return { country: best.code, national: digits.slice(bestLen) };
    // "+" with an unrecognized dial code: keep the digits, default the picker.
    return { country: DEFAULT_PHONE_COUNTRY.code, national: digits };
  }
  return { country: DEFAULT_PHONE_COUNTRY.code, national: digits };
}

// Joins a picker selection + national number into the stored format. Strips
// any stray non-digits from the national part and returns "" when empty, so we
// never persist a bare dial code with no number behind it.
export function combinePhone(country: string, national: string): string {
  const n = (national ?? "").replace(/\D/g, "");
  if (!n) return "";
  const dial = findPhoneCountry(country)?.dial ?? DEFAULT_PHONE_COUNTRY.dial;
  return `${dial} ${n}`;
}
