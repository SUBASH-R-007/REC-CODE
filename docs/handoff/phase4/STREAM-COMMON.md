# Phase 4 Stage 2 — rules common to every stream agent

You are one of six agents building Phase 4 of REC Code in parallel, in ONE shared
working tree: C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-CODE. Other agents are
editing other files at the same time.

## Read first, in this order
1. `p4design/PLAN.md`. It is the coordinator's integrated plan, and it overrides your
   design wherever they disagree. Pay attention to the file-ownership table.
2. `p4design/FOUNDATION-REPORT.md`. It describes what the foundation stage already
   built: schema, migration, error classes, dependencies, seed users and enum mirrors.
   Build on it; do not redo it.
3. Your stream's design file (named in your task).
4. The spec sections: `p4design/../spec.txt` lines 11-17, 240-308, 364-375 and 633-697.

The `p4design` folder is
C:\Users\SUBASH\AppData\Local\Temp\claude\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\488a8ed9-9b4f-4a0f-9859-3a195105ba00\scratchpad\p4design.

## Ownership
- Create and modify only the files your stream OWNS.
- For a shared file listed for your stream, make the smallest hunk that works, and
  RE-READ the file immediately before every edit, because another agent may have
  just changed it.
- Never revert, reformat or "fix" another stream's code. If another stream's
  in-progress code breaks your typecheck or tests, say so in your report and keep
  working on your own files.
- Never touch `packages/db/prisma/schema.prisma` or the migrations. Those belong to
  the foundation stage, except that D1 owns its one SQL-only migration. If you need a
  schema change, stop and put it in your report as a request; do not make it.
- Do not run `pnpm add` or `pnpm install`. The lockfile has one writer. If you need
  a dependency, request it in your report.

## Engineering rules (violations are defects)
- **Server actions.** They live in `apps/web/src/server/actions/*.ts` with `"use server"`.
  Each one returns `ActionResult<T>` through `runAction()`. The FIRST statement inside
  the runAction callback is a guard: `requireActionUser`, `requireActionRole(...)` or
  `requireSuperAdmin()`. The input is parsed with zod. Every sensitive mutation calls
  `audit()` with an explicit sensitivity and `ipHash: await requestIpHash()`.
- **Audit metadata** holds ISO strings only, never Date objects. It never contains
  secrets, tokens, passwords, emails or disability labels.
- **Page guards.** Every page and layout under `app/admin/**` and `app/super/**` calls
  its guard itself, even though its layout also guards. RBAC is enforced server-side,
  never by hiding links.
- **Components.** Server components fetch with `db`. Client components stay leaf-level
  (`"use client"` only where interactivity requires it).
- **UI.**
  - Use the 13 primitives from `@recx/design` and its tokens.
  - No hex colour literals in `.tsx`.
  - Never convey meaning by colour alone (icon + text).
  - Every form control has a label.
  - Every scroll region gets `tabIndex=0` plus an `aria-label`.
  - Every table gets a caption or `aria-label` and `th scope`.
  - Pages work at 375 px with no horizontal page scroll.
  - Admin and super pages must never import Monaco (the size check enforces this).
- **Data.**
  - Never store a raw IP.
  - Never hard-delete a student.
  - Never aggregate XpEvent to render a page.
  - Frozen ProblemVersion rows are immutable.
  - Contests and assessments pin `problemVersionId`.
  - Student code never runs in the web process; apps/web must not import `child_process`.
- **Forbidden words.** The following must appear nowhere (code, comments, UI, tests,
  docs), not even negated: "[banned phrase 1 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 2 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 3 — see tests/repo/forbidden-words.test.ts]",
  "[banned phrase 4 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 5 — see tests/repo/forbidden-words.test.ts]".
- **Logging.** Never print or log the contents of `.env` or `.env.local`, seed passwords,
  tokens or email addresses.
- **No version control or system changes.** Do not commit or push. Do not change
  system or security settings.
- **Ask before inventing.** Implement the narrower reading and append it to
  `docs/OPEN-QUESTIONS.md` under `## Phase 4 decisions` → `### Phase 4 — <your stream>`.
  Re-read the file right before editing, append only, and create the section if it
  does not exist yet.
- **Docs.** Update only the sections your design names.

## Running things
- Run long commands in the FOREGROUND, with a timeout of up to 600000 ms. Never end
  your turn while waiting for a background task, and do not start servers.
- Windows pnpm: `npx pnpm@9.15.9 …`.
  - Typecheck a package with `npx pnpm@9.15.9 --filter <pkg> typecheck`.
  - Lint your own paths with `npx eslint <paths> --max-warnings=0`.
  - Run vitest per package, e.g. `npx pnpm@9.15.9 --filter @recx/web exec vitest run test/<file>`.
- Do NOT run `next build` or a root `pnpm build`. The integration stage builds.
- **Database tests** (`*.db.test.ts` files with `describe.skipIf(process.env.RECX_DB_TESTS !== "1")`)
  run in the WSL mirror against `recx_test` on port 5433.
  1. Write a bash script into the scratchpad.
  2. In the script, sync with `RECX_SRC=/mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE bash <(sed 's/\r$//' /mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE/scripts/dev/linux-sync.sh)`
     (no `--install`), then
     `cd ~/recx && RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@9.15.9 --filter <pkg> exec vitest run <your files>`.
  3. Run the script with `wsl -d Ubuntu -- bash "/mnt/c/Users/SUBASH/AppData/Local/Temp/claude/C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE/488a8ed9-9b4f-4a0f-9859-3a195105ba00/scratchpad/<file>.sh"`.
     PowerShell mangles inline quoting, so always use a script file.
- Database tests must use unique tags or ids, must never delete across the board, and
  must clean up their own rows.
- A judge worker and a scheduler run from the mirror. Do not stop or restart them.
  Do not run `scripts/dev/linux-gate.sh`.

## Report
Your final message goes back to the coordinator. It must contain:
- every file you created or changed, with one line each;
- your tests and their pass counts, with the exact commands;
- the typecheck and lint results for your packages and paths;
- any requests for schema changes, dependencies or another stream's file;
- any open questions you recorded;
- anything unfinished, with evidence.

Be factual. Claim nothing you did not run.
