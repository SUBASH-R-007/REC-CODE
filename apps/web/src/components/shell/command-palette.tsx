"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { History, Loader2, NotebookPen, Search, X } from "lucide-react";
import { DifficultyBadge, SolveStatus, cn } from "@recx/design";
import { allNavItems, type NavIconKey } from "@/components/shell/nav";
import { NavIcon } from "@/components/shell/nav-icon";
import { parseSearchResponse, type SearchResult } from "@/components/shell/search-result";

/**
 * Ctrl/Cmd+K palette: problem search (/api/search, PUBLISHED titles via the
 * pg_trgm index) plus navigation commands. Loaded lazily by PaletteLauncher
 * the first time it opens, so none of this is in any route's first load.
 *
 * Pattern: a native modal <dialog> (focus trap, Esc, focus restoration)
 * holding an ARIA 1.2 combobox whose listbox is driven by
 * aria-activedescendant — focus never leaves the input.
 */

const RECENT_KEY = "recx-palette-recent";
const MAX_RECENT = 5;
const DEBOUNCE_MS = 200;
const MIN_SERVER_QUERY = 2;

type ItemIcon = NavIconKey | "note" | "recent";

interface PaletteItem {
  key: string;
  label: string;
  sublabel?: string;
  href: string;
  icon?: ItemIcon;
  problem?: SearchResult;
}

interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}

interface RecentEntry {
  href: string;
  label: string;
}

const ACTIONS: readonly PaletteItem[] = [
  { key: "action-new-note", label: "New note", sublabel: "Write a private Markdown note", href: "/notes/new", icon: "note" },
];

const isInternalHref = (href: unknown): href is string =>
  typeof href === "string" && href.startsWith("/") && !href.startsWith("//") && !href.includes("\\");

function readRecents(): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is RecentEntry => {
        if (typeof e !== "object" || e === null) return false;
        const r = e as Record<string, unknown>;
        return isInternalHref(r.href) && typeof r.label === "string" && r.label.length <= 200;
      })
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function saveRecent(entry: RecentEntry) {
  try {
    const next = [entry, ...readRecents().filter((r) => r.href !== entry.href)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode): recents are a convenience.
  }
}

function ItemGlyph({ icon }: { icon?: ItemIcon }) {
  if (icon === "note") return <NotebookPen className="h-4 w-4" aria-hidden />;
  if (icon === "recent" || !icon) return <History className="h-4 w-4" aria-hidden />;
  return <NavIcon name={icon} className="h-4 w-4" />;
}

