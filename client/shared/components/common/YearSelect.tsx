import { useMemo } from "react";
import { Calendar } from "lucide-react";
import { SelectField } from "./SelectField";

interface YearSelectProps {
  /** Stored year as a string ("" when unset, e.g. "1993"). */
  value: string;
  onChange: (year: string) => void;
  /** Inclusive year bounds — the dropdown only offers valid years, so no
   *  free-text entry and no "out of range" error is possible. */
  min: number;
  max: number;
  testId?: string;
  placeholder?: string;
  /** Hide the leading calendar icon (and its left padding). */
  noIcon?: boolean;
  /** Override the <select> classes (defaults to the owner-form input look). */
  className?: string;
}

/**
 * Year picker (a styled native <select>). Replaces the old free-text "YYYY"
 * field: the list is constrained to the allowed range — descending, so a recent
 * year sits at the top instead of after two centuries of scrolling — which
 * makes an out-of-range value impossible and drops the inline range hint.
 */
export function YearSelect({
  value,
  onChange,
  min,
  max,
  testId,
  placeholder = "Select year",
  noIcon = false,
  className,
}: YearSelectProps) {
  const options = useMemo(() => {
    const out: { value: string; label: number }[] = [];
    for (let y = max; y >= min; y--) out.push({ value: String(y), label: y });
    return out;
  }, [min, max]);

  return (
    <SelectField
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      icon={noIcon ? undefined : Calendar}
      testId={testId}
      className={className}
    />
  );
}
