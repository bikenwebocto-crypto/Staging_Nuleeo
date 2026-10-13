import { useLocation } from "wouter";
import { cn } from "@ui/lib/utils";
import { motion } from "framer-motion";

// One nav item. Each app builds its own items[] (since menu shape is per-app)
// and hands them to <BottomNav items={...} />. The component itself stays
// agnostic to roles and per-app menu data.
//
// `path` is the URL the item navigates to. The optional sentinel label
// "Ask Olio" wires through onAskOlioClick instead of routing.
export interface BottomNavItem {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  path: string;
  // Optional unread/notification count. When > 0 a small badge renders on the
  // item (e.g. unread messages). Omitted/0 → no badge.
  badge?: number;
}

interface BottomNavProps {
  items: BottomNavItem[];
  onAskOlioClick?: () => void;
  // Optional override for the framer-motion layoutId; lets two simultaneously
  // mounted variants (e.g. owner + tenant in a transition) animate independently.
  layoutId?: string;
}

export function BottomNav({
  items,
  onAskOlioClick,
  layoutId = "bottomnav-highlight",
}: BottomNavProps) {
  const [location, setLocation] = useLocation();

  return (
    <div className="md:hidden fixed bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] left-4 right-4 bg-card/80 backdrop-blur-xl shadow-2xl rounded-full border border-border/50 py-1.5 px-2 z-50 max-w-sm mx-auto">
      <div className="flex justify-between items-center px-2">
        {items.map((item) => {
          const isActive = location === item.path;
          return (
            <button
              key={item.label}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              onClick={() => {
                if (item.label === "Ask Olio" && onAskOlioClick) {
                  onAskOlioClick();
                } else {
                  setLocation(item.path);
                }
              }}
              className={cn(
                "relative flex items-center justify-center h-[42px] rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? "px-5" : "w-[42px] group",
              )}
            >
              {isActive && (
                <motion.div
                  layoutId={layoutId}
                  className="absolute inset-0 bg-(--brand-accent-subtle) ring-1 ring-inset ring-(--brand-accent-border) rounded-full shadow-sm"
                  transition={{ type: "spring", stiffness: 350, damping: 30 }}
                />
              )}
              <item.icon
                size={20}
                strokeWidth={isActive ? 2 : 1.5}
                className={cn(
                  "relative z-10 transition-colors duration-300",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground group-hover:text-foreground",
                )}
              />
              {(item.badge ?? 0) > 0 && (
                <span className="absolute top-0 right-0 z-20 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-4 text-center shadow">
                  {item.badge! > 9 ? "9+" : item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
