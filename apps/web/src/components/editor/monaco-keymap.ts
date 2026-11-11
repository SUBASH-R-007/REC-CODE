import { MONACO_KEYMAP_MODULE, type EditorKeymap } from "@recx/shared";
import { amdLoader } from "@/components/editor/monaco-loader";
import type { MonacoApi, MonacoEditor } from "@/components/editor/monaco-types";

/**
 * The vim and emacs keymaps for Monaco (Phase 12j).
 *
 * Both ship as UMD builds copied into `/monaco/keymaps` by
 * `scripts/copy-monaco.mjs` and loaded through Monaco's OWN AMD loader —
 * never a CDN, and never part of a JavaScript bundle. A student who never
 * turns a keymap on never downloads one; the files are fetched the first
 * time one is chosen and the browser caches them after that.
 *
 * `monaco-vim`'s UMD build asks AMD for
 * `monaco-editor/esm/vs/editor/editor.api`, a module id the self-hosted
 * loader has never heard of, so that id is defined here as the editor API
 * already in memory. `monaco-emacs` asks for `vs/editor/editor.main`,
 * which the loader does know.
 */

export interface KeymapHandle {
  dispose(): void;
}

interface VimModule {
  initVimMode(editor: MonacoEditor, statusBar?: HTMLElement | null): { dispose(): void };
}

interface EmacsModule {
  EmacsExtension: new (editor: MonacoEditor) => { start(): void; dispose(): void };
}

const KEYMAP_PATHS = {
  "monaco-vim": "/monaco/keymaps/monaco-vim",
  "monaco-emacs": "/monaco/keymaps/monaco-emacs",
};

let configured = false;

function configure(monaco: MonacoApi): { require: ReturnType<typeof amdLoader> } {
  const amd = amdLoader();
  if (!amd) throw new Error("monaco keymap: the AMD loader is not installed yet");
  if (!configured) {
    configured = true;
    amd.require.config({ paths: KEYMAP_PATHS });
    amd.define("monaco-editor/esm/vs/editor/editor.api", [], () => monaco);
  }
  return { require: amd };
}

function load<T>(monaco: MonacoApi, id: string): Promise<T> {
  const amd = configure(monaco).require;
  if (!amd) throw new Error("monaco keymap: the AMD loader is not installed yet");
  return new Promise<T>((resolve, reject) => {
    amd.require([id], (module) => resolve(module as T), reject);
  });
}

/**
 * Attach `keymap` to `editor` and return the handle that removes it again.
 * `DEFAULT` attaches nothing and fetches nothing: the editor's own keys
 * are the baseline.
 */
export async function attachKeymap(
  monaco: MonacoApi,
  editor: MonacoEditor,
  keymap: EditorKeymap,
  statusBar: HTMLElement | null,
): Promise<KeymapHandle | null> {
  const id = MONACO_KEYMAP_MODULE[keymap];
  if (!id) return null;

  if (keymap === "VIM") {
    const vim = await load<VimModule>(monaco, id);
    const mode = vim.initVimMode(editor, statusBar);
    return { dispose: () => mode.dispose() };
  }

  const emacs = await load<EmacsModule>(monaco, id);
  const extension = new emacs.EmacsExtension(editor);
  extension.start();
  return { dispose: () => extension.dispose() };
}
