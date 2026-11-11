"use client";

import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";

const loadPalette = () => import("@/components/shell/command-palette");
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })));

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
  );
}

/**
 * Top-bar search button + the global shortcuts (Ctrl+K / Cmd+K anywhere,
 * "/" when not typing). The palette itself is a separate chunk fetched on
 * first use (or when the button is hovered or focused), so it adds nothing
 * to any page's first-load JavaScript.
 *
 * A code editor that claims Ctrl+K for itself (Monaco's chord prefix)
 * prevents the default first; the palette then stays shut, as it should.
 */
export function PaletteLauncher() {
  const [requested, setRequested] = useState(false);
  const [open, setOpen] = useState(false);
  const [mac, setMac] = useState(false);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);

  const show = useCallback(() => {
    setRequested(true);
    setOpen(true);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setRequested(true);
        setOpen((v) => !v);
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        // Never stack on top of another open modal.
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault();
        show();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [show]);

  const preload = useCallback(() => {
    void loadPalette();
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={show}
        onPointerEnter={preload}
        onFocus={preload}
        aria-label="Search problems and pages"
        aria-keyshortcuts="Control+K Meta+K"
        aria-haspopup="dialog"
        className="flex h-10 min-w-10 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-2.5 text-sm text-text-secondary transition-colors hover:border-primary/40 hover:text-text md:w-64 md:justify-start md:px-3"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden />
        <span className="hidden flex-1 text-left md:inline" aria-hidden>
          Search…
        </span>
        <kbd aria-hidden className="hidden rounded border border-border bg-elevated px-1.5 font-sans text-[0.7rem] md:inline">
          {mac ? "⌘ K" : "Ctrl K"}
        </kbd>
      </button>
      {requested && (
        <Suspense fallback={null}>
          <CommandPalette open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  );
}
