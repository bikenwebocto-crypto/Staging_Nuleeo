import { ComponentType, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@ui/lib/utils";

export interface SelectOption {
  value: string;
  label: ReactNode;
}

interface SelectFieldProps {
  /** Stored value as a string ("" when unset). */
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Leading icon (e.g. Calendar, DoorOpen). Omit for no icon. */
  icon?: ComponentType<{ size?: number; className?: string }>;
  testId?: string;
  /** Override the <select> classes (defaults to the owner-form input look). */
  className?: string;
  /** Omit the empty first option — for fields that always hold a value. */
  hidePlaceholder?: boolean;
}

const DEFAULT_SELECT =
  "w-full appearance-none bg-background border-none rounded-xl pr-9 py-2.5 text-foreground font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 transition";

/**
 * A native <select> styled like the app's form inputs: an optional leading
 * icon, a trailing chevron, and a first empty "placeholder" option. Native
 * selects give type-to-jump on desktop and the OS wheel on mobile, which beats
 * a custom list for long option sets (years) and reads cleanly for short ones
 * (room counts). Used via the YearSelect / CountSelect wrappers.
 */
export function SelectField({
  value,
  onChange,
  options,
  placeholder = "Select",
  icon: Icon,
  testId,
  className,
  hidePlaceholder = false,
}: SelectFieldProps) {
  return (
    <div className="relative">
      {Icon && (
        <Icon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
        />
      )}
      <select
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          className ?? DEFAULT_SELECT,
          Icon && "pl-10",
          !value && "text-muted-foreground/70",
        )}
      >
        {!hidePlaceholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
      />
    </div>
  );
}
