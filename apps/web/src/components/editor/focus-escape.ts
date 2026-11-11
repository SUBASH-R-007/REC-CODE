/**
 * Keyboard-trap escape for editors that capture Tab (WCAG 2.1.2): move focus
 * to the next (or previous) tabbable element OUTSIDE `container`, in
 * document order, wrapping around the page if there is none in that
 * direction.
 */

const TABBABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "iframe",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  "[tabindex]",
].join(",");

function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false;
  if (el.closest("[inert]")) return false;
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

export function moveFocusOutside(container: HTMLElement, backwards: boolean): boolean {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => !container.contains(el) && isTabbable(el),
  );
  const after: HTMLElement[] = [];
  const before: HTMLElement[] = [];
  for (const el of candidates) {
    const position = container.compareDocumentPosition(el);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) after.push(el);
    else if (position & Node.DOCUMENT_POSITION_PRECEDING) before.push(el);
  }
  const target = backwards ? (before[before.length - 1] ?? after[after.length - 1]) : (after[0] ?? before[0]);
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}
