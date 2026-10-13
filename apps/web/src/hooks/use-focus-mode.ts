"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { isFocusShortcut } from "@/components/workspace/layout";

/**
 * Make everything outside `root` inert (and keep the page from scrolling
 * behind it). Live regions are left alone so toasts still announce, and
 * <dialog>s are never made inert. Returns the undo.
 */
function isolate(root: HTMLElement): () => void {
  const made: HTMLElement[] = [];
  let node: HTMLElement = root;
  while (node.parentElement && node !== document.body) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue;
      if (sibling.matches("script, style, link, template, dialog")) continue;
      if (sibling.matches("[aria-live]") || sibling.querySelector("[aria-live]")) continue;
      sibling.inert = true;
      made.push(sibling);
    }
    node = parent;
  }
  const overflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  return () => {
    for (const sibling of made) sibling.inert = false;
    document.body.style.overflow = overflow;
  };
}

/** The app-wide shortcuts that open shell dialogs (the search palette). */
function opensShellDialog(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

/**
 * Focus mode for the workspace: the root element covers the viewport (the
 * caller styles it from `on`), the statement and shell chrome are hidden,
 * and everything outside the root becomes `inert` — so Tab never wanders
 * into the covered app header, and screen readers see only the workspace.
 *
 *   Ctrl+Shift+F   toggles (captured before the editor sees it);
 *   Esc            exits — except inside the editor, where Esc closes the
 *                  editor's own widgets and starts "Esc then Tab" (the
 *                  visible button and the shortcut always work).
 * Anything that opens a dialog outside the workspace (the Ctrl+K search
 * palette lives in the covered header) ends focus mode first, so a modal
 * can never open inside an inert region and trap the keyboard.
 */
export function useFocusMode(root: React.RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);
  const toggle = useCallback(() => setOn((v) => !v), []);
  const exit = useCallback(() => setOn(false), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFocusShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        setOn((v) => !v);
        return;
      }
      // Leave synchronously (the inert attributes go in this same commit),
      // before the shell's own listener opens its dialog.
      if (opensShellDialog(e) && document.querySelector("[data-focus-mode]")) flushSync(() => setOn(false));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    if (!on) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("[data-editor-root], [role='dialog'], dialog")) return;
      if (document.querySelector("dialog[open]")) return;
      setOn(false);
    };
    // Bubble phase: the console and dialogs handle their own Escape first.
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [on]);

  // Layout effect: applied and undone synchronously with the commit.
  useLayoutEffect(() => {
    const el = root.current;
    if (!on || !el) return;
    const undo = isolate(el);
    // Any other dialog opening outside the workspace also ends focus mode.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (target instanceof HTMLDialogElement && target.open && !el.contains(target)) {
          flushSync(() => setOn(false));
          if (!target.contains(document.activeElement)) target.focus();
          return;
        }
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
    return () => {
      observer.disconnect();
      undo();
    };
  }, [on, root]);

  return { on, toggle, exit };
}
