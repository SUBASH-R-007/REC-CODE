"use client";

import { useCallback, useRef } from "react";
import { Check, Flag, Minus } from "lucide-react";
import {
  PALETTE_APPEARANCE,
  PALETTE_STATES,
  paletteCounts,
  paletteCountsText,
  paletteLabel,
  paletteNavigate,
  paletteStateOf,
  type PaletteState,
  type QuestionProgress,
} from "@recx/shared";

/**
 * The question palette (Phase 6c).
 *
 * SPEC §5: "five states each with a distinct shape + icon + full aria-label,
 * as a role='group' of buttons with a roving tabindex and Arrow-key
 * navigation, a text+icon legend, and a counts row".
 *
 * Which state a question is in, what it is called, and where an Arrow key
 * moves are all decided in `@recx/shared/exam-palette` and unit-tested there
 * — including that no two states differ by colour alone. This component is
 * the rendering, and the rendering's job is to put the shape and the glyph on
 * screen so the colour is never carrying the meaning.
 *
 * Roving tabindex: exactly one button is tabbable at a time, so Tab moves
 * past the palette in one press rather than through thirty buttons. Arrows
 * move inside it, and Arrow movement CLAMPS — wrapping from question 30 to
 * question 1 on one extra keypress is how someone loses their place in an
 * exam.
 */

const COLUMNS = 5;

type GlyphName = NonNullable<(typeof PALETTE_APPEARANCE)[PaletteState]["icon"]>;

const ICON: Readonly<Record<GlyphName, typeof Check>> = Object.freeze({
  minus: Minus,
  check: Check,
  flag: Flag,
});

const TONE: Readonly<Record<PaletteState, string>> = Object.freeze({
  NOT_VISITED: "bg-surface border-border text-text-secondary",
  VISITED_UNANSWERED: "bg-danger-subtle border-danger/40 text-danger",
  ANSWERED: "bg-success-subtle border-success/40 text-success",
  MARKED: "bg-info-subtle border-info/40 text-info",
  ANSWERED_MARKED: "bg-info-subtle border-info/40 text-info",
});

/** The geometry, which is what survives greyscale. */
const SHAPE: Readonly<Record<PaletteState, string>> = Object.freeze({
  NOT_VISITED: "rounded-sm",
  // The bottom notch: a square with its lower corners cut, so this state is
  // distinguishable from "not visited" without reading its colour.
  VISITED_UNANSWERED: "rounded-sm [clip-path:polygon(0_0,100%_0,100%_72%,50%_100%,0_72%)]",
  ANSWERED: "rounded-full",
  MARKED: "rounded-full",
  ANSWERED_MARKED: "rounded-full",
});

function Glyph({ state }: { readonly state: PaletteState }) {
  const appearance = PALETTE_APPEARANCE[state];
  if (appearance.icon === null) return null;
  const Icon = ICON[appearance.icon];
  return <Icon className="h-3.5 w-3.5" aria-hidden strokeWidth={3} />;
}

export function QuestionPalette({
  progress,
  current,
  onSelect,
}: {
  readonly progress: readonly QuestionProgress[];
  /** 0-based index of the question on screen. */
  readonly current: number;
  readonly onSelect: (index: number) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const counts = paletteCounts(progress);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const next = paletteNavigate({ index, total: progress.length, columns: COLUMNS, key: event.key });
      // null means the key is not ours — Tab, Enter and Space must reach the
      // browser, or the palette becomes a trap.
      if (next === null) return;
      event.preventDefault();
      buttons.current[next]?.focus();
      onSelect(next);
    },
    [progress.length, onSelect],
  );

  return (
    <nav aria-label="Questions" className="flex w-60 shrink-0 flex-col gap-4 border-r border-border p-4">
      <div
        role="group"
        aria-label="Question palette"
        className="grid grid-cols-5 gap-2"
      >
        {progress.map((question, index) => {
          const state = paletteStateOf(question);
          const appearance = PALETTE_APPEARANCE[state];
          return (
            <button
              key={index}
              ref={(node) => {
                buttons.current[index] = node;
              }}
              type="button"
              // Roving tabindex: one stop for the whole palette.
              tabIndex={index === current ? 0 : -1}
              aria-current={index === current ? "true" : undefined}
              aria-label={paletteLabel(index + 1, state)}
              onClick={() => onSelect(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`relative flex h-9 w-9 items-center justify-center border text-xs font-semibold tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${TONE[state]} ${SHAPE[state]}`}
            >
              <span aria-hidden>{index + 1}</span>
              <span aria-hidden className="absolute -right-0.5 -top-0.5">
                <Glyph state={state} />
              </span>
              {appearance.badge === "check" ? (
                <span
                  aria-hidden
                  className="absolute -bottom-0.5 -right-0.5 rounded-full bg-success text-[8px] text-background"
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={4} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* The counts row, in the spec's own wording. */}
      <p className="text-xs text-text-secondary tabular-nums">{paletteCountsText(counts)}</p>

      {/*
        The legend. Text AND icon for every state, because the palette's
        colours mean nothing to a candidate who cannot distinguish them.
      */}
      <dl className="flex flex-col gap-1.5 text-xs">
        {PALETTE_STATES.map((state) => (
          <div key={state} className="flex items-center gap-2">
            <dt
              aria-hidden
              className={`flex h-5 w-5 items-center justify-center border ${TONE[state]} ${SHAPE[state]}`}
            >
              <Glyph state={state} />
            </dt>
            <dd className="text-text-secondary">{PALETTE_APPEARANCE[state].legend}</dd>
          </div>
        ))}
      </dl>
    </nav>
  );
}
