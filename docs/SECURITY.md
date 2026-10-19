# REC Code — Security

The controls that exist today, the ones that are planned, and the findings
accepted deliberately. Each control names the file that implements it; if
the two disagree, the code is right and this document is a bug.

**Security contact:** _to be named by the college_. Until then, report a
suspected vulnerability privately to the repository owner, never in a
public issue.

---

## 1. What is being protected, and from whom

| Asset | Main threat |
|---|---|
| Assessment and contest integrity | students submitting hostile code; students attacking the web app; a compromised judge host forging results |
| Student data (names, roll numbers, results) | account takeover; injection; data leaving through logs or a judge host |
| Credentials and secrets | leaked `.env` files; secrets committed to git; a judge host holding more than it needs |
| The audit trail | an insider rewriting history |

Student code is the most hostile input in the system. It never runs in the
web process — `apps/web` cannot import `child_process` (lint and
`tests/repo/judge-isolation.test.ts`) — and is judged only on separate,
credential-free judge hosts (§6).

---

## 2. Authentication

* **No public sign-up.** Accounts come from the LMS roster (the identity
  source of record) or the development seed.
* **Passwords: Argon2id, m=19456 KiB, t=2, p=1** (the OWASP minimum),
  via `@node-rs/argon2` (`apps/web/src/lib/auth/password.ts`). Minimum 10
  characters with at least one letter and one number.
* **No user enumeration by timing.** A sign-in for an unknown account is
  verified against a real Argon2id hash of a random string, so both paths
  cost the same.
* **Sign-in rate limits:** 5 attempts per account and 20 per hashed client
  IP per 15 minutes, as a Redis sliding window shared by every web instance
  (`apps/web/src/lib/rate-limit.ts`). If Redis is unreachable the limiter
  fails open with a logged warning — refusing every sign-in during a Redis
  outage would turn a cache failure into a full outage — and the Argon2id
  cost still bounds guessing speed.

### The sign-in flow

`/login` is a server-rendered page with no JavaScript
(`apps/web/src/pages/login.tsx`, `docs/ARCHITECTURE.md`); its form is a
plain `POST` to `/api/auth/login` (`apps/web/src/app/api/auth/login/route.ts`,
logic in `apps/web/src/lib/auth/sign-in.ts`; tested in
`apps/web/test/login-route.test.ts`).

* **Login CSRF.** The handler refuses a cross-site post before it reads the
  body: `Sec-Fetch-Site` must be `same-origin`, or, without Fetch Metadata,
  `Origin` must match `Host` (`apps/web/src/lib/help/same-origin.ts`). The
  session cookie is `SameSite=Lax` on top (§3).
