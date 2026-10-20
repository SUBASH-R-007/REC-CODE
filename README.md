# REC Code

The coding practice, contest and proctored-assessment platform of
**Rajalakshmi Engineering College** — built for ~5,000 students. Solve
problems in C++ or Python in the browser, see each test judged live, and
build toward contests and assessments that count.

REC Code is a separate application from REC Learning (the college LMS): same
stack and design language, its own database, and the LMS remains the source
of record for who the students are.

**Status: Phase 1** — sign-in, the problem workspace (Monaco editor, Run and
Submit), and the judge: IOI isolate sandboxes on credential-free judge
hosts, live per-test progress, verdicts that never rely on colour alone.

---

## Principles

* **Student code never runs in the web process.** It is judged only inside
  isolate boxes on separate judge hosts that hold no database credentials
  and no student data ([docs/JUDGE.md](docs/JUDGE.md)).
* **Postgres is truth; Redis is transport.** A Redis restart loses queue
  position and zero submissions.
* **Honest claims.** The judge provides layered containment on disposable
  hosts, because no sandbox can be proven impossible to escape. Proctored
  assessments are monitored and recorded; no browser software prevents
  cheating, and REC Code never says it does
  ([docs/PROCTORING.md](docs/PROCTORING.md)).
* **No automatic penalties.** The most any signal can do is flag an attempt
  for human review and keep it off the public leaderboard.
* **Accessible by construction.** Every verdict and difficulty carries an
  icon and text, never colour alone ([docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md)).

## Repository layout

pnpm 9 workspace · Node 22 · TypeScript (strict) · Next.js 15 · React 19 ·
Tailwind v4 · Prisma 6 + PostgreSQL 17 · Redis 7 + BullMQ 5 · IOI isolate 2.7.

| Path | What it is |
|---|---|
| `apps/web` | Next.js app: pages, server actions, the `/api/judge/*` protocol for judge nodes, submission/run SSE streams. The only process with database credentials. |
| `apps/judge-worker` | The judge. Claims jobs, runs them in isolate, posts results. No database, no secrets beyond its node token. |
| `apps/scheduler` | The reconciler (every 10 s) and judge-node sweep. |
| `packages/shared` | `@recx/shared` — verdicts, the limits table, the language catalog, the judge wire protocol (zod), the FUNCTION-mode harness, output sanitiser. |
| `packages/db` | `@recx/db` — Prisma schema, migrations, the guarded client (web and scheduler only). |
| `packages/design` | `@recx/design` — design tokens, UI primitives, `VerdictBadge`, theme derivation. |
| `infra/judge` | Judge host provisioning: isolate install, toolchain builds, kernel hardening, firewall, systemd unit, cloud-init. |
| `scripts/dev` | Local services in WSL2 and the Linux mirror sync. |
| `tests/repo` | Repository-wide rules (single-source definitions, judge isolation, forbidden wording). |
| `docs` | Everything below. |

## Quick start (Windows + WSL2)

The full procedure, with troubleshooting, is in
[docs/RUNBOOK.md](docs/RUNBOOK.md) §1. In short:

```bash
# In WSL2 (Ubuntu 24.04), from the checkout under /mnt/c/...
sudo bash scripts/dev/wsl-services.sh            # Postgres 17 on :5433, Redis 7, Node 22
sudo bash infra/judge/install-isolate.sh         # isolate 2.7 + RAM box root
sudo bash infra/judge/toolchains/build-all.sh    # GCC 13.2.0, CPython 3.12.6 (slow, once)
```

```powershell
# On Windows, in the checkout
npx pnpm@9.15.9 install
# copy apps/web/.env.example → apps/web/.env.local, apps/judge-worker/.env.example
# → apps/judge-worker/.env.local, and the Prisma lines of .env.example → packages/db/.env;
# fill in the empty secrets
npx pnpm@9.15.9 db:migrate
npx pnpm@9.15.9 --filter @recx/web exec tsx --conditions=react-server scripts/seed.ts
npx pnpm@9.15.9 dev                              # http://localhost:3000
npx pnpm@9.15.9 scheduler:dev
```

The judge worker runs in WSL2, in the native mirror `~/recx`:

```powershell
wsl -d Ubuntu -- bash -lc 'RECX_SRC=/mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE bash <(sed "s/\r$//" /mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE/scripts/dev/linux-sync.sh) && cd ~/recx && pnpm --filter @recx/judge-worker dev'
```

(Use your own checkout path. On machines where Docker works,
`docker compose up -d` replaces `wsl-services.sh`.)

## The gate

A phase closes only when all four are green on **Windows and Linux**:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

On Windows, run each as `npx pnpm@9.15.9 <script>`. Linux-only extras:
`RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 pnpm test` (database tests against
`recx_test`, and Redis) and
`RECX_ISOLATE_INTEGRATION=1 pnpm --filter @recx/judge-worker test:integration`
(the real sandbox). CI runs all of it on every push
([.github/workflows/ci.yml](.github/workflows/ci.yml)); results of each
gate are recorded in the RUNBOOK's Gate log.

## Documentation

| Document | Read it for |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | processes, packages, the judge pipeline, data-model principles |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | the rules every change follows |
| [docs/JUDGE.md](docs/JUDGE.md) | the sandbox, limits, verdicts, toolchains, guarantees and non-guarantees |
| [docs/SECURITY.md](docs/SECURITY.md) | authentication, sessions, CSP, audit log, secrets, accepted findings |
| [docs/PROCTORING.md](docs/PROCTORING.md) | what browser proctoring can and cannot do (engine: Phase 6) |
| [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) | WCAG 2.2 AA, colour-independent verdicts, stated exceptions |
| [docs/CAPACITY.md](docs/CAPACITY.md) | judge slot planning (planning figures until Phase 2) |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | local development, operations, the Gate log |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | decisions taken where the specification was ambiguous |

## Licence

MIT — see [LICENSE](LICENSE).
