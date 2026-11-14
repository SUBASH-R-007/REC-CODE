# REC Code — Roadmap

> ## Where this stands, 2026-11-11
>
> **Not complete — and every entry that is open is open on something this
> repository cannot supply.** Each entry below carries its own dated note;
> this is the tally.
>
> **Finished (9):** §1.1 LMS sign-in, §1.3 the join from the web app to a
> student's screen, §2.5, §2.6, §2.7, §3.1 the second factor, §3.2, §3.3,
> §3.4 field vitals.
>
> **Decided, deliberately not built (1):** §2.8 collaborative editing. The
> entry sets its own condition — *"worth doing only if mentors ask for
> it"* — and names what would reopen it.
>
> **Open, and what each one waits on (9):**
>
> | Entry | Waits on | Repository half |
> |---|---|---|
> | §1.2 catalogue | Faculty time: 437 more authored problems and a named per-term owner. **TREES, HEAPS and BACKTRACKING still have no problem at all** | Both pipelines proven; the aptitude bank built (201 questions); 12 authored problems + two-sum |
> | §1.4 topology | A second host, a registry, a certificate, an offsite pgBackRest repository, a monitoring VM | Compose, Caddyfile and alert rules written and fenced; `prom-local.mjs` generates the one config that cannot be committed |
> | §1.5 installers | **Certificates nobody has bought**, and notarisation lead time. Untouched | `electron-builder.yml` is written for signed builds; a local build says it is unsigned |
> | §1.6 mail | Real SMTP credentials, and whether the college's relay accepts the envelope | **The whole code path has now carried a message** against a loopback sink |
> | §1.7 archive | Two graduated batches surveyed, and one pass of moderation | The importer, the write and the template now exist — they did not before |
> | §2.4 interactive | **Two practice contests with real students** (SPEC §11). A date, not code | The other three kinds are lifted |
> | §3.5 capacity | The real topology (depends on §1.4) | 1,000 jobs run twice on one host, 2,000 judged, zero internal errors |
> | §3.6 assistant scan | A model configured and an `AI_API_KEY` | The spec is written and fails loudly rather than skipping |
> | §3.7 dependabot | **A named person** to read the weekly group | No code remains |
>
> So: nine done, one decided, nine waiting on people, hardware, content or a
> purchase. Nothing on this list is waiting on engineering judgement.
>
> The counts in the next paragraph are from 2026-11-09 and have moved: **125
> models, 71 migrations, five applications, 48 structural fences**, and
> `docs/RUNBOOK.md` §3 carries 123 phase-16 rows.
>
> **Added since, outside this list (2026-11-12):** §3a.1, measured growth and
> where a solution stands among the others (Phase 17) — asked for rather than
> roadmapped, and it changes none of the tally above.


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

**BUILT (Phase 16i).** Authorization code with PKCE S256 and nothing else.
`/api/auth/oidc/start` mints a state, a nonce and a PKCE verifier into three
httpOnly cookies scoped to the callback path for ten minutes;
`/api/auth/oidc/callback` spends all three on arrival whatever happens next,
compares the state **before** exchanging anything, checks the algorithm
against an allow-list of one, then the signature against the provider's
JWKS, then the claims, and only then looks for an account. A subject the
roster does not know is refused — a sign-in never creates an account — and
`/login` grows a "Sign in with REC Learning" link **under** the password
form, which is still first and still the answer for staff and for an LMS
outage. Three environment names, all or none. Discovery is refused if the
document names a different issuer. `docs/SECURITY.md` §2 has the ordering
and what it buys; `docs/RUNBOOK.md` §2.21 is how a department switches it
on; `docs/OPEN-QUESTIONS.md` records the four decisions inside it, including
the one thing this does NOT do (there is no single-logout).

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

**THE APTITUDE HALF IS BUILT (Phase 16k).** 201 questions written for this
platform, across all 29 topics, as CSVs under `apps/web/content/aptitude/`
and imported through the pipeline a faculty member uses
(`docs/RUNBOOK.md` §2.23). Every one of the six patterns now draws a full
paper twice over — proved by running the real draw for each of them on two
seeds, not by counting, because counting gets it wrong: a passage group is
drawn whole, so sixteen reading-comprehension questions in two groups of
eight cannot fill a section of six. `docs/OPEN-QUESTIONS.md` has that story.

