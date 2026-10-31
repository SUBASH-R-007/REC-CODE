# Phase 12k — SQL problems

Design, written before any Phase 12k code, after reading the judging
pipeline it has to join. The spec sentence this implements is in
`docs/handoff/SPEC.md` §6 (Phase 11+): *"SQL problems (per-submission
ephemeral Postgres schema, read-only role, `statement_timeout = 5s`,
result-set comparison, PostgreSQL dialect only, stated on the problem
page)"*.

## 0. Why this one gets a design document

Every Phase 12 feature so far has been additive: new tables, new pages, new
policy modules, and nothing that the judging pipeline had to notice. This
one is different in two ways that make a careless version worse than none.

1. **It adds a second kind of judge.** Everything that judges today is one
   fleet of isolate nodes consuming five BullMQ queues. SQL is judged by a
   different engine with different credentials, and the pipeline's
   invariants — the lease, the attempt cap, the protocol version, "never
   retry a deterministic verdict", "no node holds database credentials" —
   all have to keep meaning the same thing afterwards.
2. **It is the first feature whose sandbox is a database.** SPEC's
   anti-requirements are explicit: *"Do not give the judge host DB
   credentials, AUTH_SECRET, an object-storage master key, or student
   PII"*, and *"Do not run student code in the Next.js process, a server
   action, a route handler, or any container holding `DATABASE_URL`"*.
   Student SQL **is** student code. It must run in a process that holds no
   application credentials, against a cluster that holds no application
   data.

SPEC also says, in the same breath as listing it: **"Deferred — do not
half-build these."** So this document's job is to say what "whole" means
before anything is written, and to mark honestly which parts this
development machine can prove.

## 1. What a SQL problem is, from the student's side

A SQL problem has a schema, some rows, and a question. The student writes
one `SELECT` (or a statement whose result is a relation) and submits it.
The verdict compares their **result set** against the reference one, per
case, the same way every other problem compares output against expected
output.

Decisions, each with its reason:

- **PostgreSQL 17 only, and the problem page says so.** Not "SQL". A
  dialect-neutral problem is a problem nobody can state the limits of, and
  a student who learned MySQL deserves to be told which dialect they are
  being judged in rather than finding out from a verdict.
- **One statement per submission.** The sandbox executes exactly one
  statement; a submission with two is rejected at the boundary with a
  sentence saying why. Multi-statement submissions would make "the result
  set" ambiguous, and they are the obvious way to try to write.
- **Read-only, and the database enforces it rather than a parser.** The
  per-submission role has no write privilege on anything; the transaction
  is `READ ONLY`. A blocklist of `DROP|DELETE|UPDATE` in the submission
  text is the wrong fence (comments, casing, `do $$`, CTEs) and the right
  one costs nothing.
- **Ordering is the problem author's choice, per case.** `ORDER BY` in the
  question means ordered comparison; without it, rows compare as a
  multiset. The authoring form asks, because "unordered" silently
  accepting a wrong `ORDER BY` is as bad as "ordered" failing a correct
  answer.
- **Column names are compared, types are coerced to text.** A student
  writing `count(*)` and an author writing `count(*) AS n` should not be a
  WA; a student returning `1` where the answer is `'1'` should not be an AC
  by accident. The rule: the column COUNT and the row data must match
  after a canonical text cast; column NAMES are reported in the diff but
  do not decide the verdict. (`SELECT *` column order is the author's
  responsibility, as it is in every other judge.)
- **Five seconds, enforced by `statement_timeout`.** A query that takes
  longer is TLE. Not a Node-side timer: the database is the only thing that
  can stop its own query.
- **The result the student sees is a table, not a stdout diff.** Sample
  cases render as a small table with the expected one beside it; hidden
  cases say "row 3 of 12 differs" and nothing else, exactly as hidden test
  output is dropped today.

## 2. Where it joins the pipeline, and what has to change

Read first, so the plan is against the code rather than a memory of it:
`apps/web/src/lib/judge/{queue,claim,submit-schema}.ts`,
`apps/web/src/app/api/judge/{claim,blob,result,heartbeat,release}/route.ts`,
`packages/shared/src/protocol.ts`, `apps/judge-worker/**`,
`apps/scheduler` (the reconciler), and the `Submission` / `JudgeNode` /
`LanguageConfig` / `ProblemVersion` models.

What that reading established:

