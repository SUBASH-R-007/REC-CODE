# REC Code — Accessibility

**Target: WCAG 2.2 Level AA** on every page, for every role.

**Accessibility contact: <to be named by the college>.** Barriers found in
REC Code should reach a named person who can act on them, not a generic
inbox.

---

## 1. Why colour is never the only signal

About 8% of men have a red-green colour vision deficiency. In a
5,000-student engineering cohort that is **250–350 students**. The two most
frequent signals in the product — **AC vs WA**, and **Easy vs Hard** — are
both on the red-green axis: exactly the pair those students cannot tell
apart by hue.

So in REC Code, colour is the fast, secondary channel. **Icon and text are
primary.** Every state that matters is readable in grayscale, to a
screen reader, and to someone who cannot distinguish red from green. This is
not a preference: WCAG 2.2 SC 1.4.1 (Use of Color) makes it a conformance
requirement.

The palette is checked the same way. `packages/design/src/cvd.ts` simulates
deuteranopia, protanopia, tritanopia and grayscale (Machado et al. 2009) for
palette previews and tests, and `packages/design/src/contrast.ts` gates the
admin-chosen brand: a theme whose tokens fail contrast is refused at save
time. `--success`, `--warning`, `--danger` and `--info` are never themeable.

---

## 2. Verdicts — four encodings

A verdict renders **only** through `VerdictBadge`
(`packages/design/src/components/verdict-badge.tsx`). Each one carries four
independent encodings: a token colour, an icon with its own silhouette, the
full text label and a monospace code, plus a shape cue on the badge's left
edge. The label and code come from `VERDICT_LABEL` / `VERDICT_CODE` in
`@recx/shared`.

| Verdict | Colour token | Icon (silhouette) | Label | Code | Left edge |
|---|---|---|---|---|---|
| AC | success | check in a circle | Accepted | `AC` | solid |
| WA | danger | cross in a circle | Wrong Answer | `WA` | solid |
| TLE | warning | clock | Time Limit Exceeded | `TLE` | dashed |
| MLE | warning | memory chip | Memory Limit Exceeded | `MLE` | dashed |
| OLE | warning | document with output arrow | Output Limit Exceeded | `OLE` | dashed |
| RE | danger | triangle with exclamation | Runtime Error | `RE` | dotted |
| CE | info | document with warning | Compile Error | `CE` | dotted |
| PARTIAL | accent | dashed circle with dot (+ `passed/total`) | Partially Accepted | `PARTIAL` | solid |
| SKIPPED | muted | skip-forward | Skipped | `SKIPPED` | none |
| IE | muted | server with fault | Internal Error | `IE` | none |
| QUEUED | muted | hourglass | Queued | — | none |
| RUNNING | info | spinner (static under reduced motion) | Running | — | none |

Design notes:

* **AC and WA differ in four ways**, not one: green vs red, a tick vs a
  cross, "Accepted" vs "Wrong Answer", `AC` vs `WA`.
* RE is a **triangle**, deliberately not a circle, so a crash never reads
  as WA. CE is info blue: "your code never ran" is a different kind of
  problem from "too slow".
* The icon and the code are `aria-hidden`; a screen reader hears the label
  once ("Accepted"), and for PARTIAL "Partially Accepted, 7 of 10 tests
  passed".

---

## 3. Difficulty, solve status, heatmap

**Difficulty is never a bare coloured word** (`DifficultyBadge`). The word
is always present, and a three-bar meter repeats it without relying on hue:

| Difficulty | Bars filled | Colour token |
|---|---|---|
| Easy | 1 of 3 | success |
| Medium | 2 of 3 | accent |
| Hard | 3 of 3 | danger |

**Solve status** (`SolveStatus`): *Solved* is a filled check-circle plus the
word "Solved"; *Attempted* is a hollow dashed circle plus "Attempted"; not
attempted renders nothing at all — absence, never a grey dot that could be
confused with either.

**Activity heatmap (Phase 3).** A single-hue **lightness ramp**: each step
is lighter or darker than its neighbours, so it reads in grayscale and under
every colour vision deficiency. Zero-activity cells are distinguished by an
outline, every cell has a text equivalent ("3 submissions on 12 March"), and
the same data is available as text for screen-reader users.

---

## 4. Commitments on every page

