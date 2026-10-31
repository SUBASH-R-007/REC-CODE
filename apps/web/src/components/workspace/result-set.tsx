import { SQL_DISPLAY_ROWS, describeResultSet, displayCell, type SqlResultSet } from "@recx/shared";

/**
 * A SQL result set as a table (Phase 12k, slice 4).
 *
 * A student's answer to a SQL question is a result set, so the console
 * shows one: columns across the top, one row per row, and SQL NULL written
 * as the word NULL rather than an empty box — because `''` and NULL are
 * different answers and a blank cell cannot tell them apart.
 *
 * No hooks and no handlers, like the rest of result-view.tsx, so the client
 * console and the server-rendered submission page render the same table.
 *
 * Long tables are clipped before they are STORED (`SQL_DISPLAY_ROWS`), and
 * clipped again here for anything that reached a page another way. What is
 * on screen always says which it is.
 */
export function ResultSetTable({
  title,
  resultSet,
  tone,
}: {
  title: string;
  resultSet: SqlResultSet;
  tone?: "danger";
}) {
  const shown = resultSet.rows.slice(0, SQL_DISPLAY_ROWS);
  const clipped = resultSet.truncated === true || shown.length < resultSet.rows.length;
  const caption = `${title}: ${describeResultSet(resultSet)}`;
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
      {/* Focusable: a wide table scrolls sideways, and it must do so from the keyboard. */}
      <div
        tabIndex={0}
        role="group"
        aria-label={caption}
        className={
          tone === "danger"
            ? "scroll-thin max-h-48 overflow-auto rounded-lg border border-danger/20 bg-danger-subtle"
            : "scroll-thin max-h-48 overflow-auto rounded-lg border border-border bg-background"
        }
      >
        {resultSet.columns.length === 0 ? (
          <p className="px-3 py-2 font-mono text-xs text-muted">(no columns)</p>
        ) : (
          <table className="w-full border-collapse font-mono text-xs">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {resultSet.columns.map((column, c) => (
                  <th
                    key={`${column}-${c}`}
                    scope="col"
                    className="sticky top-0 border-b border-border bg-background px-2 py-1 text-left font-semibold whitespace-nowrap text-text"
                  >
                    {column.length > 0 ? column : <span className="text-muted">(unnamed)</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={resultSet.columns.length} className="px-2 py-1 text-muted">
                    (no rows)
                  </td>
                </tr>
              ) : (
                shown.map((row, r) => (
                  <tr key={r} className="border-b border-border/60 last:border-0">
                    {resultSet.columns.map((_, c) => {
                      const cell = row[c] ?? null;
                      return (
                        <td key={c} className="px-2 py-1 align-top whitespace-pre-wrap break-words text-text">
                          {cell === null ? <span className="text-muted italic">NULL</span> : displayCell(cell)}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
      {clipped && <p className="mt-1 text-xs text-muted">Showing the first {shown.length} rows.</p>}
    </div>
  );
}