- **The queue, not the claim, decides who judges a job.** `claimJob()`
  leases by id with no language or driver condition; the worker learns of
  a job from BullMQ. So an isolate node WOULD claim a SQL submission if it
  sat in `judge-practice`. SQL therefore needs **its own queues**, one per
  lane, named `judge-sql-<lane>`, and `enqueueJudge()` must choose the
  family from the problem rather than from a parameter a caller could
  forget. (Chosen over "one queue, workers refuse what they cannot run":
  a refusal counts an attempt, and three refusals would fail the job.)
- **`JudgeNode` already has `driver` (default `"isolate"`) and
  `languages`.** A SQL node registers with `driver: "postgres"` and
  `languages: ["sql17"]`, so the fleet page, the heartbeat, the lease
  reclaim, the calibration-free lanes and the OFFLINE sweep all work
  unchanged. `/admin/judge` must show the driver, because "why is this
  node not taking my C++ submission" is the first support question.
- **The protocol version has to go to 4.** `judgeJobSpecSchema` is
  isolate-shaped (compile, memory, argv). A SQL job needs a different
  spec. Two options were weighed: a union (`spec.engine: "isolate" |
  "postgres"`) or a second schema behind the same route. **Union**, because
  the routes, the lease, the result shape and the version check are all
  the same machinery and a second route would duplicate the parts that
  must not drift. Bumping to 4 makes every v3 worker drain itself (HTTP
  426), which is exactly the documented behaviour for a protocol change.
- **The result shape barely changes.** `testResultSchema` already carries
  `{i, v, ms, kb}` with optional `stdout`/`message`; a SQL case reports
  `kb: 0`, `ms` as the query's own duration, and the diff goes in
  `message` for visible cases only. No new result table, no row per case,
  as SPEC requires.
- **`Submission` needs no new column.** `languageConfigId` points at a
  `LanguageConfig` with `key: "sql17"`, whose `runtime` JSON holds the
  SQL engine's parameters instead of argv. That keeps every existing
  query, the daily CPU budget, the leaderboard, XP, contests and
  assessments working with no change at all — which is the whole argument
  for joining the pipeline rather than building beside it.

## 3. The data model

A SQL problem is a `Problem` with a `ProblemVersion` like any other, so
the catalogue, tags, company tags, revision cards, discussion, bookmarks
and the recommender all keep working. What is new is the version's content:

```
ProblemVersion
  ioMode              -> new value SQL (enum extension, additive)
  sqlSetupSha256      -> blob: the schema + seed rows, one script
  sqlDialect          -> "postgres17" (the only value; stated, not inferred)
  sqlOrdered          -> Boolean, per version default for cases
  (tests)             -> each TestCase gains an expected RESULT SET blob
                         instead of an expected stdout blob; same bundle,
                         same immutability, same sha256 discipline
```

**Checked against the fences before writing any of this, because Phase
12g died on exactly this question.** `IoMode` is a Prisma enum, so adding
a value is `ALTER TYPE ... ADD VALUE` — additive, and no guard is
dropped. The three catalogued CHECKs that mention `ioMode` or
`compareMode` (migration `20261010100100_function_comparator_checks`) are
all scoped by `"ioMode" <> 'FUNCTION'` or `"compareMode" <> 'CHECKER'`
rather than enumerating the enum's domain, so a version with
`ioMode = 'SQL'` satisfies every one of them unchanged. **Phase 12k is
therefore not blocked the way 12g was**, and the aptitude taxonomy's
problem stays what it is: its CHECKs enumerate `(area, topic)` pairs in
the body, and this one's do not.

New CHECKs this phase adds (all additive, all catalogued): a frozen SQL
version names its setup blob and its dialect; `sqlDialect` is
`'postgres17'`; and a version is SQL exactly when it has a setup blob, so
a half-authored SQL problem cannot publish.

