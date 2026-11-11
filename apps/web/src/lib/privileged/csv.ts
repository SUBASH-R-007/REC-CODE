/**
 * CSV for the PII export.
 *
 * The implementation moved to `packages/shared/src/csv.ts` when Phase 7
 * needed the same writer for the aptitude question-bank export: one
 * definition, not a second weaker one. Re-exported from here so every
 * existing import and every existing test keeps working, which is what
 * proves the move changed no behaviour.
 *
 * The hardening is the reason it is worth sharing: every cell is quoted, and
 * a cell a spreadsheet would read as a formula (it starts with = + - @, a tab
 * or a carriage return) is prefixed with an apostrophe first, so an opened
 * export can never run a formula planted in a name.
 */
export { csvCell, csvRow } from "@recx/shared";
