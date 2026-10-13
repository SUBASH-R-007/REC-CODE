import { formatLanguageVersion } from "@/lib/judge/judge-links";

/**
 * The workspace footer's language: the label plus the exact version of the
 * pinned toolchain (LanguageConfig.version), linked to that language's
 * section of /judge. The link opens in a new tab so the editor is never
 * left. `href: null` renders plain text (contest arena and assessment
 * attempt surfaces pass judgeLink={false} to the workspace).
 *
 * No directive: rendered inside the client workspace, imports nothing else.
 */
export function LanguageVersion({ label, version, href }: { label: string; version: string; href: string | null }) {
  const text = formatLanguageVersion(label, version);
  if (!href) {
    return (
      <span className="ml-auto min-w-0 truncate font-mono text-text-secondary" title="Language and pinned toolchain">
        {text}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      title="Compiler version, flags and limits (opens in a new tab)"
      className="ml-auto inline-flex min-h-6 min-w-0 items-center rounded-md px-1 font-mono text-text-secondary underline-offset-2 hover:text-text hover:underline"
    >
      <span className="truncate">{text}</span>
      <span className="sr-only">: compiler version, flags and limits, opens in a new tab</span>
    </a>
  );
}