The authoring side (Phase 4's problem authoring, `/admin/problems`) gains:
the setup script, per-case datasets (or "all cases share the setup"), the
reference query, and a validation run that executes the reference against
the sandbox and stores its result set as the expected one — authors do not
type expected rows by hand, for the same reason they do not type expected
stdout.

## 4. The sandbox

One PostgreSQL cluster, separate from the application's, holding no
application data and reachable only by the SQL judge:

- a database per judge process (`recx_sql_judge`), and **a schema per
  submission** (`job_<claimToken>`), created at claim and dropped in a
  `finally`;
- the setup script runs as a role that owns only that schema;
- **(slice 2 changed this, and the reason is in `docs/OPEN-QUESTIONS.md`)**
  the student's statement runs as ONE fixed read-only role on its OWN
  connection rather than a fresh role per job: a role is a cluster-wide
  object, creating one needs `CREATEROLE` in the judge, a crash would leak
  roles, and a role holds no state, so "fresh" bought nothing. What does
  the work is the separate connection — there is no privileged
  `session_user` to go back to — plus a role that is a member of nothing;
- the student's statement runs as that read-only role with
  `search_path` pinned to the job schema, `statement_timeout = 5s`,
  `idle_in_transaction_session_timeout`, no `pg_read_file`, no large
  objects, no `COPY ... PROGRAM`, no FDW, and no network access from the
  cluster host;
- `pg_stat_statements` off for the sandbox (a student's query text is
  their work and does not belong in a shared view);
- the judge holds ONE credential: `SQL_SANDBOX_DATABASE_URL`. It never
  holds `DATABASE_URL`, `AUTH_SECRET`, `IP_HASH_PEPPER` or an object-store
  key, and `tests/repo/` gains a fence that says so the way
  `judge-dependencies.test.ts` does for the isolate worker.

Why a schema per submission rather than a database per submission: creating
a database is ~100 ms and leaves a template lock; a schema is a few
milliseconds and `DROP SCHEMA ... CASCADE` is complete. Why not a
transaction rollback instead of a drop: a rolled-back transaction leaves
temp files and does not stop a student's `CREATE TEMP TABLE` from being
visible to the next job in the same session — a pooled connection is the
"warm container" mistake SPEC names, in a different shape.

## 5. What this machine can prove, and what it cannot

Buildable and verifiable here (WSL2 has PostgreSQL 17 already):

- the whole data path: authoring a SQL problem, publishing it, submitting
  a query, the verdict, the diff, XP, the leaderboard, a contest, an
  assessment;
- the sandbox's isolation, as tests: a submission that tries to write, to
  read another schema, to read `pg_authid`, to open a file, to run two
  statements, to `COPY ... PROGRAM`, to spin for ten seconds, to allocate
  a terabyte of `generate_series`, and to leave a temp table behind for
  the next job;
- the ephemeral schema's lifecycle, including a job killed mid-query
  (schema still dropped) and a job whose lease expired (no second schema).

Not provable here, and each gets a NOT RUN row:

- two judge fleets on two hosts at once (isolate and SQL) under a real
  contest load;
- the sandbox cluster's own hardening on a host that is not this laptop
  (`listen_addresses`, `pg_hba`, resource limits, a separate OS user).

## 6. Slices, each ending green

1. **Protocol and policy.** `JUDGE_PROTOCOL_VERSION = 4`, the spec union,
   the SQL comparison rules as pure functions in `@recx/shared`
   (canonicalisation, ordered and multiset comparison, the diff), the
   refusal copy, and the dialect notice. Unit tests only; nothing else
   moves.
2. **The sandbox service.** `apps/sql-judge`: BullMQ consumer, claim,
   blob fetch, the schema lifecycle, the read-only role, the timeouts,
   the result post. Its own tests against the local cluster, including
   every isolation case above.
3. **The model and authoring.** The migration, the guard-catalogue
   entries, the authoring form, the validation run that produces the
   expected result sets.
4. **The student surface.** The SQL editor language, the dialect notice,
   the table diff, the one-statement refusal, and the submission path.
5. **Ops and docs.** `/admin/judge` showing drivers, the compose/deploy
   topology, RUNBOOK (how to start the sandbox, how to rotate its
   credential, what to do when a schema is left behind), CAPACITY, the
   alert rules, SECURITY, ARCHITECTURE, OPEN-QUESTIONS, and the gate rows.

Each slice closes with the four gates green, because the gate rule in
SPEC §0 does not relax for a phase that happens to be large.

## 7. The line this phase still must not cross

The enum question above is answered: nothing here needs a guarded CHECK
dropped. The rule stands anyway, for whatever the slices turn up:
`packages/db/test/frozen-coverage.test.ts` has no allowlist on purpose,
and a migration that wanted one would be a human's decision recorded in
`docs/OPEN-QUESTIONS.md` — not a line this phase crosses quietly to fit a
feature. Phase 12g is the precedent: a question bank was given up rather
than a fence.

Two more lines, from SPEC's own anti-requirements, restated because they
are easy to lose in slice 2:

- **No pooled connection reuse across submissions.** A warm connection is
  the "pooled warm containers for untrusted code" mistake in a different
  shape: a student's temp table, a `SET`, a prepared statement or an
  advisory lock would outlive their job. One connection per job, closed in
  a `finally`, and the schema dropped with it.
- **No retry of a deterministic verdict.** A query that was refused, timed
  out or returned the wrong rows is judged, not retried. Retries are for
  the cluster being unreachable, and they are the pipeline's existing
  three attempts rather than anything new here.
