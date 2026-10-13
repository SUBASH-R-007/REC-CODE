/**
 * The handful of Monaco APIs the workspace uses, declared locally. Monaco
 * arrives at runtime as the self-hosted AMD build (/monaco/vs), so nothing
 * from the monaco-editor npm package is bundled into client code.
 */

export interface MonacoDisposable {
  dispose(): void;
}

export interface MonacoPosition {
  lineNumber: number;
  column: number;
}

export interface MonacoTextModel {
  getPositionAt(offset: number): MonacoPosition;
}

export interface MonacoEditor {
  getValue(): string;
  setValue(value: string): void;
  getModel(): MonacoTextModel | null;
  getPosition(): MonacoPosition | null;
  setPosition(position: MonacoPosition): void;
  revealPositionInCenterIfOutsideViewport(position: MonacoPosition): void;
  /** Content-space top of a line (padding included), the same space as getScrollTop(). */
  getTopForLineNumber(lineNumber: number): number;
  getScrollTop(): number;
  setScrollTop(scrollTop: number): void;
  getLayoutInfo(): { height: number };
  focus(): void;
  dispose(): void;
  onDidChangeModelContent(listener: () => void): MonacoDisposable;
  onDidChangeCursorPosition(listener: () => void): MonacoDisposable;
  onDidLayoutChange(listener: () => void): MonacoDisposable;
  updateOptions(options: Record<string, unknown>): void;
}

export interface MonacoThemeRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: MonacoThemeRule[];
  colors: Record<string, string>;
}

export interface MonacoApi {
  editor: {
    create(element: HTMLElement, options: Record<string, unknown>): MonacoEditor;
    defineTheme(name: string, data: MonacoThemeData): void;
    setTheme(name: string): void;
    setModelLanguage(model: MonacoTextModel, languageId: string): void;
  };
}

/** The AMD loader's global `require` (vs/loader.js). */
export interface AmdRequire {
  (deps: string[], onLoad: () => void, onError?: (error: unknown) => void): void;
  config(config: { paths: Record<string, string> }): void;
}

export interface MonacoWindow {
  require?: AmdRequire;
  monaco?: MonacoApi;
  MonacoEnvironment?: { getWorkerUrl(moduleId: string, label: string): string };
}