They arrive as DRAFT with `origin` AI_ASSISTED, and a second person
publishes them — the publish action refuses the author of a question, which
is the rule that makes the review real. So what remains of §1.2 is the two
things this phase cannot do: the per-term quota with a named owner, which is
a department decision, and the 450 authored coding problems, which is the
other half of the content programme and is untouched (eleven authored, one
published).

**A hole the count hides (Phase 16t).** Twelve problems is not twelve
problems spread thinly — **four of the fourteen `TOPICS` had none at all**:
TREES, HEAPS, BACKTRACKING and DYNAMIC_PROGRAMMING. A student filtering the
catalogue by any of them met an empty page, and no number in this entry says
so. `lab-slot-plan` (REC-0013, MEDIUM, DYNAMIC_PROGRAMMING) is the first of
the four, checked against an exhaustive brute force before it was trusted
(3120/3120) and shipping a WA and a TLE reference so the tests are known to
discriminate. **Three remain empty.**

That changes nothing about the size of this entry. It is still continuous,
still the largest line item here, and still faculty time rather than
engineering time — but "which topics have nothing" is a better measure of
it than "how many problems exist", and it is the one to work down first.

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

**DONE (2026-11-10), and it was an attended afternoon rather than an hour.**
All three are green with a worker attached: the authoring journey 3/3
including its 15.2-minute walk, the keyboard journey in 49.5 s with Run
Accepted, a wrong Submit naming its failing case and a correct Submit
Accepted, and the kinds project including the contest case. The join is
proved on this deployment: web → BullMQ → worker → result → the verdict on
the page.

This entry was also RIGHT about the thing I first said it was wrong about: a
node returns from OFFLINE on its own next heartbeat, but a QUARANTINED one
does not and must be returned through `/admin/judge`. I had generalised from
one branch of `planNodeTransition`.

What the afternoon went on was not the join. It was two things that are not
the product and are now written down in `docs/RUNBOOK.md` §3: **no scheduler
running**, so a run orphaned by a server restart sat `JUDGING` and the
per-user in-flight cap of one refused every new run; and then, with the
scheduler up, its node sweep marking the node OFFLINE because `next dev`
under Playwright load cannot answer a heartbeat. Three spec defects came out
of running it, each of which would have failed a passing product on a loaded
host, and one of which — global setup writing a signed-OUT session without
complaining — had been silently possible all along.

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

**One bullet was partly code after all (Phase 16v).** "Prometheus has never
evaluated these rules against a live series" was blocked on a file that
cannot be committed, because it carries a bearer token.
`scripts/dev/prom-local.mjs` generates it outside the checkout and points
`rule_files` at `infra/monitoring/alerts.yml` **unmodified**, so what runs
is the rules CI checks rather than a copy of them.
`docs/RUNBOOK.md` §2.30 is the procedure.

Writing it found the trap in the bullet: `judge_queue_depth` and two more
gauges are the **scheduler's**, on `METRICS_PORT`, which is **0 by
default** — so a scheduler started the ordinary way publishes none of them
and five of the nine rules would report `inactive` while looking checked.

**The bullet is still open**, and so are the other three. Four of the nine
rules read exporters a laptop does not have, and a live Prometheus is a
fetch this phase deliberately did not make. What changed is that none of
what remains is repository work.

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

**The CODE half is now proved (Phase 16p), and it had never been run.** This
entry reads as pure deployment, and under it was a hole: the outbox, the
drain and `createMailTransport`'s `smtp` case had never carried a message,
because a development checkout sets `MAIL_TRANSPORT=log` and the only
alternative was a real relay with real credentials. So the part most likely
to be wrong was the part nobody could try.

`scripts/dev/mail-sink.mjs` is a loopback-only SMTP sink, and the whole path
has now carried a test email end to end: enqueue, drain, nodemailer, the
short timeouts, `MAIL_FROM`, and the page reading `sentAt` back.
`docs/RUNBOOK.md` §2.26 is the procedure.

