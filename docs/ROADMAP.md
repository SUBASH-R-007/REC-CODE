# REC Code — Roadmap

What is left, written on 2026-11-09 after reading `docs/handoff/SPEC.md`,
`docs/OPEN-QUESTIONS.md` (4,177 lines), the 55 `NOT RUN` notes in
`docs/RUNBOOK.md`, and the 130-page route surface under `apps/web/src/app`.

**The shape of the answer.** The code is close to complete against its own
spec. Every phase of SPEC §5 is built and gated, and so is every item SPEC §6
deferred to "Phase 11+" — discussion with its moderation role, SQL problems,
the interview archive, spaced revision, the explainable recommender, mock
interviews, interactive problems, the core-CS MCQ module, `rust180` and `cs8`,
the vim and emacs keymaps, debugging and output-only problem kinds, and
written answers marked against a rubric. 120 models, 66 migrations, five
applications, 48 structural fences.

What is missing is mostly **not code**. It is content, an identity
integration, a deployment, and four question kinds the spec scoped and left
deliberately refused. That distinction decides the order below: §1 is what
stands between this repository and five thousand students using it, §2 is
work the spec already described, §3 is improvement nobody has asked for yet,
and §4 is the list of things that must stay unbuilt.

Nothing here contradicts SPEC §7. Where an item touches a rule there, it says
so.

---

## 1. Launch blockers — none of these is a feature

### 1.1 LMS sign-in (OIDC) was never built

`/admin/students/import` copies identities that already exist in REC
Learning: every row needs its `lmsUserId`, and a row without one is rejected
as `MISSING_LMS_ID`. The accounts it creates have `passwordHash = null`, and
`docs/OPEN-QUESTIONS.md` records the intent plainly — they "cannot sign in
until LMS sign-in (OIDC) ships in Phase 10". Phase 10 shipped ops and
observability instead, and Phases 11a and 11f built the interim: a one-time
link, and an admin-set initial password good for exactly one sign-in.

The interim works and is well tested. It is still a second credential for
every student on a campus whose LMS is the stated source of record, and a
second password-reset path for the help desk to run. There is no `oidc`,
`openid` or equivalent anywhere in `apps/web/src`.

*Done when* a student who can sign in to REC Learning can reach
`/dashboard` without typing a REC Code password, the roster import's
`passwordHash = null` accounts are reachable that way, and the local password
path survives as the fallback for staff and for an LMS outage.

*Size:* a phase of its own. It touches the session, the roster import, the
onboarding route and `docs/SECURITY.md`.

### 1.2 The catalogue is twelve problems and no aptitude questions

`apps/web/scripts/content/index.ts` lists **eleven** authored problems, seeded
as DRAFT revision 1, plus `two-sum`, which is published. SPEC §7 says the
binding constraint on this product is "~3,600 authored problems, not code",
and it is right.

The aptitude side is starker. Six mock patterns are seeded —
`tcs-nqt`, `infosys`, `wipro`, `cognizant`, `accenture`, `campus-generic` —
and **nothing seeds a single `AptitudeQuestion`**. A pattern is sections,
timings, cutoffs and negative marking; without a bank behind it, a student
who starts a TCS-NQT mock sits down in front of structure and no questions.

The pipelines for both exist and are proven: `/admin/problems/import` and
`/admin/problems/[id]/validate` for coding, `/admin/aptitude/import` with a
CSV contract for aptitude. What is absent is the authoring programme.

*Done when* there is a per-term authoring quota with an owner, and the
aptitude bank has enough questions per `AptitudeArea` for the six patterns to
draw a fresh paper twice over. Until then, SPEC §6 is explicit about the
honest framing: show placement-cell-curated company tracks, labelled as
curated.

*Size:* continuous, and the largest single line item in this document. It
needs faculty time, not engineering time. SPEC §7 forbids sourcing it by
scraping LeetCode, GeeksforGeeks, InterviewBit or anywhere else.

### 1.3 The join from the web app to a student's screen is unproven

`isolate-integration` proves 276 cases on real sandbox boxes, and the judge
worker starts cleanly on a development machine — isolate 2.7, eleven
languages, self-check passed over twelve fixtures, calibration measured. What
has never been watched end to end is the **join**: web → BullMQ → worker →
result → the verdict appearing on the page.

`E2E_JUDGE=1` is the switch for it, and it needs a judge node ONLINE. On a
development machine `dev-judge-3` is OFFLINE, and this project's rule is that
a node's status changes on `/admin/judge` and never by SQL. So every
`E2E_JUDGE=1` step stays skipped, in CI as well.

*Done when* `E2E_JUDGE=1` runs green with a worker attached: the authoring
journey, the keyboard journey's Run and Submit, and
`problem-kinds.spec.ts`'s contest case. It is an attended hour.

