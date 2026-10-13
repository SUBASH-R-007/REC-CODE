/**
 * Problem-authoring contracts, imported as "@recx/shared/authoring" (not
 * re-exported from the package root). Pure: no I/O, no crypto.
 *
 *   origins.ts   CONTENT_ORIGINS (enum mirror), DIFFICULTIES
 *   review.ts    review stages DRAFT → IN_REVIEW → APPROVED → PUBLISHED → RETIRED
 *   content.ts   the structural publish rules (versionContentIssues)
 *   package.ts   the bulk-import package format and its limits
 */
export * from "./origins";
export * from "./review";
export * from "./content";
export * from "./package";
