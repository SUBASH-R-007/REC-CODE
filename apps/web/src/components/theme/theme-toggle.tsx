"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@recx/design";
import { THEME_STORAGE_KEY } from "@/lib/theme-script";

type Theme = "light" | "dark" | "system";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    // Storage blocked (privacy mode): behave as "system".
    return "system";
  }
}

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Light / dark / system switch. The pre-paint script in
 * src/lib/theme-script.ts applies the stored choice before hydration; this
 * control only changes it (same storage key).
 */
export function ThemeToggle({ compact }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  // While following the system, track OS-level switches live.
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  function update(next: Theme) {
    setTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not persisted; still applied for this page view.
    }
    applyTheme(next);
  }

  const options: Array<{ value: Theme; icon: React.ReactNode; label: string }> = [
    { value: "light", icon: <Sun className="h-4 w-4" aria-hidden />, label: "Light theme" },
    { value: "dark", icon: <Moon className="h-4 w-4" aria-hidden />, label: "Dark theme" },
    { value: "system", icon: <Monitor className="h-4 w-4" aria-hidden />, label: "System theme" },
  ];

  return (
    <div
      role="group"
      aria-label="Color theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5",
        compact && "scale-90",
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => update(opt.value)}
          aria-label={opt.label}
          aria-pressed={theme === opt.value}
          title={opt.label}
          className={cn(
            "rounded-md p-1.5 transition-colors",
            theme === opt.value ? "bg-primary-subtle text-primary" : "text-muted hover:text-text",
          )}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}