**What stays open is exactly what this entry says and nothing more:** a real
relay. SPF, DKIM, a provider's rate limit and whether the college's mail
server accepts the envelope cannot be answered by a sink, and are a
credential and an afternoon rather than code.

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

**"The software is ready for it" was FALSE (Phase 16q), and now it is
true.** `InterviewSource.BOOTSTRAP` existed, the CHECK
`InterviewExperience_author_check` allowed a row with no author precisely so
a bootstrap row could have none, and a query knew how to label one — and
**nothing in the product wrote one.** The only write was the student's own
form, which hardcodes `source: "STUDENT"`, so the placement cell could run
the survey and then had nowhere to put it.

Built: `@recx/shared/interview-bootstrap` (the file's shape, pure),
`lib/interviews/bootstrap.ts` (the write, audited to the operator,
PENDING), `scripts/import-experiences.ts` (the importer, with `--dry-run`)
and `content/interviews/template.csv` — the header and no example row,
because a fabricated interview one copy-paste from the archive is worse
than an empty file. `docs/RUNBOOK.md` §2.28 lists every column and its
allowed values.

**What remains is exactly what this entry says it is: people.** Somebody has
to ask two graduated batches what their interviews were like, and a
moderator has to work the queue — approving is what writes a company tag,
so an unimported survey and an unmoderated one both contribute nothing. No
software is in the way of either any more.

---

## 2. Scoped, and still refused — one surface each

### 2.1–2.4 Four question kinds an assessment cannot sit — **one left**

> **Three of the four are lifted.** Output-only in Phase 16f, debugging in
> 16g, SQL in 16n+16o. Only **interactive** still refuses the pin, and it is
> blocked on a date rather than on code: SPEC §11 keeps it out of
> high-stakes papers until it has run cleanly through two practice contests,
> and no contest has been run with real students on this deployment. The
> original text follows, because what each refusal cost to lift is the
> useful part of it.

An interactive, debugging, output-only or SQL problem cannot be pinned into
an assessment. Each refusal lives in three places — a trigger on
`AssessmentProblem`, an entry in the guard catalogue, and the sentence an
admin reads before the constraint fires.

That count was wrong, and Phase 16o paid for finding out: the SQL refusal
lived in **five** places. The two the list forgot were three repository
fences requiring the removed sentence and a database test asserting the
dropped trigger still fires — and a sixth, not a refusal but the same
shape, was a `RECX_QUEUES` default that `deploy/` overrode. A rule removed
is harder than a rule added, and the honest number is "grep for it".

Phase 12p named one engine change as the blocker for all four: a language per
question, carried through the layout, the snapshot route, the submit route
and the marking. **That change has happened** (Phase 13a/13c), and it found
three real defects of one shape on the way. The refusals stood anyway,
because the language was never the whole of it — Phase 16h found that
`SENSITIVE_LANES` barred the SQL engine from ASSESSMENT **by engine**, a
clause 12p had not written down. Each was blocked on one surface:

| Kind | What it still needs |
|---|---|
| **SQL** | **Not a surface problem, and this entry was wrong (Phase 16h).** `SENSITIVE_LANES` is `["ASSESSMENT", "CONTEST"]` and `lanes.ts` bars the SQL engine from both by name — "a query's limit is the database's own `statement_timeout`" — so a SQL question in a paper would queue a submission **no node may claim**. Lifting it needs a calibration benchmark for the SQL engine, and the honest difficulty is that what CPU calibration measures does not exist for a query. A phase with a measurement question in it. **The benchmark is BUILT (Phase 16n)** and the lane is lifted: a SQL node that reports one is judged by the same rule every other node is. The measurement question was answered by asking what a calibration is FOR — not scaling a limit, but noticing that one node is slower than its neighbours — so it measures per-row throughput on the judging cluster, scored from the FASTEST of five runs because wall time is the only thing a query offers and wall-time noise is one-sided. **The surface is BUILT too (Phase 16o)**, and it was the small half: `LayoutQuestion.kind` is frozen as `SQL`, the pane offers one language and no picker with the same three `SQL_NOTICES` sentences a candidate reads in practice, Run serves it (a SQL question HAS sample datasets), and the submit route accepts `sql17` for a SQL question and ONLY for one. `AssessmentProblem_no_sql` and its function are dropped. It stayed small because three things were already true: the KIND was already a pattern (16f); the exam console already lazy-loads the practice `ResultPanel`, which has drawn a result set since Phase 12k; and the submission is created against the pinned version and the `sql17` LanguageConfig row like every other, so marking, rejudging and the standings needed nothing. Finishing it found one thing that was NOT true — the SQL node's default `RECX_QUEUES` still excluded the two lanes, which would have left an exam submission queued with nobody listening. **This row is closed.** `docs/RUNBOOK.md` §2.27 and §2.29, `docs/OPEN-QUESTIONS.md`. |
| **Output-only** | ~~An answer box rather than an editor, with `answer1` carried the same way.~~ **Built (Phase 16f):** `LayoutQuestion.kind` is frozen as `ANSWER` at start; the view renders a textarea with no picker and no Run; the submit route accepts `answer1` for an ANSWER question and only for one. |
| **Debugging** | ~~An edit budget a sitting can refuse without destroying work a candidate can no longer redo.~~ **Built (Phase 16g):** the whole hand-in is refused, not one answer — nothing finalised, the clock still running, the question named — with the budget frozen in the layout and a live count in the pane. |
| **Interactive** | **Blocked on a date, not on code (Phase 16h).** SPEC §11: "keep them out of high-stakes assessments until they have run cleanly through two practice contests" — and no contest has been run with real students on this deployment, so the condition is unmeetable before launch. The conversation surface is real work and sits second in line behind it. |

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

**NOT BUILT, as a decision (Phase 16s), and this is the one entry on this
roadmap deliberately left undone.** The reasoning, so it can be overturned
in a sentence rather than re-derived:

* this entry sets its own condition — *"worth doing only if mentors ask for
  it"* — and nobody has asked, because there are no mentors yet: the
  product has not launched;
* the platform has **no websocket infrastructure at all.** Every live
  surface here is SSE: the verdict stream, the spectate mirror, the
  invigilation feed. Yjs needs a bidirectional transport, which means a new
  deployment unit, a new authentication model for a document rather than a
  request, and a new inbound surface on a host that also runs exams. That
  is an infrastructure phase, not a feature;
* and the thing it would replace is working. The read-only mirror is
  proved against a production build, both halves.

**What would reopen it**, in order of how much it would settle: a mentor
asking for it after a real mock interview; or a mock-interview surface that
needs the interviewer to type into the candidate's editor rather than talk
over it — "fix this line for me" is the use nobody has yet reported needing.

Until one of those, building it would be building a transport for a
requirement nobody has stated, in a product where every other live surface
deliberately avoids one.

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

**BUILT (Phase 16j), to that scope exactly.** RFC 6238 TOTP with the
published test vectors asserted, so it works with an authenticator app
somebody already has. The decision the phase rests on: **no `Session` row
exists until both factors pass** — a correct password creates a
`SecondFactorChallenge` and nothing else, so every page and every action
refuses because the viewer is signed out, not because a guard remembered to
look. One code is one use, enforced by a counter the database refuses to
rewind. The secret is encrypted at rest. Ten recovery codes, sha256 only,
shown once, audited by the fact of their use. The requirement is enforced on
`requirePageRole` AND `requireActionRole`, after the role check — the action
half matters more, because an admin who never loads a page can still call an
action. Switching the policy off stops new admins being made to enrol and
does not weaken anybody who already did. `docs/SECURITY.md` §2 has the
ordering, `docs/RUNBOOK.md` §2.22 is how a department turns it on (and what
a lost phone costs), and `docs/OPEN-QUESTIONS.md` records what it does not
do — no WebAuthn, no SMS, no "trust this device", and no QR code.

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

**BUILT (Phase 16l), and the entry was half wrong about the gap.** Vitals
could not be read by cohort, and they could not be read AT ALL: the
histograms had accumulated since Phase 10d with no surface and no query.
`/super/vitals` is both halves — the p75 bucket per metric per route for a
day, the sample count behind every cell, and a cohort filter.

The privacy question was already settled here, for percentiles:
`cohortKeyFor` is the batch year and deliberately not the department,
because a department's final years can be under thirty at a small college.
So the cohort is the batch year, which answers *"is this year's intake
seeing it, or everybody?"* and **not** *"is it one lab?"* — that needs a
location signal this platform does not collect, and saying so is more useful
than a label that implies otherwise. `docs/RUNBOOK.md` §2.24 is the page,
and `docs/OPEN-QUESTIONS.md` records the decision and the residual risk.

### 3.5 Capacity has never been exercised above a 200-submission burst

`docs/CAPACITY.md` carries the real arithmetic: ~5 slot-seconds per average
submission, ~720 submissions/hour per slot, one 8-core host ≈ 700–1,000
students in an active contest, and a 5,000-student simultaneous mock needing
~21 slots ≈ four 8-core hosts, or staggered slots of 1,000–1,200 — which is
the honest operational recommendation. The measured evidence behind it is a
200-submission synthetic burst.

*Done when* a staggered 1,000-student mock has been run on the real topology
and the p95 queue waits are recorded. This depends on §1.4.

**1,000 jobs have now been run twice on ONE host (Phase 16x)** —
uniformly over 300 s and all at once — and `docs/CAPACITY.md` §6.2 C, D
and §6.2a carry the tables. 2,000 jobs judged, **zero internal errors**,
every verdict AC, and at saturation the lanes drained in exactly the
allocator's designed order.

Two things came out of it that the 200-job evidence could not show.

**The cost of RUN's hard reservation scales with the backlog.** At
saturation RUN drains early and its two reserved slots then sit idle while
PRACTICE still has a queue: 144.5 s of idle-slot time against 20.1 s in the
200-job run, about 21 % of the run's total work. That is a real number to
take to a real fleet.

**And §6.2's gate targets cannot be read across machine-states.** Re-running
the ORIGINAL 200-job profile tonight breaches two of the three targets that
the same profile met on 2026-10-10 — this laptop is measurably slower than
it was (calibration 535 M against 629 M) — so the breaches in the 1,000-job
run are not a volume effect and must not be read as one.

**The entry stays open, and is still right to.** One laptop with a dev
server on it cannot settle thresholds; it can only show that the pipeline
carries 1,000 jobs without losing or mis-judging one, which it does.
Getting to 1,000 also found three defects in the load harness itself
(Phase 16w) — it could not enqueue SQL work at all, its run marker was a
syntax error in SQL, and it counted slots a workload could never use.

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

**BUILT (Phase 16m), and NOT RUN here.** `e2e/assistant-a11y.spec.ts` and
`--project=assistant-a11y`: a super-admin switches the helper on through the
real form, the student opens the Assistant tab, the panel is scanned idle
and with an answer on screen, and it goes back off in a `finally`. With
`E2E_AI=1` a missing tab FAILS, as this entry asked.

It has not been run on this deployment, for exactly the reason the sweep
never drew the panel: no model is configured and there is no `AI_API_KEY`.
That is the remaining half of this entry and it is a deployment setting, not
code — `docs/RUNBOOK.md` §2.25 is the command, and
`docs/OPEN-QUESTIONS.md` records the state.

The "fixture" this entry asked for turned out not to exist: the control is a
select that reads back as a sentence, with a Save and an audited reason,
because Phase 15g decided turning the assistant on is not a small act. The
spec drives that form rather than the action behind it.

### 3.7 Keep CI readable now that it runs

The first CI run in eighty-three commits (2026-11-08) found two real
failures, both of which had been failing since the phase that introduced them
— unread, because nothing had been pushed. Both are fixed, and
`tests/repo/toolchain-pins.test.ts` now refuses the second one structurally.

`.github/dependabot.yml` exists and has never produced a run for the same
reason. It will start now. Someone should own the weekly group.

**No code remains (Phase 16m).** §3.7's engineering landed with
`tests/repo/toolchain-pins.test.ts`. What is left is a standing human duty —
read the weekly dependency group, and treat a major-version bump as a phase
rather than a merge — and it needs a NAMED person, which a roadmap sentence
is not. Recorded in `docs/OPEN-QUESTIONS.md` so it is asked for rather than
assumed.

The lesson worth keeping: **a gate that nobody runs is not a gate.** The
seven-step Linux gate runs on a laptop with a seeded database; CI migrates
and does not seed; the Playwright suites are in neither. Three database
suites passed here for years and covered nothing on a runner.

---

## 3a. Asked for after this roadmap was written

Section 3 above is titled for what it held on 2026-11-09. This one is for
work requested afterwards, so that nothing here is mistaken for an
enhancement nobody wanted.

### 3a.1 "What is the complexity of my solution, and where does it stand?" — **built (Phase 17, 2026-11-12)**

Two questions a student has the moment they read **Accepted**, and until
Phase 17 this platform answered neither. Both are now on
`/problems/<slug>/submissions/<id>`, under the verdict. The method, every
threshold and the argument for each is `docs/COMPLEXITY.md`; the decisions
are in `docs/OPEN-QUESTIONS.md`.

**The interesting part is the gap between what was asked for and what can
honestly be given.** The complexity of a program cannot be computed —
deciding an arbitrary program's running time is undecidable, and the
practical approximation of counting nested loops is confidently wrong about
memoisation, early exits, a library sort and every recursive function. So
nothing here reads the submitted code.

It reads the RUN. Every submission already stored one CPU-ms and one peak-KB
reading per test case, and a problem's cases come in different sizes: that is
a scatter plot, and six curves of the form `y = a*f(n) + c` are fitted to it
by least squares, the smallest residual winning. `c` is the whole reason it
works — a Python process spends 20–30 ms starting before the student's first
statement runs, and that floor is exactly what makes a naive log-log fit read
every fast solution as sub-linear.

**What it refuses matters more than what it reports.** No class below five
distinct input sizes, none below an 8x span between the smallest and the
largest, and none when the entire rise is inside the judge's own resolution
(15 ms, or 512 KB). There is no O(1) rung at all, because a flat curve means
"this could not see any growth" and not "constant time" — and the refusal
sentence says so without implying the second. **Null is the normal state**,
not an error state: on a catalogue of problems authored before any of this
existed, most submissions will carry a reason rather than a class.

Two numbers in it were measured rather than chosen, and both corrected a
first draft. The 4x residual margin that separates STRONG from WEAK comes
from generating each class's curve at four noise levels: every class except
the O(n) / O(n log n) pair separates by more than 6x even at 15% noise, while
that pair swaps places by 8% — so the margin states the true thing, that this
method tells those two apart only on very clean readings. And the model-free
log-log cross-check, as first written, marked almost every honest fit WEAK,
because a clean O(n^2) rise of 800 ms on a 20 ms floor has a raw slope of
0.77. It subtracts the winning curve's own floor now, and the independence
that costs is written into the module.

**The standing is one row per other student — their fastest accepted
submission** — on the same frozen revision, in the same language, PRACTICE
and Accepted only, and normalised by the calibration of the node that judged
each one, so a solution judged on a faster host does not read as a better
solution. Below twenty peers there is no ranking. Nothing identifying comes
back, and the db test asserts no fixture user id appears in the result.

**It never touches anything that counts.** Not a verdict, a score, XP, a
contest standing, an assessment result, a readiness component or an
eligibility decision. A slow Accepted solution is Accepted. And it widened no
fence: the input sizes of a frozen version's hidden cases are not readable
from a student-facing path, so the fit happens in `finalize.ts`, where
reading hidden test data is already the job, and what reaches the student is
the class rather than the sizes.

**What is open.** An author-declared `n` per case would be a better x-axis
than input bytes, and cannot be added to the problems that exist: a published
version and its cases are frozen by trigger. Recorded in
`docs/OPEN-QUESTIONS.md` as worth revisiting if the catalogue ever holds
enough single-number problems for the refusals to be noticeable.

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
