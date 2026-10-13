import { useState } from "react";
import { format, isValid, parse } from "date-fns";
import { Calendar } from "@ui/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/ui/popover";
import { cn } from "@ui/lib/utils";

const VALUE_FORMAT = "yyyy-MM-dd";

interface DateFieldProps {
  /** ISO date as "yyyy-MM-dd", or "" when nothing is selected. */
  value: string;
  /** Receives the new ISO "yyyy-MM-dd" string ("" if cleared). */
  onChange: (value: string) => void;
  /** Shown on the trigger when no date is selected. */
  placeholder?: string;
  /** Classes for the trigger button — pass the same ones the old <input> used. */
  className?: string;
  /** Which edge of the field the calendar lines up with. */
  align?: "start" | "center" | "end";
  disabled?: boolean;
}

/**
 * Branded date picker: an in-app calendar in a Radix popover, replacing
 * <input type="date">. The native control was dropped because iOS/iPadOS draws
 * its own calendar wherever it pleases — on a wide (tablet) viewport it floats
 * far to the right of a centred modal, detached from the field (the "overflow"
 * the date fields showed). This popover is anchored to its trigger and flips to
 * stay on-screen, and renders in a portal at z-[70] so it sits above the
 * z-[60] ResponsiveDrawer instead of being clipped by it.
 *
 * The value contract is identical to the input it replaces ("yyyy-MM-dd" | ""),
 * so callers keep their existing string state and submit logic unchanged.
 */
export function DateField({
  value,
  onChange,
  placeholder = "Select a date",
  className,
  align = "start",
  disabled,
}: DateFieldProps) {
  const [open, setOpen] = useState(false);

  const parsed = value ? parse(value, VALUE_FORMAT, new Date()) : undefined;
  const selected = parsed && isValid(parsed) ? parsed : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "text-left whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-60",
            !selected && "text-muted-foreground/70",
            className,
          )}
        >
          {selected ? format(selected, "d MMM yyyy") : placeholder}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="z-[70] w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            onChange(date ? format(date, VALUE_FORMAT) : "");
            setOpen(false);
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