*Size:* one session, with somebody present.

### 1.4 The deployment topology has never been started

`deploy/` holds `compose.app.yml`, `compose.db.yml`, `compose.judge.yml`,
`compose.sql-judge.yml`, a `Caddyfile`, `pgbackrest.conf`, the lab policy and
the exam-browser pieces. `tests/repo/deploy-topology.test.ts` asserts what a
reviewer cannot see by eye — every image pinned by digest, no published port
on the database host, every judge port bound to its monitoring address, no
credential as a value anywhere under `deploy/`.

None of it has ever run. Development happened on one Windows laptop with a
WSL2 mirror: no second host, no registry, no public hostname, no certificate,
nowhere offsite. Each file says so at the top and each has a `NOT RUN` row.
Specifically still open:

* the multi-host compose topology, started for the first time;
* pgBackRest's offsite repository — the restore drill runs locally in 67 s
  with a drift check, row counts and a blob-consistency check, and the
  offsite half cannot be run here at all;
* the monitoring VM. `promtool test rules` passes in CI, but **Prometheus has
  never evaluated these rules against a live series**;
* GlitchTip, which is configured nowhere. The code paths are there; the
  deployment is not.

*Done when* a staging environment exists on real hosts, the alert rules have
fired once from a live Prometheus, a restore has been taken from the offsite
repository, and `docs/RUNBOOK.md` carries the dates.

*Size:* an infrastructure phase. It is blocked on hardware, not on code.

### 1.5 The exam browser's installers are unsigned

`apps/exam-browser/electron-builder.yml` is written for signed Windows and
macOS builds from CI secrets that are not in this repository, and the Linux
AppImage is deliberately unsigned for lab machines on a managed image. A local
build says it is unsigned, by design.

Nobody has bought the certificates. An unsigned installer means a SmartScreen
or Gatekeeper warning on every machine a candidate installs it on, immediately
before an exam — which is the worst possible moment to ask somebody to click
through a security warning.

*Done when* the Windows and macOS installers are signed and notarised in CI
and `/exam-browser` can say so.

*Size:* small engineering, a procurement decision, and lead time.

### 1.6 No mail transport is configured

The outbox exists (`EmailOutbox`), the scheduler's sender exists
(`apps/scheduler/src/jobs/mail.ts`, `outbox.ts`), the configuration refuses
`MAIL_TRANSPORT=log` in production, and `/super/settings/integrations` says
the truth in a danger notice: *"No mail transport: security email is not
delivered."*

Password-reset links, the one-time sign-in link and the inactivity notices
therefore go nowhere. In-app notifications still go out, which is why this is
easy to miss.

*Done when* `MAIL_TRANSPORT=smtp` and an `SMTP_URL` are set for the
scheduler, the test-email button on that page has been used, and the page
shows a recent "last email sent".

*Size:* a deployment setting and one person's afternoon.

### 1.7 The interview archive is empty

SPEC §6 calls the moderated `InterviewExperience` archive load-bearing rather
than a nicety: it is the only legal and genuinely REC-specific source of
company tags and "asked at" frequency. It asks for a bootstrap — a one-time
structured collection from the two most recent graduated batches, before
launch.

The archive is built, with structured fields and no writing box, and
moderated through `/mentor/experiences`. **Nobody has collected anything.**

*Done when* the two most recent graduated batches have been surveyed into the
structured fields and the moderation queue has been worked through once.

*Size:* a placement-cell exercise. The software is ready for it.

---

## 2. Scoped, and still refused — one surface each

### 2.1–2.4 Four question kinds an assessment cannot sit

An interactive, debugging, output-only or SQL problem cannot be pinned into
an assessment. Each refusal lives in three places — a trigger on
`AssessmentProblem`, an entry in the guard catalogue, and the sentence an
admin reads before the constraint fires.

Phase 12p named one engine change as the blocker for all four: a language per
question, carried through the layout, the snapshot route, the submit route
and the marking. **That change has happened** (Phase 13a/13c), and it found
three real defects of one shape on the way. The four refusals still stand,
because the language was never the whole of it. Each is now blocked on one
surface:

| Kind | What it still needs |
|---|---|
| **SQL** | `sql17` as a key an exam accepts (it is a `SubmitLanguageKey`, deliberately outside `LANGUAGE_CATALOG`), the submission routed to the SQL engine's lane, and a result set rendered rather than a diff. A SQL question narrows its per-question set to exactly `["sql17"]`, which is the shape that would carry it. |
| **Output-only** | An answer box rather than an editor, with `answer1` carried the same way. |
| **Debugging** | An edit budget a sitting can refuse without destroying work a candidate can no longer redo — a question about *when a paper submits*, not about languages. |
| **Interactive** | A conversation surface, which the exam tree does not have and should not grow casually. SPEC §6 also keeps interactive problems out of high-stakes assessments until they have run cleanly through two practice contests, so this one is last on purpose. |

