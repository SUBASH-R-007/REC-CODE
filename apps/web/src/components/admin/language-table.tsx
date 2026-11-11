import { Languages } from "lucide-react";
import { Badge, EmptyState } from "@recx/design";
import type { LanguageConfigRow } from "@/server/queries/admin-judge";
import { LanguageToggle } from "@/components/admin/language-toggle";
import { EnabledChip } from "@/components/admin/status-chips";

const th = "px-3 py-2.5 text-left font-medium first:pl-5 last:pr-5";
const td = "px-3 py-2.5 first:pl-5 last:pr-5 align-middle";

/** LanguageConfig rows (one per language × pinned toolchain), with the enable toggle. */
export function LanguageTable({ rows }: { rows: LanguageConfigRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        icon={<Languages className="h-5 w-5" />}
        title="No language configurations"
        description="Language rows are created by the seed from the language catalog."
      />
    );
  }
  return (
    // Focusable, so a table wider than a phone scrolls from the keyboard.
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Language configurations">
      <table className="w-full text-sm">
        <caption className="sr-only">Language configurations</caption>
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <th scope="col" className={th}>
              Key
            </th>
            <th scope="col" className={th}>
              Label
            </th>
            <th scope="col" className={th}>
              Toolchain
            </th>
            <th scope="col" className={th}>
              Status
            </th>
            <th scope="col" className={th}>
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border first:border-t-0">
              <td className={`${td} font-mono text-xs`}>{r.key}</td>
              <td className={td}>{r.label}</td>
              <td className={td}>
                <span className="font-mono text-xs">{r.toolchainId}</span>
                <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                  {r.isCurrent && <Badge tone="primary">Current</Badge>}
                  {r.retired && <Badge>Retired</Badge>}
                </span>
              </td>
              <td className={td}>
                <EnabledChip enabled={r.enabled} />
              </td>
              <td className={`${td} text-right`}>
                <LanguageToggle
                  languageConfigId={r.id}
                  label={r.label}
                  toolchainId={r.toolchainId}
                  enabled={r.enabled}
                  retired={r.retired}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
