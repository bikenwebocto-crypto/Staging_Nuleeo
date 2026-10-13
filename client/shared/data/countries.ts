// European countries with the data the address form needs:
//  - `code`  ISO-3166-1 alpha-2 (lowercase) — feeds Nominatim `countrycodes`
//            for the address + city search, so suggestions stay in-country.
//  - `flag`  emoji, shown in the country picker.
//  - `postal` accepted format for the country's postal/zip code. `regex` is
//            matched against the trimmed value (case-insensitive); `example`
//            is shown to the user when it doesn't match. Omit `postal` for a
//            country with no fixed format → never blocks.
//
// Postal patterns follow Google's libaddressinput dataset. Cyprus (the home
// market) is included and is the form default.

export interface PostalRule {
  regex: RegExp;
  example: string;
}

export interface CountryInfo {
  code: string;
  name: string;
  flag: string;
  postal?: PostalRule;
}

// ISO2 used when the chosen country isn't in the list (legacy/free-text data):
// fall back to Cyprus so the in-country search still has a sensible scope.
export const DEFAULT_COUNTRY_CODE = "cy";

export const EUROPEAN_COUNTRIES: CountryInfo[] = [
  { code: "al", name: "Albania", flag: "🇦🇱", postal: { regex: /^\d{4}$/, example: "1001" } },
  { code: "ad", name: "Andorra", flag: "🇦🇩", postal: { regex: /^AD\d{3}$/i, example: "AD100" } },
  { code: "at", name: "Austria", flag: "🇦🇹", postal: { regex: /^\d{4}$/, example: "1010" } },
  { code: "by", name: "Belarus", flag: "🇧🇾", postal: { regex: /^\d{6}$/, example: "220004" } },
  { code: "be", name: "Belgium", flag: "🇧🇪", postal: { regex: /^\d{4}$/, example: "1000" } },
  {
    code: "ba",
    name: "Bosnia and Herzegovina",
    flag: "🇧🇦",
    postal: { regex: /^\d{5}$/, example: "71000" },
  },
  { code: "bg", name: "Bulgaria", flag: "🇧🇬", postal: { regex: /^\d{4}$/, example: "1000" } },
  { code: "hr", name: "Croatia", flag: "🇭🇷", postal: { regex: /^\d{5}$/, example: "10000" } },
  { code: "cy", name: "Cyprus", flag: "🇨🇾", postal: { regex: /^\d{4}$/, example: "1010" } },
  {
    code: "cz",
    name: "Czechia",
    flag: "🇨🇿",
    postal: { regex: /^\d{3} ?\d{2}$/, example: "100 00" },
  },
  { code: "dk", name: "Denmark", flag: "🇩🇰", postal: { regex: /^\d{4}$/, example: "1050" } },
  { code: "ee", name: "Estonia", flag: "🇪🇪", postal: { regex: /^\d{5}$/, example: "10111" } },
  { code: "fi", name: "Finland", flag: "🇫🇮", postal: { regex: /^\d{5}$/, example: "00100" } },
  { code: "fr", name: "France", flag: "🇫🇷", postal: { regex: /^\d{5}$/, example: "75008" } },
  { code: "de", name: "Germany", flag: "🇩🇪", postal: { regex: /^\d{5}$/, example: "10115" } },
  {
    code: "gr",
    name: "Greece",
    flag: "🇬🇷",
    postal: { regex: /^\d{3} ?\d{2}$/, example: "104 31" },
  },
  { code: "hu", name: "Hungary", flag: "🇭🇺", postal: { regex: /^\d{4}$/, example: "1011" } },
  { code: "is", name: "Iceland", flag: "🇮🇸", postal: { regex: /^\d{3}$/, example: "101" } },
  {
    code: "ie",
    name: "Ireland",
    flag: "🇮🇪",
    postal: { regex: /^[A-Za-z0-9]{3} ?[A-Za-z0-9]{4}$/, example: "D02 AF30" },
  },
  { code: "it", name: "Italy", flag: "🇮🇹", postal: { regex: /^\d{5}$/, example: "00100" } },
  { code: "xk", name: "Kosovo", flag: "🇽🇰", postal: { regex: /^\d{5}$/, example: "10000" } },
  {
    code: "lv",
    name: "Latvia",
    flag: "🇱🇻",
    postal: { regex: /^(LV-)?\d{4}$/i, example: "LV-1010" },
  },
  { code: "li", name: "Liechtenstein", flag: "🇱🇮", postal: { regex: /^\d{4}$/, example: "9490" } },
  {
    code: "lt",
    name: "Lithuania",
    flag: "🇱🇹",
    postal: { regex: /^(LT-)?\d{5}$/i, example: "LT-01100" },
  },
  {
    code: "lu",
    name: "Luxembourg",
    flag: "🇱🇺",
    postal: { regex: /^(L-)?\d{4}$/i, example: "1009" },
  },
  {
    code: "mt",
    name: "Malta",
    flag: "🇲🇹",
    postal: { regex: /^[A-Za-z]{3} ?\d{4}$/, example: "VLT 1117" },
  },
  {
    code: "md",
    name: "Moldova",
    flag: "🇲🇩",
    postal: { regex: /^(MD-?)?\d{4}$/i, example: "MD-2001" },
  },
  { code: "mc", name: "Monaco", flag: "🇲🇨", postal: { regex: /^980\d{2}$/, example: "98000" } },
  { code: "me", name: "Montenegro", flag: "🇲🇪", postal: { regex: /^\d{5}$/, example: "81000" } },
  {
    code: "nl",
    name: "Netherlands",
    flag: "🇳🇱",
    postal: { regex: /^\d{4} ?[A-Za-z]{2}$/, example: "1011 AB" },
  },
  {
    code: "mk",
    name: "North Macedonia",
    flag: "🇲🇰",
    postal: { regex: /^\d{4}$/, example: "1000" },
  },
  { code: "no", name: "Norway", flag: "🇳🇴", postal: { regex: /^\d{4}$/, example: "0010" } },
  { code: "pl", name: "Poland", flag: "🇵🇱", postal: { regex: /^\d{2}-\d{3}$/, example: "00-001" } },
  {
    code: "pt",
    name: "Portugal",
    flag: "🇵🇹",
    postal: { regex: /^\d{4}-\d{3}$/, example: "1000-001" },
  },
  { code: "ro", name: "Romania", flag: "🇷🇴", postal: { regex: /^\d{6}$/, example: "010011" } },
  { code: "sm", name: "San Marino", flag: "🇸🇲", postal: { regex: /^4789\d$/, example: "47890" } },
  { code: "rs", name: "Serbia", flag: "🇷🇸", postal: { regex: /^\d{5,6}$/, example: "11000" } },
  {
    code: "sk",
    name: "Slovakia",
    flag: "🇸🇰",
    postal: { regex: /^\d{3} ?\d{2}$/, example: "811 01" },
  },
  { code: "si", name: "Slovenia", flag: "🇸🇮", postal: { regex: /^\d{4}$/, example: "1000" } },
  { code: "es", name: "Spain", flag: "🇪🇸", postal: { regex: /^\d{5}$/, example: "28001" } },
  {
    code: "se",
    name: "Sweden",
    flag: "🇸🇪",
    postal: { regex: /^\d{3} ?\d{2}$/, example: "114 51" },
  },
  { code: "ch", name: "Switzerland", flag: "🇨🇭", postal: { regex: /^\d{4}$/, example: "8001" } },
  { code: "ua", name: "Ukraine", flag: "🇺🇦", postal: { regex: /^\d{5}$/, example: "01001" } },
  {
    code: "gb",
    name: "United Kingdom",
    flag: "🇬🇧",
    postal: { regex: /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/, example: "SW1A 1AA" },
  },
  { code: "va", name: "Vatican City", flag: "🇻🇦", postal: { regex: /^00120$/, example: "00120" } },
];