| WCAG 2.2 | How REC Code meets it |
|---|---|
| 1.4.3 / 1.4.11 Contrast | tokens meet 4.5:1 for text and 3:1 for UI components and focus indicators, in light and dark themes; the brand derivation refuses palettes that do not |
| 1.4.1 Use of Color | §1–§3 |
| 1.4.10 Reflow | every page reflows to 320 CSS px without horizontal scrolling — except the stated exception in §5 |
| 2.1.1 / 2.1.2 Keyboard, no trap | every control is a native or ARIA-pattern control; the one editor exception is documented in §5 |
| 2.4.7 / 2.4.11 Focus visible, not obscured | a visible focus ring on every focusable element; sticky headers never cover the focused element |
| 2.5.7 Dragging movements | the workspace's resizable panes can also be resized from the keyboard on their handles |
| 2.5.8 Target size (minimum) | interactive targets are at least 24 × 24 CSS px |
| 3.3.8 Accessible authentication | sign-in needs no cognitive test; pasting and password managers work |
| 4.1.3 Status messages | the final verdict is announced once through a polite live region — never per test, which would flood a screen reader; per-test progress stays visible on screen |
| 2.3.3 / reduced motion | spinners and transitions stop under `prefers-reduced-motion` |

---

## 5. Stated exceptions

These are deliberate, scoped and documented here so they are not mistaken
for oversights.

1. **The coding workspace keeps a two-dimensional layout.** On wide
   screens the problem statement, the editor and the result console sit
   side by side so the statement and the editor's controls stay in view
   while code is written. Below 1024 px the workspace becomes a single
   column with three tabs — **Problem / Code / Result** — showing one region
   at a time; below 768 px the editor is CodeMirror 6 instead of Monaco.
   Inside the editor, code is never reflowed: indentation carries meaning
   (Python), and long lines scroll horizontally. This falls under the SC
   1.4.10 carve-out for content that requires a two-dimensional layout for
   usage or meaning. Every other page — problem lists, the statement,
   results, profiles — reflows fully. **Focus mode** (Ctrl+Shift+F) hides
   the statement and the shell chrome; Esc (outside the editor) or the same
   shortcut exits it.
2. **The editor captures Tab** to indent, as every code editor does. The
   documented escape in both editors: press **Esc**, then **Tab**, to move
   focus out of the editor. In Monaco, **Ctrl+M** (**Ctrl+Shift+M** on
   macOS) toggles "Tab moves focus" for the session; in CodeMirror (phones
   and narrow windows) the toggle is **Ctrl+M** (**Alt+Shift+M** on macOS).
   The workspace states this next to the editor (visible from 768 px,
   screen-reader text below), which is what SC 2.1.2 requires of a
   non-standard exit.

**Dark theme.** The canonical dark `--primary` falls below 4.5:1 for normal
text (4.23:1 under white, 4.1–4.5:1 as text on the dark surfaces). The
tokens are kept verbatim, and a dark-only rule in
`packages/design/utilities.css` uses the adjacent tokens for filled primary
surfaces and primary text so every pair clears AA (see
`docs/OPEN-QUESTIONS.md`, Phase 3).

---

## 6. How this is verified

* **Automated axe checks** (`@axe-core/playwright`, zero serious or critical
  violations) run in the end-to-end suite (`apps/web/e2e/a11y.spec.ts`) over
  every page a phase has shipped — **140 scans** at the Phase 9 gate: each
  page in light and dark × 1366×768 and 375×812, including the `/admin`,
  `/super`, `/mentor`, `/placement-cell` and `/judge` surfaces, the workspace
  with its console open and its mobile Code/Result tabs, and the exam
  surfaces. A keyboard-only solving journey runs beside it
  (`keyboard-journey.spec.ts`), and `docs/RUNBOOK.md` §3 records every run
  with its date and count.
* Palette contrast and colour-vision simulation are unit-tested in
  `packages/design`.
* **Keyboard-only passes** are automated and gated (above). **Screen-reader
  passes are manual, and not all of them have been done** — stated plainly
  rather than implied by the sentence this bullet replaced, which claimed a
  screen-reader pass at every gate:
  * done, and recorded in `docs/RUNBOOK.md` §3: the solving journey, the
    catalogue, the dashboard and the verdict announcements (NVDA with
    Chrome, Windows);
  * **outstanding**: a full assessment sat with a screen reader in each
    proctor mode. It is carried in `docs/OPEN-QUESTIONS.md` with its reason
    — it needs a sitting of an hour or more per mode, and doing it badly
    (clicking through rather than sitting it) would produce a row in the
    gate log that says PASS and means nothing.
  A barrier found by that pass is a bug, not a finding to be negotiated;
  until it is run, the exam surface's screen-reader behaviour is asserted
  only by axe and by the keyboard journey, which is weaker and is why this
  bullet says so.
* A barrier reported by a student is a bug with the same priority as a
  functional one.
