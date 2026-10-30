import { describe, expect, it } from "vitest";
import {
  EDITOR_KEYMAPS,
  EDITOR_KEYMAP_DEFAULT,
  EDITOR_KEYMAP_HINT,
  EDITOR_KEYMAP_LABEL,
  EDITOR_KEYMAP_NOTICES,
  EDITOR_KEYMAP_SHADOWED,
  MONACO_KEYMAP_MODULE,
  editorKeyNote,
  keymapNeedsModule,
} from "../src/index";

describe("the keymaps on offer", () => {
  it("are the standard keys, vim and emacs, with the standard keys the default", () => {
    expect(EDITOR_KEYMAPS).toEqual(["DEFAULT", "VIM", "EMACS"]);
    expect(EDITOR_KEYMAP_DEFAULT).toBe("DEFAULT");
  });

  it("each has a label and a sentence saying what it is", () => {
    for (const keymap of EDITOR_KEYMAPS) {
      expect(EDITOR_KEYMAP_LABEL[keymap].length).toBeGreaterThan(2);
      expect(EDITOR_KEYMAP_HINT[keymap].length).toBeGreaterThan(20);
    }
  });

  it("costs a download only when it is not the default", () => {
    expect(keymapNeedsModule("DEFAULT")).toBe(false);
    expect(MONACO_KEYMAP_MODULE.DEFAULT).toBeNull();
    for (const keymap of ["VIM", "EMACS"] as const) {
      expect(keymapNeedsModule(keymap)).toBe(true);
      expect(MONACO_KEYMAP_MODULE[keymap]).toBe(`monaco-${keymap.toLowerCase()}`);
    }
  });
});

describe("the way out of the editor", () => {
  it("is in the note first, in every keymap", () => {
    for (const keymap of EDITOR_KEYMAPS) {
      const note = editorKeyNote({ kind: "monaco", apple: false, keymap });
      expect(note).not.toBeNull();
      expect(note!.startsWith("Esc then Tab leaves the editor")).toBe(true);
    }
  });

  it("names the keymap when it is not the standard one, and does not otherwise", () => {
    expect(editorKeyNote({ kind: "monaco", apple: false, keymap: "DEFAULT" })).toBe(
      "Esc then Tab leaves the editor · Ctrl+M toggles Tab key",
    );
    expect(editorKeyNote({ kind: "monaco", apple: false, keymap: "VIM" })).toContain("Vim keys");
    expect(editorKeyNote({ kind: "codemirror", apple: false, keymap: "EMACS" })).toContain("Emacs keys");
  });

  it("names each editor's own Tab-mode toggle, which differs on Apple platforms", () => {
    expect(editorKeyNote({ kind: "monaco", apple: true, keymap: "DEFAULT" })).toContain("Ctrl+Shift+M");
    expect(editorKeyNote({ kind: "codemirror", apple: true, keymap: "DEFAULT" })).toContain("Alt+Shift+M");
    expect(editorKeyNote({ kind: "codemirror", apple: false, keymap: "DEFAULT" })).toContain("Ctrl+M");
  });

  it("says nothing for the plain textarea, which captures nothing", () => {
    for (const keymap of EDITOR_KEYMAPS) {
      expect(editorKeyNote({ kind: "plain", apple: false, keymap })).toBeNull();
    }
  });

  it("admits what the escape hatch shadows in each mode", () => {
    // A keyboard trap is a defect; a shadowed jumplist binding is an
    // inconvenience, and a student is told which one they are getting.
    expect(EDITOR_KEYMAP_SHADOWED.DEFAULT).toBeNull();
    expect(EDITOR_KEYMAP_SHADOWED.VIM).toContain("jumplist");
    expect(EDITOR_KEYMAP_SHADOWED.EMACS).toContain("M-Tab");
    for (const keymap of ["VIM", "EMACS"] as const) {
      expect(EDITOR_KEYMAP_SHADOWED[keymap]).toContain("Esc then Tab leaves the editor");
    }
  });
});

describe("what people are told", () => {
  it("says the setting changes keys and nothing else", () => {
    expect(EDITOR_KEYMAP_NOTICES.setting).toContain("nothing else");
    expect(EDITOR_KEYMAP_NOTICES.setting).toContain("Esc then Tab");
  });

  it("says the proctored arena keeps the standard keys, and why", () => {
    expect(EDITOR_KEYMAP_NOTICES.examDefault).toContain("standard keys");
    expect(EDITOR_KEYMAP_NOTICES.examDefault).toContain("records about typing");
  });

  it("has a sentence for a keymap that did not load", () => {
    // A student who turned vim on and got the standard keys must be told,
    // rather than left typing j into their program.
    expect(EDITOR_KEYMAP_NOTICES.unavailable).toContain("standard keys");
  });

  it("every notice is a sentence", () => {
    for (const [key, text] of Object.entries(EDITOR_KEYMAP_NOTICES)) {
      expect(text.length, key).toBeGreaterThan(15);
      expect(text.trim(), key).toMatch(/[.…]$/);
    }
  });
});
