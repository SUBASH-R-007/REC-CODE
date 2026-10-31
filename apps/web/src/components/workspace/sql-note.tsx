import { Database } from "lucide-react";
import { SQL_DIALECT, SQL_DIALECT_LABEL, SQL_LIMITS, SQL_NOTICES } from "@recx/shared";

/**
 * The rules a SQL question is judged under, above the editor (Phase 12k).
 *
 * Four facts, in the order somebody needs them while typing: which
 * database, one statement, read-only, and how long a query may take. They
 * are chips rather than prose because this bar sits over the editor on a
 * phone too; the sentences themselves are read out to a screen reader and
 * printed in full in the Description tab, where there is room for them.
 */
export function SqlNote() {
  const seconds = SQL_LIMITS.statementTimeoutMs / 1000;
  return (
    <p className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-primary-subtle px-3 py-1 text-xs text-text-secondary">
      <Database className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="font-medium text-text">{SQL_DIALECT_LABEL[SQL_DIALECT]}</span>
      <span aria-hidden>·</span>
      <span>one statement</span>
      <span aria-hidden>·</span>
      <span>read-only</span>
      <span aria-hidden>·</span>
      <span>{seconds} s limit</span>
      <span className="sr-only">
        . {SQL_NOTICES.oneStatement} {SQL_NOTICES.readOnly} {SQL_NOTICES.timeout}
      </span>
    </p>
  );
}
