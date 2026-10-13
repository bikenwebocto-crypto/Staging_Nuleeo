import { useEffect } from "react";
import { useLocation } from "wouter";

export function ThemeProvider() {
  const [location] = useLocation();

  useEffect(() => {
    const applyTheme = () => {
      const root = document.documentElement;
      const theme = localStorage.getItem("theme");
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

      if (theme === "light") {
        root.classList.remove("dark");
      } else if (theme === "dark" || (!theme && systemDark)) {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    };

    applyTheme();

    // Listen for custom theme change events (within the same window)
    window.addEventListener("theme-changed", applyTheme);

    // Listen for storage events (across different windows/iframes)
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "theme") {
        applyTheme();
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("theme-changed", applyTheme);
      window.removeEventListener("storage", handleStorage);
    };
  }, [location]);

  return null;
}
