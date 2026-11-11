/**
 * Inline script that applies the stored theme before first paint (avoids
 * a flash of the wrong theme). Kept in a plain, dependency-free module —
 * not a client component — so both the root layout and the edge CSP
 * middleware can reference it.
 *
 * The script is allow-listed in the Content-Security-Policy by its content
 * hash (below) rather than a nonce, so the tag needs no `nonce` attribute.
 *
 * THEME_SCRIPT_CSP_HASH must equal sha256(themeInitScript). It's hard-coded
 * because middleware runs in the edge runtime (no node:crypto); the unit
 * test in test/csp.test.ts recomputes it and fails loudly on any drift.
 * (Template literals normalise CRLF to LF, so a Windows checkout hashes the
 * same as Linux.)
 */

/** localStorage key holding "light" | "dark" | "system". */
export const THEME_STORAGE_KEY = "recx-theme";

export const themeInitScript = `
(function () {
  try {
    var t = localStorage.getItem("recx-theme") || "system";
    var d = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (d) document.documentElement.classList.add("dark");
  } catch (e) {}
})();
`;

/** CSP source expression allow-listing exactly the theme script above. */
export const THEME_SCRIPT_CSP_HASH = "'sha256-DDORlpdWP08fIVnmRPXEbt28vxtErgWnRlN42AMKJXQ='";
