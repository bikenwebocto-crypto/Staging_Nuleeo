import { useEffect, useState } from "react";
import { cn } from "@ui/lib/utils";

type LogoVariant = "wordmark" | "symbol";
type LogoColor = "auto" | "dark" | "white";

interface LogoProps {
  variant?: LogoVariant;
  color?: LogoColor;
  className?: string;
  alt?: string;
}

const sources: Record<LogoVariant, Record<"dark" | "white", string>> = {
  wordmark: {
    dark: "/logo-wordmark.png",
    white: "/logo-wordmark-white.png",
  },
  symbol: {
    dark: "/logo-symbol.png",
    white: "/logo-symbol-white.png",
  },
};

// Single-img theme swap. Two imgs with `dark:hidden` would briefly co-exist
// in the flex line during theme transitions, shifting layout — render one.
function useIsDark() {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const update = () => setIsDark(document.documentElement.classList.contains("dark"));
    window.addEventListener("theme-changed", update);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    return () => {
      window.removeEventListener("theme-changed", update);
      mq.removeEventListener("change", update);
    };
  }, []);
  return isDark;
}

export function Logo({ variant = "wordmark", color = "auto", className, alt = "Olio" }: LogoProps) {
  const isDark = useIsDark();
  const resolved = color === "auto" ? (isDark ? "white" : "dark") : color;
  return (
    <img
      src={sources[variant][resolved]}
      alt={alt}
      className={cn("select-none", className)}
      draggable={false}
    />
  );
}
