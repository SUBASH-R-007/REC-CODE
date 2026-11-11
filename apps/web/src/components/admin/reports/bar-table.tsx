import { TableFrame, TBODY_ROW, TD, TH, THEAD_ROW } from "@/components/admin/admin-ui";

/**
 * A figure that is also a table: each row has its label, its number as
 * text and a CSS-width bar (decorative; the number carries the meaning).
 * No chart library, no client JavaScript.
 */
export function BarTable({
  caption,
  labelHeader,
  valueHeader,
  rows,
  format = (v) => v.toLocaleString("en-IN"),
}: {
  caption: string;
  labelHeader: string;
  valueHeader: string;
  rows: { label: string; value: number; note?: string }[];
  format?: (value: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <TableFrame label={caption}>
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className={THEAD_ROW}>
            <th scope="col" className={TH}>
              {labelHeader}
            </th>
            <th scope="col" className={`${TH} text-right`}>
              {valueHeader}
            </th>
            <th scope="col" className={`${TH} w-1/2`}>
              <span className="sr-only">Bar</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={TBODY_ROW}>
              <th scope="row" className={`${TD} whitespace-nowrap text-left font-normal`}>
                {r.label}
                {r.note ? <span className="block text-xs text-text-secondary">{r.note}</span> : null}
              </th>
              <td className={`${TD} text-right tabular-nums`}>{format(r.value)}</td>
              <td className={`${TD} align-middle`}>
                <div aria-hidden className="h-2.5 w-full min-w-24 rounded-full bg-primary-subtle">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(100 * r.value) / max}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