A contest needs none of this: the arena renders the problem list, the clock
and the score and links to `/problems/<slug>`, so a contest participant gets
the practice surface, which knows every kind.

*Size:* one slice each, in roughly the order above. Output-only is the
cheapest; interactive is the one to leave alone longest.

### 2.5 `/admin/discuss` — **closed as a decision (Phase 16d)**

It will not be built: a second queue over the same rows leaves one of them
stale, and moderation belongs to `TA_MENTOR` by SPEC §9.

Asking the question found the real gap, which was not a page. An ADMIN holds
every mentor capability and the admin shell linked **none** of the five
mentor pages, so a report a student filed landed in a queue only a
`TA_MENTOR` would think to visit. The admin navigation has a Mentoring group
now, moderation first.

### 2.6 `mockInterviewScore` — **sourced (Phase 16c)**

Fed from rated mock interviews: the mean of the interviewer's three 1–5
ratings, over the most recent three interviews, with a two-interview
minimum. Below that it is `NO_DATA_YET` — the student's to fix, because the
slots are bookable — and never `NO_SOURCE_YET` again.

`READINESS_RULES_VERSION` is 2 even though no weight moved, because a
version-1 score of 62 was 62 out of 85 and a version-2 one is 62 out of 100.
The "every figure carries its denominator" rule now does more work rather
than less: the denominator is a fact about the student instead of about the
platform.

### 2.7 `notifyParentEmail` — **closed, and the consent phase built (Phase 16e)**

The consent phase exists now: `ConsentRecord` per assessment, append-only,
carrying a hash of the exact words shown, checked at the start route and not
only on the page, with the named contact SPEC §6 asks for on screen. That was
the genuinely missing thing, and it closes a gap with a law behind it rather
than a preference.

The switch stays off, permanently, and for a different reason than this entry
gave. Consent was never the blocker: **the platform holds no guardian contact
of any kind, by design** — SPEC §6 minimises stored data to roll number,
name, college email, department and batch. Emailing a parent needs a parent's
address, so the feature is blocked on a policy decision the college has not
taken, not on engineering. The column and the CHECK stay.

### 2.8 Collaborative editing in a mock interview

SPEC §6 scoped the mock-interview scheduler with read-only spectate mode and
put full Yjs collaborative editing in a later phase. What is built is the
read-only mirror: the candidate pushes, the mentor's SSE stream reads. Both
halves are proved against a production build.

*Size:* a phase. Worth doing only if mentors ask for it — read-only spectate
plus a voice call covers most of what a mock interview needs.

---

## 3. Enhancements nobody has asked for yet

### 3.1 A second factor for privileged accounts

There is no TOTP or WebAuthn anywhere in the sign-in path. (The WebAuthn-
shaped code under `apps/web/src/app/api/exam/device/*` is exam device
enrolment, which is a different thing.) A single password therefore stands in
front of: impersonation, the roster import commit, result release, the
placement export, the AI provider settings, and the judge node controls.

Every one of those is audited, which is how you find out afterwards. A second
factor is how you avoid needing to.

*Scope it narrowly:* `SUPER_ADMIN` and `ADMIN` only, TOTP first, recovery
codes recorded in the audit log by the fact of their use and never by value.
Students keep a password, because 5,000 students with TOTP is a help-desk
programme, not a security improvement.

### 3.2 A student-facing problem-defect report — **built (Phase 16a)**

`ProblemReport` on the frozen revision, a quiet link under the samples, and
the queue on `/admin/problems/[id]` above the content. One open report per
student per revision; a decision is all three columns or none; the staff
answer is the sentence the student reads.

One thing changed on the way in. This entry asked for a report that could
"withhold that problem from assessment pinning while it is open", and that
is exactly what was NOT built: a report that withholds a problem by itself
hands every student a veto over the paper they are about to sit. Withholding
follows a staff member upholding the report and choosing a hold, which is the
project's rule everywhere else. See `docs/OPEN-QUESTIONS.md`, Phase 16a.

### 3.3 A mis-labelled-difficulty report — **built (Phase 16b)**

"Labels that disagree with the data" on `/admin/reports`, above "Hardest
problems", which answers a different question: a hard problem being hard is
not news.

The bands are a choice and are argued for in
`packages/shared/src/difficulty-calibration.ts` rather than asserted — EASY
flags at or below 35% solved, HARD at or above 70%, MEDIUM takes the wide
middle (15–85%), and the asymmetry is deliberate because an EASY problem
nobody finishes costs a beginner their first week while a HARD problem
everybody finishes costs a strong student an afternoon. Minimum 8 attempters
within the viewer's own scope. Every threshold lives in that one module, so
no band is repeated in a HAVING clause where it could drift from the tests
and from the sentence beside the row.