const optionId = (index: number) => `recx-palette-option-${index}`;

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchedFor, setSearchedFor] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(0);

  const trimmed = query.trim();

  // Sync with the native dialog; reset each time it opens.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery("");
      setResults([]);
      setSearchedFor("");
      setFailed(false);
      setSelected(0);
      setRecents(readRecents());
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Debounced problem search.
  useEffect(() => {
    if (!open || trimmed.length < MIN_SERVER_QUERY) {
      setResults([]);
      setSearchedFor("");
      setLoading(false);
      setFailed(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
        cache: "no-store",
        headers: { accept: "application/json" },
      })
        .then((res) => {
          if (!res.ok) throw new Error(`search failed (${res.status})`);
          return res.json() as Promise<unknown>;
        })
        .then((data) => {
          setResults(parseSearchResponse(data));
          setSearchedFor(trimmed);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setResults([]);
          setFailed(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, trimmed]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const pages: PaletteItem[] = allNavItems().map((n) => ({
      key: `page-${n.href}`,
      label: n.label,
      sublabel: n.description,
      href: n.href,
      icon: n.icon,
    }));

    if (trimmed.length === 0) {
      const list: PaletteGroup[] = [];
      if (recents.length > 0) {
        list.push({
          id: "recent",
          label: "Recent",
          items: recents.map((r) => ({ key: `recent-${r.href}`, label: r.label, href: r.href, icon: "recent" })),
        });
      }
      list.push({ id: "actions", label: "Actions", items: [...ACTIONS] });
      list.push({ id: "pages", label: "Go to", items: pages });
      return list;
    }

    const needle = trimmed.toLowerCase();
    const list: PaletteGroup[] = [];
    if (results.length > 0) {
      list.push({
        id: "problems",
        label: "Problems",
        items: results.map((p) => ({
          key: `problem-${p.slug}`,
          label: p.title,
          href: `/problems/${p.slug}`,
          problem: p,
        })),
      });
    }
    const matches = [...ACTIONS, ...pages].filter(
      (p) => p.label.toLowerCase().includes(needle) || (p.sublabel ?? "").toLowerCase().includes(needle),
    );
    if (matches.length > 0) list.push({ id: "pages", label: "Pages and actions", items: matches });
    return list;
  }, [trimmed, recents, results]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const g of groups) {
      out.push(acc);
      acc += g.items.length;
    }
    return out;
  }, [groups]);

  const sel = flat.length === 0 ? -1 : Math.min(selected, flat.length - 1);

  useEffect(() => {
    setSelected(0);
  }, [trimmed, results]);

  useEffect(() => {
    if (sel >= 0) document.getElementById(optionId(sel))?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const go = useCallback(
    (item: PaletteItem) => {
      saveRecent({ href: item.href, label: item.problem ? `${item.problem.displayCode} · ${item.label}` : item.label });
      onOpenChange(false);
      router.push(item.href as never);
    },
    [onOpenChange, router],
  );

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing || flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(sel < 0 ? 0 : (sel + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(sel <= 0 ? flat.length - 1 : sel - 1);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setSelected(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setSelected(flat.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = sel >= 0 ? flat[sel] : undefined;
      if (item) go(item);
    }
  }

  const waitingForServer = trimmed.length >= MIN_SERVER_QUERY && (loading || searchedFor !== trimmed) && !failed;
  const status = waitingForServer
    ? "Searching problems…"
    : failed
      ? "Problem search is not responding. Showing pages only."
      : `${flat.length} ${flat.length === 1 ? "result" : "results"}`;

  return (
    <dialog
      ref={dialogRef}
      aria-label="Search problems and pages"
      onClose={() => onOpenChange(false)}
      onClick={(e) => {
        // A click on the dialog element itself is a click on the backdrop.
        if (e.target === dialogRef.current) onOpenChange(false);
      }}
      className={cn(
        "mx-auto mb-auto mt-[10dvh] w-[calc(100%-2rem)] max-w-xl rounded-2xl border border-border bg-surface p-0 text-text shadow-pop backdrop:bg-black/45 backdrop:backdrop-blur-[2px]",
        open && "animate-pop-in",
      )}
    >
      <div className="flex items-center gap-3 border-b border-border pl-4 pr-2">
        <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="recx-palette-listbox"
          aria-activedescendant={sel >= 0 ? optionId(sel) : undefined}
          aria-autocomplete="list"
          aria-label="Search problems by title, or jump to a page"
          placeholder="Search problems or jump to…"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
        />
        {waitingForServer && <Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin text-muted" aria-hidden />}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close search"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-primary-subtle hover:text-text"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {/* One polite status line, updated once per settled search. */}
      <p className="sr-only" role="status">
        {open ? status : ""}
      </p>

      <div className="scroll-thin max-h-[min(26rem,60dvh)] overflow-y-auto p-2">
        {flat.length > 0 ? (
          <ul role="listbox" id="recx-palette-listbox" aria-label="Results">
            {groups.map((group, gi) => {
              const labelId = `recx-palette-group-${group.id}`;
              return (
                <li key={group.id} role="presentation">
                  <div
                    id={labelId}
                    role="presentation"
                    className="px-3 pb-1 pt-3 text-[0.68rem] font-semibold uppercase tracking-wide text-muted"
                  >
                    {group.label}
                  </div>
                  <ul role="group" aria-labelledby={labelId}>
                    {group.items.map((item, ii) => {
                      const index = (offsets[gi] ?? 0) + ii;
                      const isSelected = index === sel;
                      return (
                        <li
                          key={item.key}
                          id={optionId(index)}
                          role="option"
                          aria-selected={isSelected}
                          onMouseMove={() => setSelected(index)}
                          onClick={() => go(item)}
                          className={cn(
                            "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors",
                            isSelected && "bg-primary-subtle",
                          )}
                        >
                          {item.problem ? (
                            <>
                              <span className="min-w-14 max-w-28 shrink-0 truncate font-mono text-xs text-text-secondary">
                                {item.problem.displayCode}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.label}</span>
                              <SolveStatus status={item.problem.status} className="hidden text-xs sm:inline-flex" />
                              <DifficultyBadge difficulty={item.problem.difficulty} />
                            </>
                          ) : (
                            <>
                              <span
                                className={cn(
                                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated",
                                  isSelected ? "text-primary" : "text-muted",
                                )}
                              >
                                <ItemGlyph icon={item.icon} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{item.label}</span>
                                {item.sublabel && (
                                  <span className="block truncate text-xs text-text-secondary">{item.sublabel}</span>
                                )}
                              </span>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : waitingForServer ? (
          <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
            Searching…
          </p>
        ) : failed ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium">Search is not responding</p>
            <p className="mt-1 text-xs text-text-secondary">Check your connection, then keep typing to retry.</p>
          </div>
        ) : (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium">Nothing matches “{trimmed}”</p>
            <p className="mt-1 text-xs text-text-secondary">Try a shorter word from the problem title.</p>
          </div>
        )}
      </div>

      <div className="hidden items-center gap-1.5 border-t border-border px-4 py-2 text-[0.7rem] text-text-secondary sm:flex">
        <kbd className="rounded border border-border bg-elevated px-1 font-sans">↑</kbd>
        <kbd className="rounded border border-border bg-elevated px-1 font-sans">↓</kbd> move ·
        <kbd className="rounded border border-border bg-elevated px-1 font-sans">Enter</kbd> open ·
        <kbd className="rounded border border-border bg-elevated px-1 font-sans">Esc</kbd> close
      </div>
    </dialog>
  );
}
