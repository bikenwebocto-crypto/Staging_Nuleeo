import { ComponentType, useMemo } from "react";
import { SelectField } from "./SelectField";

interface CountSelectProps {
  /** Stored count as a string ("" when unset). */
  value: string;
  onChange: (value: string) => void;
  /** Inclusive bounds. Defaults to 0–10 (covers bedrooms / bathrooms). */
  min?: number;
  max?: number;
  /** Leading icon (e.g. DoorOpen for bedrooms, Home for bathrooms). */
  icon?: ComponentType<{ size?: number; className?: string }>;
  testId?: string;
  placeholder?: string;
  /** Override the <select> classes (defaults to the owner-form input look). */
  className?: string;
  /** Omit the empty first option — for fields that always hold a value. */
  hidePlaceholder?: boolean;
}

/**
 * Small integer-count picker (a styled native <select>) — bedrooms, bathrooms,
 * etc. Ascending 0..max, so it constrains entry to whole, in-range counts
 * instead of a free-text number field.
 */
export function CountSelect({
  value,
  onChange,
  min = 0,
  max = 10,
  icon,
  testId,
  placeholder = "Select",
  className,
  hidePlaceholder = false,
}: CountSelectProps) {
  const options = useMemo(() => {
    const out: { value: string; label: number }[] = [];
    for (let n = min; n <= max; n++) out.push({ value: String(n), label: n });
    return out;
  }, [min, max]);

  return (
    <SelectField
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      icon={icon}
      testId={testId}
      className={className}
      hidePlaceholder={hidePlaceholder}
    />
  );
}