* **Bounded input.** Only an `application/x-www-form-urlencoded` body of at
  most 16 KiB is read (the form's largest legitimate body is under 10 KiB);
  anything else is answered as a missing field without touching the
  database. Zod then bounds the identifier (254) and password (1,024).
* **Every answer is a `303 See Other`** with a relative `Location`. Success
  goes to `homeForRole(role)` — a fixed path per role, never a URL taken
  from the request, so there is no open redirect. Failure goes to
  `/login?error=<code>`; the page maps the code to its message
  (`apps/web/src/lib/auth/sign-in-errors.ts`), so nothing a third party puts
  in a link is echoed: an unknown code shows the plain form, `retry` must be
  a whole number of minutes and `ref` must have the support-reference shape.
  Every credential failure (unknown account, wrong password, an account
  without a password) is the same code, `credentials`; an inactive account
  is named only to someone who proved the password.
* **The identifier is never in the URL.** The roll number or email typed
  before a failure is carried in `recx_login_id` — `HttpOnly`,
  `SameSite=Lax`, `Path=/login`, `Max-Age=60`, `Secure` in production — and
  the page clears it as soon as it reads it (shared lab machines); React
  escapes it back into the field.
* **Unexpected errors** go to `/login?error=unavailable&ref=<id>`; the same
  reference is in the server log line.
* **Unchanged from before:** the per-account and per-IP rate limits run
  before Argon2id; unknown and password-less accounts are verified against
  the decoy hash (equal timing); failures on a real account are audited
  (`auth.login_failed`, `SECURITY`) and successes too (`auth.login`).
* **Session rotation.** A successful sign-in deletes whatever session the
  browser carried and mints a new token (§3) before redirecting.

## 3. Sessions

Server-side sessions in Postgres (`apps/web/src/lib/auth/session.ts`), not
JWTs, so an administrator can end a session mid-assessment.

* The cookie `recx_session` holds a random 256-bit token; the database
  stores only its **sha256**. A database read does not yield usable cookies.
* Cookie flags: **`HttpOnly`**, **`Secure` in production**,
  **`SameSite=Lax`**, `Path=/`.
* 14-day expiry, renewed when less than 7 days remain; `lastSeenAt` is
  written at most every 5 minutes.
* `destroyAllSessions(userId)` force-logs-out every device. An account that
  is not `ACTIVE` or `SOFT_RESTRICTED` is treated as signed out on its next
  request, whatever cookie it holds.

## 4. Authorisation and input

* **RBAC is server-side.** Every page calls a guard and every action calls
  `requireActionUser()` / `requireActionRole(...)` / `requireSuperAdmin()`
  from `apps/web/src/lib/auth/guards.ts`. Hiding a link is not access
  control.
* **Zod at every server boundary:** server actions, route handlers, the
  judge protocol (`packages/shared/src/protocol.ts`) and the environment
  (`apps/web/src/lib/env.ts`, `apps/judge-worker/src/config.ts`,
  `apps/scheduler/src/config.ts`).
* **Source size** is capped at 256 KB by zod at submit and by a database
  `CHECK` constraint. Each student may have at most 2 submissions and 1 Run
  in flight at a time.
* Problem statements are rendered from Markdown by `marked` (raw HTML is
  escaped) and then filtered through an allow-list with `sanitize-html`
  (`apps/web/src/lib/markdown.ts`).

### Role × capability matrix

Who may do what is one data module, `apps/web/src/lib/auth/capabilities.ts`.
Every server action, every `/admin` and `/super` page, every admin and
super route handler and every mutating API route belongs to exactly one
capability, or to one of the named lists below the table. Capabilities come
in three tiers:

* **super-admin:** the spec's twelve. Only SUPER_ADMIN holds them. The
  ones wired in a later phase bind nothing until then.
* **staff:** ADMIN and SUPER_ADMIN. AdminScope then narrows which students
  an ADMIN can see or change; that narrowing is data, not a role.
* **self-service:** any signed-in user, acting only on their own rows.

Two tests keep the map honest:

* `apps/web/test/capabilities.test.ts` is a static check that parses the
  code with the TypeScript compiler API. It reads each action's real guard,
  which is the first statement of its `runAction` body. It reads the guard
  modules (`lib/auth/guards.ts`, `lib/auth/scope.ts`) to work out which
  roles that guard admits. Those roles must equal the capability's roles,
  in both directions. The same check covers pages and routes. Any export
  that is unbound or bound twice fails the test.
* `apps/web/test/capability-matrix.test.ts` runs the real guards. It calls
  every bound action, route and page once per role and once signed out:
  * A denied caller gets exactly the Forbidden or Unauthorized result, or
    a redirect to its home page (or to `/login`). This happens before any
    database access, audit row or enqueue.
  * An allowed caller gets past the guard.
  * An impersonating SUPER_ADMIN gets the read-only refusal on every
    mutation.

The table below is generated from the code. A test fails if it drifts; to
regenerate it, run `RECX_UPDATE_DOCS=1` with the capabilities test.

<!-- capability-matrix:start -->
| Capability | Tier | STUDENT | TA_MENTOR | ADMIN | PLACEMENT_OFFICER | SUPER_ADMIN | Bound to |
| --- | --- | :---: | :---: | :---: | :---: | :---: | --- |
| `roles.manage` | super-admin | - | - | - | - | yes | 3 actions, 1 page |
| `settings.write` | super-admin | - | - | - | - | yes | 4 actions, 3 pages |
| `accounts.status` | super-admin | - | - | - | - | yes | 3 actions, 1 page |
| `problems.lifecycle` | super-admin | - | - | - | - | yes | 4 actions |
| `ratings.manage` | super-admin | - | - | - | - | yes | 1 action |
| `integrity.overturn` | super-admin | - | - | - | - | yes | 1 action, 1 page |
| `audit.readFull` | super-admin | - | - | - | - | yes | 1 action, 1 page |
| `users.impersonate` | super-admin | - | - | - | - | yes | 1 action, 1 page |
| `judge.rotateKeys` | super-admin | - | - | - | - | yes | 1 action, 1 page |
| `pii.export` | super-admin | - | - | - | - | yes | 1 action, 1 route, 1 page |
| `calendar.manage` | super-admin | - | - | - | - | yes | arrives in Phase 8 |
| `xp.void` | super-admin | - | - | - | - | yes | 1 action, 1 page |
| `integrity.review` | staff | - | - | yes | - | yes | 2 actions, 2 pages |
| `exam.invigilate` | staff | - | - | yes | - | yes | 4 actions, 1 route, 2 pages |
| `exam.device.enrol` | staff | - | - | yes | - | yes | 1 action, 1 route, 1 page |
| `judge.operate` | staff | - | - | yes | - | yes | 3 actions, 1 page |
| `students.view` | staff | - | - | yes | - | yes | 5 pages |
| `students.signOut` | staff | - | - | yes | - | yes | 1 action, 1 page |
| `roster.import` | staff | - | - | yes | - | yes | 3 actions, 2 pages |
| `plans.manage` | staff | - | - | yes | - | yes | 11 actions, 6 pages |
| `contests.manage` | staff | - | - | yes | - | yes | 4 actions, 3 pages |
| `announcements.manage` | staff | - | - | yes | - | yes | 3 actions, 3 pages |
| `accommodations.request` | staff | - | - | yes | - | yes | 2 actions, 3 pages |
| `problems.author` | staff | - | - | yes | - | yes | 18 actions, 4 pages |
| `problems.validate` | staff | - | - | yes | - | yes | 2 actions, 1 page |
| `problems.review` | staff | - | - | yes | - | yes | 3 actions |
| `problems.publish` | staff | - | - | yes | - | yes | 1 action |
| `problems.import` | staff | - | - | yes | - | yes | 1 action, 1 route, 2 pages |
| `judge.submit` | self-service | yes | yes | yes | yes | yes | 2 actions |
| `drafts.save` | self-service | yes | yes | yes | yes | yes | 1 action, 1 route |
| `activity.record` | self-service | yes | yes | yes | yes | yes | 1 route |
| `exam.heartbeat` | self-service | yes | yes | yes | yes | yes | 4 routes |
| `exam.device.assert` | self-service | yes | yes | yes | yes | yes | 1 route |
| `integrity.appeal` | self-service | yes | yes | yes | yes | yes | 1 action |
| `notes.manage` | self-service | yes | yes | yes | yes | yes | 4 actions |
| `contests.enter` | self-service | yes | yes | yes | yes | yes | 2 actions |
| `bookmarks.manage` | self-service | yes | yes | yes | yes | yes | 1 action |
| `help.reveal` | self-service | yes | yes | yes | yes | yes | 2 actions |
| `notifications.manage` | self-service | yes | yes | yes | yes | yes | 2 actions |
| `plans.enroll` | self-service | yes | yes | yes | yes | yes | 3 actions |
| `profile.manage` | self-service | yes | yes | yes | yes | yes | 1 action |

Not capabilities: 11 SUPER_ADMIN supporting actions (`admin-judge#grantJudgeQuotaOverride`, `admin-accommodations#approveAccommodation`, `admin-accommodations#rejectAccommodation`, `admin-accommodations#revokeAccommodation`, `privileged#approvePrivilegedOperation`, `privileged#selfApprovePrivilegedOperation`, `privileged#rejectPrivilegedOperation`, `privileged#cancelPrivilegedOperation`, `super-data#requestSubmissionPurge`, `super-branding#previewBrandTheme`, `super-integrations#sendTestEmail`), 3 supporting pages (`app/super/page.tsx`, `app/super/jobs/page.tsx`, `app/super/settings/integrations/page.tsx`); impersonator only: `super-impersonate#endImpersonation`; public: `auth#logout`, `app/api/auth/login/route.ts#POST`.
<!-- capability-matrix:end -->

## 5. Browser hardening

### Content-Security-Policy

Set per request by `apps/web/src/middleware.ts` (unit-tested in
`apps/web/test/csp.test.ts`):

* **`script-src 'self' 'nonce-<per-request>' '<sha256 of the theme script>' 'strict-dynamic'`.**
  A fresh 128-bit nonce per request; Next stamps it on its own scripts.
  The one inline script (applying the stored light/dark theme before first
  paint) is allow-listed by its **content hash**, so it carries no nonce;
  a test recomputes the hash and fails on any drift. `'strict-dynamic'`
  lets the nonce'd loader pull in its chunks and the self-hosted Monaco
  modules. Development adds `'unsafe-eval'` for hot reload only.
* `default-src 'self'`, `connect-src 'self'`, `img-src 'self' data: blob:`,
  `font-src 'self' data:`, `worker-src 'self' blob:` (Monaco's language
  workers), `frame-src 'none'`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-ancestors 'none'`, and
  `upgrade-insecure-requests` in production.

**Accepted low-severity finding: `style-src 'self' 'unsafe-inline'`.** This
is deliberate. Once `style-src` carries a nonce (or a hash), browsers ignore
`'unsafe-inline'`, and then every React `style` attribute (progress bars,
avatars, resizable panels) and the styles Monaco injects at runtime are
blocked — nonces cannot apply to style attributes. The cost: an attacker who
could already inject markup could restyle the page. Injected CSS cannot run
script, and CSS-based exfiltration is limited because images, fonts and
connections are all restricted to `'self'`. Revisit if React and Monaco stop
needing inline styles.

### Other headers

From `apps/web/next.config.ts`: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
and `Permissions-Policy: camera=(), microphone=(), geolocation=(),
display-capture=()`. The `X-Powered-By` header is off.

## 6. Judge isolation

Summarised here; the full account is `docs/JUDGE.md`.

No sandbox can be proven impossible to escape: kernel CVEs touching
namespaces, cgroups, eBPF and io_uring appear several times a year. The
documented guarantee is blast-radius containment on a disposable,
credential-free judge host, continuously re-verified by the self-check
suite.

* IOI isolate 2.7 boxes (separate namespaces and cgroup, uid 60000+box, no
  network, read-only system directories, RAM box root, syscall
  restrictions), one fresh run box per test.
* Judge hosts hold **no database URL, no auth secret, no storage master key
  and no PII**. The node token (stored server-side as sha256) can only
  heartbeat, claim a job, fetch that job's blobs while its lease is live,
  post its result and release it.
* Egress is allow-listed to the app host and Redis; sandbox uids are
  dropped explicitly; cloud instance metadata is blackholed
  (`infra/judge/nftables.conf`). Kernel hardening, module blacklist and
  late module lock: `infra/judge/sysctl/`, `infra/judge/modprobe/`,
  `infra/judge/verify-host.sh`.
* Expected output never enters a box and is never returned for a hidden
  test. Input secrecy is best-effort only (`docs/JUDGE.md` §8).

## 7. Privacy

* **Never a raw IP.** Wherever an address is kept (sessions, audit log,
  rate-limit keys) it is `sha256(ip + IP_HASH_PEPPER)` (`hashIp()` in
  `apps/web/src/lib/ip.ts`). `X-Forwarded-For` is trusted only when
  `TRUST_PROXY=true` (behind Caddy).
* Hidden-test output is dropped at the web boundary even if a worker sends
  it; visible-case detail is capped and purged after 30 days.
* Proctoring (Phase 6) collects no webcam, microphone or screen recording by
  default and no content keystrokes or clipboard contents; see
  `docs/PROCTORING.md`.

## 8. Audit log

Every sensitive mutation calls `audit()` (`apps/web/src/lib/audit.ts`), which
never throws (auditing must not break the operation) but logs any failure
loudly.

* Rows are appended to a **per-UTC-day hash chain**:
  `hash_n = sha256(hash_{n-1} + "\n" + canonical(entry_n))`, with
  `hash_0 = sha256("recx-audit-genesis:" + day)` and object keys sorted
  recursively (`packages/db/src/audit-chain.ts`, re-exported by
  `apps/web/src/lib/audit-chain.ts`, unit-tested). Writers for
  the same day serialise on a Postgres advisory lock.
* This is **tamper-evident, not tamper-resistant.** Editing or deleting a row
  breaks every later link of that day. But a database superuser can rewrite
  a whole day and recompute its chain, and nothing detects that until the
  day's terminal hash has been exported off the machine. Exporting terminal
  hashes off-box is planned (Phase 10); until it ships, the chain detects
  edits by anyone who does not also recompute it, and nothing more.
* The append code lives in `@recx/db` (`packages/db/src/audit.ts`,
  `audit-chain.ts`) so the scheduler can audit too (impersonation expiry,
  privileged-operation expiry, failed security email); `@/lib/audit` keeps
  its API and adds `auditMany()` (several rows, one transaction, one lock).
* **Metadata holds ISO strings, never `Date` objects** (a `Date` hashes as
  `{}` but is stored as a string, so its row would fail verification), and
  never secrets, tokens, passwords, email addresses or disability labels.
* `/super/audit` verifies any day on demand with the same arithmetic, a page
  of rows at a time (`audit.chain_verified`, NORMAL; a break is recorded as
  `audit.chain_break_detected`, SECURITY).

## 8a. Super-admin governance (Phase 4)

The `/super` tree is a separate layout with a persistent "Super-admin — all
actions are audited" strip. The twelve SUPER_ADMIN-exclusive capabilities
are one exported constant (`apps/web/src/lib/auth/capabilities.ts`); a
static test proves every action it names starts its `runAction` body with
`requireSuperAdmin()`, and a runtime test calls every listed action as every
role. Every `/super` page calls `requireSuperAdminPage()` itself.

### Read-only impersonation

* A super-admin may view the platform as one user, **read-only**, for at
  most **15 minutes**, with a mandatory reason (20–500 characters). Never a
  `SUPER_ADMIN` target, never yourself, only an `ACTIVE` or
  `SOFT_RESTRICTED` account. The target is not notified.
* It is a row (`ImpersonationSession`) plus a pointer on the super-admin's
  own `Session`. The database fixes the 15-minute box, refuses
  self-impersonation, never extends, reopens or deletes a row.
* `getCurrentUser()` re-checks every request (window, impersonator still an
  ACTIVE SUPER_ADMIN, the `impersonation` flag, the target's status) and
  ends it (`EXPIRED` / `REVOKED`) the moment one fails.
* **Read-only is enforced in `requireActionUser()`**, which every action
  guard and every mutating route handler goes through: it throws
  `ImpersonationReadOnlyError` while the pointer is set. The one action
  that works is `endImpersonation` (guard `requireImpersonator()`). A
  repository test sweeps every server action under impersonation.
* Start and end are SECURITY audit rows. Exactly one path writes the end
  row (a conditional update on `endedAt IS NULL`): the user ending it, sign
  out (`SIGNED_OUT`), a failed re-check, or the scheduler's sweep.
* A full-width banner shows on every surface while it lasts.

### Two-person approval (PrivilegedOperation)

* Bulk status changes over 25 accounts, submission purges, global
  rejudges, PII exports and problem/version deletions are **requested** by
  one super-admin and **approved** by another within **24 hours**. Rating
  recompute joins in Phase 5.
* The target set is resolved when the request is made (a filter becomes an
  id list) and hashed (`payloadSha256`); the approver approves that digest.
* The database enforces it again: requester ≠ approver unless the row is
  flagged break-glass (CHECK), the 24-hour window (CHECK and trigger on the
  database clock), immutable request fields, the status machine, no DELETE.
* Executors run in batches and re-check their rules (never your own
  account, never the last active super-admin, frozen problem revisions are
  retired, never deleted; purges are refused under legal hold).

### Break-glass

* The requester may self-approve in an emergency, with a justification of
  at least 20 characters, while the `breakGlassSelfApproval` flag is on.
* It is **allowed, never quiet**: a SECURITY audit row
  (`privileged.break_glass`), an in-app notification and a queued email to
  **every ACTIVE super-admin**, written in the same transaction as the
  approval.

### Security email (outbox)

* Mail is queued in `EmailOutbox` inside the transaction that causes it and
  sent by the scheduler (`MAIL_TRANSPORT`: `smtp`, `log` in development
  only, refused in production, or `disabled`). Rows name the recipient by
  user id; the address is read at send time and is never stored in the row,
  logged or audited. Errors are stored with addresses and URLs masked.
* After 8 failed attempts a `security.*` email is `FAILED` and
  SECURITY-audited (`email.delivery_failed`). With no transport, rows wait
  and `/super` shows a danger alert; the in-app notifications always go out.

### PII export and judge keys

* A PII export holds only a minimised column set, is generated at download
  time and never stored: the requester only, within 24 hours, at most 3
  downloads (a conditional database increment), each a SECURITY audit row,
  `Cache-Control: no-store`, formula-escaped CSV.
* A judge-node token rotated from `/super/settings/judge` is shown once and
  never stored, logged or audited; only its sha256 is kept.

## 9. Secrets

* **Nothing secret is committed.** `.env` and `.env.*` are gitignored
  except `*.env.example`, which contain only placeholders and
  development-only values (every development credential is named
  `…-dev-only`).
* Each process gets only what it needs: the judge worker has no database
  credentials; the scheduler uses the direct database URL; only the web app
  holds `IP_HASH_PEPPER`.
* Judge node tokens and session tokens are stored only as sha256 hashes.
  On a judge host the node token lives in `/etc/recjudge/worker.env`
  (root, 0600); after first boot the host's cloud-init copies of user-data
  are deleted and the metadata service is blackholed.
* Compose and CI use development-only credentials and never touch a
  deployment.

## 10. Dependencies and supply chain

* `pnpm install --frozen-lockfile` in CI: the lockfile is the only source of
  versions. `engine-strict` pins Node 22.
* Security-relevant components are pinned exactly and verified: isolate by
  tag **and** commit; toolchains by GPG signature **and** sha256; Node.js on
  judge hosts by the official `SHASUMS256.txt`; Monaco `0.52.2` (self-hosted,
  no CDN); Prisma `6.16.2`.
* Adding a dependency needs a reason in review; prefer the platform and
  existing packages.

---

## 11. Planned (Phase 10)

Not in place today. Listed so nobody assumes otherwise.

| Item | What it adds |
|---|---|
| **OIDC sign-in** via the LMS | single sign-on; passwords become a fallback |
| **sops + age** | encrypted deployment secrets in the repository, decrypted only on the target host |
| **Rate limits everywhere** | today only sign-in is rate-limited (submissions and Runs have per-user in-flight caps); Phase 10 covers every action and route handler, including `/api/judge/*` |
| **Dependabot** | automated dependency and GitHub Actions update PRs |
| Audit terminal-hash export | ships each day's terminal hash off-box, closing the superuser gap in §8 |
| Redis ACLs for judge nodes | limits a node's Redis user to the queue keys and progress channels |

## 12. Accepted findings

| Finding | Severity | Why accepted | Revisit when |
|---|---|---|---|
| `style-src 'unsafe-inline'` | Low | §5: a style nonce would break React style attributes and Monaco | React/Monaco no longer need inline styles |
| A superuser can rewrite an audit day before export | Medium | §8: needs off-box export | Phase 10 export ships |
| Hidden-test input secrecy is best-effort | Medium for assessments | a program is handed its input | per-attempt test data for assessments |
| A compromised judge host can forge results for jobs it claims | Medium | the residual risk of any remote judge; contained to claimed jobs | rejudge-on-second-node for assessments |
| Sign-in rate limiter fails open when Redis is down | Low | §2: availability over strictness, Argon2id cost still applies | — |
