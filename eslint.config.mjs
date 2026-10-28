// Repository-wide lint. Several of REC Code's hard rules are enforced here;
// the rest are enforced by tests/repo/*.test.ts (part of `pnpm test`).
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// Any #rgb / #rgba / #rrggbb / #rrggbbaa literal.
const HEX = "/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])/";
const HEX_MESSAGE =
  "No hardcoded hex colours in components. Use a design token (bg-primary, text-danger, var(--surface), …).";

const CHILD_PROCESS_MESSAGE =
  "apps/web must never spawn processes. Student code never runs in the web process — it is judged by apps/judge-worker inside isolate.";
const childProcessPaths = [
  { name: "child_process", message: CHILD_PROCESS_MESSAGE },
  { name: "node:child_process", message: CHILD_PROCESS_MESSAGE },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      // A second Next build directory, for running a dev server beside a
      // production one on the same checkout (RECX_DIST_DIR in
      // apps/web/next.config.ts). Generated output, like .next itself.
      "**/.next-dev/**",
      "**/dist/**",
      "**/coverage/**",
      "apps/web/public/**",
      "**/next-env.d.ts",
      // Coordinator handoff notes, not source. docs/handoff/phase4/
      // p4-review.workflow.js is a Workflow-tool script: agent(), parallel(),
      // pipeline() and log() are injected by that runtime, so no-undef cannot
      // see them. The directory goes away once Phase 4 is gated
      // (docs/handoff/README.md).
      "docs/handoff/**",
      /**
       * Playwright's own output. Both are gitignored, and `playwright-report`
       * contains a bundled copy of the trace viewer — minified browser code
       * that fails `no-undef` on `document` and `self` by the hundred. It
       * only appears when the e2e suite is run from the repository itself
       * (Windows); the WSL mirror has its own copy, which is why it took
       * until Phase 10c to see this.
       */
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // ── apps/web ──────────────────────────────────────────────────────────
  {
    files: ["apps/web/**/*.{ts,tsx,mjs}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: "apps/web" } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: childProcessPaths,
          patterns: [
            {
              group: ["monaco-editor", "monaco-editor/*"],
              message: "Monaco may only be imported under apps/web/src/components/editor/**.",
            },
          ],
        },
      ],
    },
  },
  {
    // The single place Monaco is allowed.
    files: ["apps/web/src/components/editor/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: childProcessPaths }],
    },
  },

  // ── apps/judge-worker: no database, ever ──────────────────────────────
  {
    files: ["apps/judge-worker/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@recx/db", message: "The judge worker holds no database credentials." },
            { name: "@prisma/client", message: "The judge worker holds no database credentials." },
          ],
          patterns: [
            { group: ["@recx/db/*", "@prisma/*", ".prisma/*"], message: "The judge worker holds no database credentials." },
          ],
        },
      ],
    },
  },

  // ── No hardcoded hex in any component ─────────────────────────────────
  {
    files: ["packages/design/src/**/*.tsx", "apps/web/src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `Literal[value=${HEX}]`, message: HEX_MESSAGE },
        { selector: `TemplateElement[value.raw=${HEX}]`, message: HEX_MESSAGE },
        { selector: `JSXText[value=${HEX}]`, message: HEX_MESSAGE },
      ],
    },
  },

  {
    files: ["packages/design/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
);