Nothing acts on a verdict: re-labelling a problem starts a new revision, and
that is an author's judgement a solve share cannot make.

### 3.4 Field vitals cannot be read by cohort

Vitals are collected with no user id, so "which students see a slow editor"
is unanswerable — recorded as such in `docs/OPEN-QUESTIONS.md`. One page load
in four reports, so a quiet day is thin, and a report is attributed to the
route the document was *loaded* with rather than the route it ended on.

Attaching a **cohort** (batch, department) rather than a user id would answer
the question that matters — "is it one lab?" — without adding anything that
identifies a student.

*Size:* small, and it has a privacy question to settle first.

### 3.5 Capacity has never been exercised above a 200-submission burst

`docs/CAPACITY.md` carries the real arithmetic: ~5 slot-seconds per average
submission, ~720 submissions/hour per slot, one 8-core host ≈ 700–1,000
students in an active contest, and a 5,000-student simultaneous mock needing
~21 slots ≈ four 8-core hosts, or staggered slots of 1,000–1,200 — which is
the honest operational recommendation. The measured evidence behind it is a
200-submission synthetic burst.

*Done when* a staggered 1,000-student mock has been run on the real topology
and the p95 queue waits are recorded. This depends on §1.4.

### 3.6 Coverage the axe run does not reach

The accessibility sweep is 260 scans over 65 pages, with `none` on every one.

One gap, not the two this document first claimed. `/super/settings/ai` **is**
scanned as a signed-in super-admin: `e2e/support/accounts.ts` makes the
`admin` account `RECADMIN01`, a SUPER_ADMIN, and the 2026-11-08 run covered
the page — which is what the Phase 15g row meant by "the next run of the
a11y suite covers this page". Corrected here rather than quietly dropped.

What is genuinely unscanned is the student assistant panel, which renders
only where the AI helper is switched on and configured, and this
deployment's is off. Scanning it needs the helper enabled for the duration
of one spec and switched back afterwards, plus a key on the server — so it
belongs behind its own flag, like `E2E_JUDGE=1`, and must fail loudly rather
than skip silently if the tab is absent.

*Size:* one spec and one fixture.

### 3.7 Keep CI readable now that it runs

The first CI run in eighty-three commits (2026-11-08) found two real
failures, both of which had been failing since the phase that introduced them
— unread, because nothing had been pushed. Both are fixed, and
`tests/repo/toolchain-pins.test.ts` now refuses the second one structurally.

`.github/dependabot.yml` exists and has never produced a run for the same
reason. It will start now. Someone should own the weekly group.

The lesson worth keeping: **a gate that nobody runs is not a gate.** The
seven-step Linux gate runs on a laptop with a seeded database; CI migrates
and does not seed; the Playwright suites are in neither. Three database
suites passed here for years and covered nothing on a runner.

---

## 4. Not to be built

Restated from SPEC §7 so that a future reader does not propose them as
improvements. These are decisions, not omissions:

* No coins, gem store, premium tier or paid tiering.
* No native mobile apps, and no serious phone-based solving experience. The
  contest arena and a proctored attempt are refused below 768px, because a
  phone-based proctored exam has no meaningful focus or fullscreen guarantees
  at all.
* No "predict your placement" feature, and no implication that the readiness
  score predicts placement.
* No ML recommender. The rule-based one explains itself; an ML one would have
  neither the data nor an evaluation harness to beat it, and could not say
  why it picked anything.
* No webcam, microphone or screen recording; no desktop agent; no content
  keylogging; no clipboard content capture; no browser-history or credential
  access; no face recognition or biometrics.
* No automatic penalty from any signal, ever. The maximum automatic
  consequence in this system is: flag for review, and withhold a result from
  the public leaderboard.
* No band or integrity score shown to a student or a recruiter.
* No scraped problem statements, editorials, test cases or company tags.
* No second XP or streak economy — the LMS's semantics are reused.
* No arbitrary third-party libraries in the judge. Compilation is offline;
  the available packages are exactly what is vendored, and adding one is a
  toolchain-image change with a new version directory.

---

## Reading order for whoever picks this up

1. `docs/handoff/SPEC.md` §0 (ground rules) and §7 (anti-requirements).
2. `docs/ARCHITECTURE.md` for the process diagram.
3. `docs/RUNBOOK.md` §3 — every gate with its date, its result and who
   verified it, including the rows that say `NOT RUN` and what would have to
   be true to run them.
4. `docs/OPEN-QUESTIONS.md` — every place the implementation reads the spec
   more narrowly than it is written, with the measurement or the reasoning
   that decided it.
5. `tests/repo/` — 48 structural fences. They are the fastest description of
   what this codebase refuses to let you do.
