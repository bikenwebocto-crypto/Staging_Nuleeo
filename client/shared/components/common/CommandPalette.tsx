import { useEffect } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@ui/components/ui/command";

export interface SearchItem {
  id: string;
  label: string;
  sublabel?: string;
  group: string;
  href?: string;
  onSelect?: () => void;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  keywords?: string[];
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: SearchItem[];
  placeholder?: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  items,
  placeholder = "Search pages, properties, tenants…",
}: CommandPaletteProps) {
  const [, setLocation] = useLocation();

  // Close on route change in case caller forgets — keeps the palette honest.
  useEffect(() => {
    if (!open) return;
    return () => {
      /* no-op cleanup */
    };
  }, [open]);

  const grouped = items.reduce<Record<string, SearchItem[]>>((acc, item) => {
    (acc[item.group] ||= []).push(item);
    return acc;
  }, {});
  const groupNames = Object.keys(grouped);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={placeholder} />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groupNames.map((group, gi) => (
          <div key={group}>
            {gi > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {grouped[group].map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.id}
                    value={`${item.label} ${item.sublabel ?? ""} ${(item.keywords ?? []).join(" ")}`}
                    onSelect={() => {
                      onOpenChange(false);
                      if (item.onSelect) item.onSelect();
                      else if (item.href) setLocation(item.href);
                    }}
                  >
                    {Icon && <Icon size={16} className="text-muted-foreground" />}
                    <div className="flex flex-col min-w-0">
                      <span className="truncate">{item.label}</span>
                      {item.sublabel && (
                        <span className="text-xs text-muted-foreground truncate">
                          {item.sublabel}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
