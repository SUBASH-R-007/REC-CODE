import { describe, expect, it } from "vitest";
import { readRepoFile } from "./support/repo";

/**
 * A dialog must not read its own `close()` as the user dismissing it
 * (Phase 13g).
 *
 * On 2026-11-04 no dialog in this application could be opened in
 * development. Clicking "Return to ONLINE" on `/admin/judge` did nothing
 * at all: no error in the console, no failed request, no React warning —
 * the state flipped, the dialog mounted, and it was gone again in the
 * same frame. It took a render probe to see the sequence:
 *
 *     NodeActions render  action=online        <- the click
 *     Dialog render       open=true            <- it mounted
 *     NodeActions render  action=null          <- and the parent gave up
 *
 * The cause was two correct pieces working against each other. `Dialog`
 * closes the native element in an unmount cleanup, so that focus returns
 * to the control that opened it; and it listens for the element's native
 * `close` event, because a browser can close a modal on its own (a
 * second Escape without user activation is not cancelable) and the
 * parent — which still believes it is open — has to be told. React
 * remounts every effect once on mount in development, which runs that
 * cleanup while the dialog is still mounted and open. `close()` queued a
 * `close` event, the listener reported a dismissal, the parent cleared
 * the state holding the dialog open, and the dialog unmounted.
 *
 * It reached every one of the 23 dialogs in the app, including the ones
 * behind SECURITY-audited operations — returning a judge node to
 * service, enabling a language, a legal hold, a purge — and it survived
 * because the gate's end-to-end runs use a production build, where React
 * does not remount effects, and there is no DOM test environment in this
 * repository to catch it in a unit test.
 *
 * So the shape of the fix is asserted here instead: every `close()` on
 * the element goes through the one helper that sets the flag, and the
 * listener checks that flag before it decides anything. Both halves
 * matter — the flag with a second un-flagged `close()` somewhere would
 * bring the bug straight back — and a fence over 40 lines of one file is
 * the strongest guard available without a browser.
 */

const DIALOG = "packages/design/src/components/dialog.tsx";

describe("the design system's Dialog", () => {
  const source = readRepoFile(DIALOG);

  it("closes the element through exactly one helper", () => {
    /**
     * Read as text: one `closeElement` declaration, which holds the only
     * `.close()` call in the file. A second direct `dialog.close()` —
     * the obvious thing to write when adding a new reason to close — is
     * what this catches.
     */
    const closes = [...source.matchAll(/\.close\(\)/g)].length;
    expect(closes, `every close() in ${DIALOG} belongs to closeElement`).toBe(1);

    const helper = source.match(
      /const closeElement = \(dialog: HTMLDialogElement\) => \{([\s\S]*?)\n {2}\};/,
    );
    expect(helper, `closeElement in ${DIALOG}`).not.toBeNull();
    const body = helper![1]!;
    expect(body, "closeElement raises the flag").toMatch(/closingSelf\.current = true;/);
    expect(body, "closeElement then closes the element").toMatch(/dialog\.close\(\);/);
    // Order matters: the flag has to be up before the event is queued.
    expect(body.indexOf("closingSelf.current = true")).toBeLessThan(body.indexOf("dialog.close()"));
  });

  it("ignores its own close event before anything else", () => {
    const handler = source.match(/onClose=\{\(\) => \{([\s\S]*?)\n {6}\}\}/);
    expect(handler, `the native onClose handler in ${DIALOG}`).not.toBeNull();
    const body = handler![1]!;
    const guard = body.indexOf("closingSelf.current");
    expect(guard, "the handler checks the flag").toBeGreaterThan(-1);
    expect(body, "and lowers it again, so a later browser close is still heard").toMatch(
      /closingSelf\.current = false;/,
    );
    expect(body, "and returns without telling the parent").toMatch(
      /if \(closingSelf\.current\) \{[\s\S]*?return;[\s\S]*?\}/,
    );
    // Before every other decision in the handler, or an unmount cleanup
    // would still reach onClose / showModal through one of them.
    for (const later of ["if (!open) return;", "dismissible", "onClose()"]) {
      const at = body.indexOf(later);
      if (at === -1) continue;
      expect(guard, `the flag is checked before \`${later}\``).toBeLessThan(at);
    }
  });

  it("keeps the unmount cleanup that restores focus", () => {
    // The cleanup is the reason the flag exists; a fix that deleted it
    // would pass the two checks above and lose the focus return.
    expect(source, "the layout-effect cleanup still closes an open dialog").toMatch(
      /useLayoutEffect\(\(\) => \{[\s\S]*?return \(\) => \{[\s\S]*?closeElement\(dialog\);/,
    );
  });
});
