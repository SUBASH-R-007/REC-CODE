import "server-only";
import { functionSignatureSchema } from "@recx/shared";
import { validateFunctionTest } from "@recx/shared/harness";

/**
 * FUNCTION tests must be exactly canonical for the signature (docs/AUTHORING.md):
 * the C++ reader accepts forms the Python and Java harnesses reject ("009",
 * "+9", "9.0" for an int, trailing text), and only a C++ model is required
 * to validate. So every way a test enters a FUNCTION revision checks it,
 * the same as a bulk import: the test editor (addDraftTests) and publish,
 * which re-checks the whole set (a signature edit can invalidate tests
 * already stored).
 */

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function utf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Problems with the given tests for a FUNCTION signature, each prefixed with
 * its label ("Test 3: …"). Empty for a non-FUNCTION revision. At most
 * `limit` messages.
 */
export function functionTestIssues(
  version: { ioMode: string; functionSignature: unknown },
  tests: readonly { label: string; input: Uint8Array; output: Uint8Array }[],
  limit = 20,
): string[] {
  if (version.ioMode !== "FUNCTION") return [];
  const signature = functionSignatureSchema.safeParse(version.functionSignature);
  if (!signature.success) return ["The function signature is invalid; fix it before adding or publishing tests."];
  const issues: string[] = [];
  for (const t of tests) {
    const input = utf8(t.input);
    const output = utf8(t.output);
    const found =
      input === null || output === null ? ["a FUNCTION test is UTF-8 text."] : validateFunctionTest(signature.data, input, output);
    for (const message of found.slice(0, 3)) {
      issues.push(`${t.label}: ${message}`);
      if (issues.length >= limit) return issues;
    }
  }
  return issues;
}