const BY_NAME = new Map(EUROPEAN_COUNTRIES.map((c) => [c.name.toLowerCase(), c]));
const BY_CODE = new Map(EUROPEAN_COUNTRIES.map((c) => [c.code, c]));

export function findCountryByName(name: string | undefined | null): CountryInfo | undefined {
  return name ? BY_NAME.get(name.trim().toLowerCase()) : undefined;
}

export function findCountryByCode(code: string | undefined | null): CountryInfo | undefined {
  return code ? BY_CODE.get(code.trim().toLowerCase()) : undefined;
}

// ISO2 for the chosen country name, falling back to Cyprus for unknown/legacy
// free-text values so the in-country search still has a scope.
export function getCountryCode(name: string | undefined | null): string {
  return findCountryByName(name)?.code ?? DEFAULT_COUNTRY_CODE;
}

export interface PostalValidation {
  valid: boolean;
  message?: string;
}

// Validates a postal code against the selected country's format. Unknown
// countries (or those without a fixed format) always pass — we never block on
// data we can't authoritatively check. An empty value is treated as valid here;
// "required" is enforced separately by the form's presence check.
export function validatePostalCode(
  countryName: string | undefined | null,
  value: string,
): PostalValidation {
  const trimmed = value.trim();
  if (!trimmed) return { valid: true };
  const country = findCountryByName(countryName);
  if (!country?.postal) return { valid: true };
  if (country.postal.regex.test(trimmed)) return { valid: true };
  return {
    valid: false,
    message: `Enter a valid ${country.name} postal code (e.g. ${country.postal.example}).`,
  };
}
