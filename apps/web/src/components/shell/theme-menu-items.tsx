"use client";

import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { THEME_STORAGE_KEY } from "@/lib/theme-script";

type Theme = "light" | "dark" | "system";

const OPTIONS: ReadonlyArray<{ value: Theme; label: string; Icon: typeof Sun }> = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "system", label: "System theme", Icon: Monitor },
];

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * The colour theme as menu radio items, for the account menu on narrow
 * screens where the top bar has no room for the theme switch. Same storage
 * key and semantics as components/theme/theme-toggle.tsx.
 */
export function ThemeMenuItems() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not persisted; still applied for this page view.
    }
    const dark = next === "dark" || (next === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  return (
    <div role="group" aria-label="Color theme">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="menuitemradio"
          aria-checked={theme === value}
          onClick={() => choose(value)}
          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text transition-colors hover:bg-primary-subtle"
        >
          <Icon className="h-4 w-4" aria-hidden />
          <span className="flex-1">{label}</span>
          {theme === value && <Check className="h-4 w-4 text-primary" aria-hidden />}
        </button>
      ))}
    </div>
  );
}
