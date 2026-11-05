# REC Exam Browser — what it is, and what it is worth

> **Status:** written before any code existed, in the same way
> `docs/PROCTORING.md` was written before the proctoring engine. Slices 14a
> to 14g have shipped, each on the repository gate; §9 says what each one
> was and what is left. Where the implementation taught us something the
> design had wrong, this document says so rather than being quietly
> corrected — §5's body hash and §3's paste block are both retractions.

---

## 1. What it is

A desktop application the candidate launches to sit one paper, which quits
when the paper is over. It bundles its own Chromium, opens the exam origin
and nothing else, and presents a per-sitting attestation the server checks
on every request.

It is **a second kiosk option beside Safe Exam Browser, not a replacement.**
Both stay. A paper is set to one of them, or to neither:

| Proctor mode | What the candidate uses | Who owns the key |
|---|---|---|
| `KIOSK_SEB` | Safe Exam Browser | a shared `.seb` configuration key |
| `KIOSK_RECX` | REC Exam Browser | a key minted for that one sitting |

SEB is the right answer for a college that already deploys it, for iPad
halls, and for anyone who would rather trust a widely audited third party
than us. REC Exam Browser is the right answer where we need capabilities a
web page does not have (§3) and an attestation worth more than a shared
secret (§5).

---

## 2. Why it lives in this repository

It is `apps/exam-browser`, a workspace package beside `apps/web`, rather
than a repository of its own. Three reasons, and one cost accepted.

1. **The contract is the product.** Everything the browser does for the
   college happens at one seam: the request it presents and the verdict the
   server reaches. That seam is a shared module — header names, the
   signature's input, the version floor — imported by both halves, exactly
   as `SEB_CONFIG_KEY_HEADER`, `verifySeb` and `sebUrlFor` already live in
   `packages/shared` and are used by `apps/web/src/lib/exam/containment.ts`.
   Across a repository boundary the same contract becomes a published
   package or a copied specification, and the first version skew refuses
   honest candidates on the morning of an exam.

2. **The fences have to reach it.** `tests/repo/proctoring-posture.test.ts`
   enforces "forbidden by name" (`PROCTORING.md` §5) by scanning
   `apps/web/src` for `getUserMedia`, `getDisplayMedia`, `MediaRecorder` and
   `navigator.clipboard.readText`. An Electron main process reaches further
   than any web page — `desktopCapturer`, global shortcuts, the real
   filesystem — so it needs those fences more, not less, and §7 adds the
   ones only a desktop application needs. In one repository that is an entry
   in a scan list. Across two it is a promise nobody can check.

3. **One gate.** The repository rule is that a slice closes only when lint,
   typecheck, test and build are green together. Both halves of a protocol
   proved in one run is the whole value of that rule.

**The cost, stated plainly:** Electron's binary makes `pnpm install` heavier
for everyone who clones this repository, including people who only touch the
web app, and signed installers release on a different cadence from a web
deploy. Mitigated by keeping the app out of the default build and size
budgets (§8), not by pretending the cost is zero.

**What would change the answer:** shipping the browser to colleges that do
not run REC Code, or releasing it on its own. Neither is true today.

---

## 3. What it can do that a web page cannot

`PROCTORING.md` §2 is a list of things a web page cannot do. A desktop
application moves some of them, and it is worth being exact about which,
because the rest of that list is unchanged.

**Genuinely gained:**

* **Its own engine, with no extensions.** Electron loads no Chrome
  extension unless the application asks, and ours never asks.
  `PROCTORING.md` §8 says "no extensions" can only be made true by owning
  the machine; it is also true of a browser the college ships, for the one
  process it runs.
* **Displays can be counted.** `screen.getAllDisplays()` is reliable, where
  `screen.isExtended` in a web page is Chromium-only and easy to falsify.
* **Capture can be refused.** `setContentProtection(true)` makes the window
  blank in most screen captures and screen shares on Windows and macOS.
  This prevents capture; it does not record the candidate, so §5 is
  untouched.
* **Its own command line is checkable.** A candidate who launches the
  application with `--remote-debugging-port`, `--load-extension`,
  `--disable-web-security` or `--inspect` is the obvious first attack. The
  application refuses to start with any of them (§7).
* **The clipboard can be emptied**, at the start of a sitting and at the
  end of it. Emptying is not reading, and nothing here ever asks what was
  in it (§4).

  What this deliberately does **not** do is block paste. The first draft
  of this document said it would, and that was wrong on the product's own
  terms: `PROCTORING.md` §2 settled the question before this application
  existed -- "paste is instrumented, not blocked", because a tool that
  types the clipboard as synthetic keystrokes walks straight past a block
  and the only person inconvenienced is the honest candidate who meant to
  move a line of their own code. The exam page already records the event
  and its size, and a paper that wants more has `refuseOutsidePaste`
  (§9 of that document), which is a per-paper decision rather than a
  property of the browser.

**Unchanged, and no desktop application changes them:**

* A phone, tablet or second laptop beside the candidate. Still the largest
  hole, still only addressed by a human in the room.
* A virtual machine or a remote desktop *hosting* the exam browser. The
  application can report what it sees, and what it sees is reported by a
  machine the candidate controls.
* HDMI splitters and capture cards.
* Everything else in `PROCTORING.md` §2.

---

## 4. What it refuses to do

`PROCTORING.md` §5 forbids six things by name. All six still hold, and a
desktop application makes three of them newly possible, which is exactly why
they are repeated here with their desktop spelling:

* no webcam, microphone or screen recording — and no `desktopCapturer`;
* **no persistence.** No service, no scheduled task, no autostart entry, no
  tray icon, no background updater, no process left running after the
  sitting. The application exists while the paper is being sat and not one
  minute longer. This is the line between an exam browser and the desktop
  agent §5 forbids, and §7 holds it;
* no content keylogging — no global keyboard hook that records what was
  typed, anywhere, ever;
* no clipboard content capture — the application clears the clipboard and
  refuses paste, and never reads what was in it;
* no access to browser history, saved credentials or profile data, and no
  reading of the candidate's files;
* no biometrics.

Two further rules that only arise once software is installed:

* **It talks to the exam origin and nothing else.** No analytics, no crash
  reporter to a third party, no update ping to anywhere but the college's
  own deployment.
* **Uninstalling it is one ordinary uninstall**, and it leaves nothing
  behind. The sitting runs in an in-memory Chromium session — a partition
  with no `persist:` prefix — so its cookies, its cache and its storage live
  in the process and die with it. Nothing about a sitting is in the user
  data directory to be left on a shared machine, which matters more from
  14g on, because the window now holds a real session cookie (§5).

---

## 5. The attestation, and why it is not SEB's

`PROCTORING.md` §2 names SEB's weakness precisely: "a configuration key
extracted from a shared `.seb` file can be used to forge its request
headers". One secret, shared by every candidate, often for a whole term. It
is the structural flaw, not an implementation bug, and we should not copy
it.

**A key minted for one sitting instead.**

1. The candidate signs in to REC Code in an ordinary browser and opens the
   readiness page for a `KIOSK_RECX` paper.
2. The server mints a **single-use launch token**, short-lived and bound to
   the attempt, the candidate and the hall.
3. The page opens `recx-exam://launch?token=…`, which starts the
   application. If it is not installed, the page says so and offers the
   installer for this platform.
4. The application exchanges the launch token, over TLS to the exam origin,
   for a **sitting key** it holds in memory only, **and for a session**. The
   token is spent; a second exchange fails and is audited.

   The session was not in the first draft, and leaving it out was the one
   mistake in this design that no test could have found. Launching the real
   application for the first time produced
   `GET /assessments/…/readiness 307` and `no cookie -> 307 /login`: the
   application is a fresh Chromium with no cookies, every exam page requires
   a signed-in user, and so the candidate would have met a password form
   inside a window with no address bar — which §6 of this document and §5 of
   `PROCTORING.md` both say must never be taught to anybody. Thirty-one
   application tests and twenty server tests passed throughout, because not
   one of them navigates.

   So the exchange issues a `Session` for the candidate the launch token was
   minted for, returns its token once, and records on the sitting row
   *which* session that was. The application sets it as a cookie on the exam
   origin **before its first navigation**, with `httpOnly`, `sameSite=lax`
   and `Secure` following the scheme. The candidate signs in once, in their
   own browser, and never types a password into the kiosk window.

   **What this costs, stated plainly.** A launch token was worth one
   sitting's attestation for five minutes; it is now worth that plus a
   session on the candidate's account for the length of the paper and four
   hours. Four things bound it, and none of them is "the token is hard to
   guess":

   * it only exists because the candidate was already signed in, in their
     own browser, when they pressed Launch — so this is not a way in from
     outside;
   * it is single use and lives five minutes, and a second exchange is
     refused and audited;
   * the session dies when the sitting ends — `endExamBrowserSitting`
     deletes the row, which is why the pointer's foreign key is `SET NULL`
     and a separate `sessionIssuedAt` records that there was one. That, and
     not the clock, is the real bound: the four hours are only what happens
     to a sitting nobody ever handed in;
   * it is `httpOnly` in an in-memory partition, so neither the page the
     candidate can script nor the disk ever holds it;
   * **it cannot renew itself.** `Session.renewable` is false on it, which
     is the second thing running the real application found. Every session
     expiring inside seven days is renewed to fourteen on use, so the expiry
     computed at the exchange became a fortnight on the kiosk window's first
     request — silently, with every test green, and with every sentence
     written here about this session's lifetime false. The renewal rule now
     lives in `apps/web/src/lib/auth/session-refresh.ts`, as a function over
     plain values with tests, rather than as three lines inside a function
     nothing could reach.

   Why four hours and not one: a session that expires while a candidate is
   still answering produces exactly the sign-in form this slice exists to
   remove, and `computeExpiresAt` applies an accommodation's extra time —
   25% on a four-hour paper is already sixty minutes, before any pause an
   invigilator grants. One hour was the first number written here and the
   arithmetic did not survive being done.

   It is also visible: the session calls itself "REC Exam Browser" on the
   candidate's own devices screen, so a sitting they did not start is
   something they can see and end themselves.
5. Every subsequent request carries a signature over the method, the URL, a
   nonce, a timestamp and the sitting id, under that sitting key, plus the
   application's version.

   The body is deliberately **not** signed, and the first draft got this
   wrong. Three exam routes parse the body before the attempt guard runs,
   and a parsed body does not re-serialise to the bytes the client hashed —
   so the server could not have checked it without reading raw text in
   every exam route. More to the point it would have been guarding nothing:
   a body hash defends against a request altered in flight, TLS already
   does that, and the adversary here holds the key and can sign whatever
   body they like. A signed field the server cannot check reads like
   protection that is not there. What makes a captured signature worth one
   request is the nonce.
6. The server verifies it in `containment.ts` beside the SEB branch, and
   refuses the sitting with `recx_browser_required` when it does not hold.

**What this buys, exactly:** a key extracted from one sitting is worth that
one sitting, which the server is already watching, rather than every paper
the college sets this term. Replay is bounded by the nonce and the
timestamp. A version below the configured floor is refused, so a known-bad
build stops being usable the day it is known.

**What it does not buy, and must never be written as if it did:** the key
lives in memory on a machine the candidate owns, and a determined candidate
with a debugger can read it and sign their own requests from somewhere
else. That is a property of all client attestation without college-managed
hardware — `PROCTORING.md` §2 says genuine device attestation exists only
on managed hardware, and that has not changed. What this design does is
raise the cost from "copy a file once" to "attack each sitting with a
debugger, while the server watches one key".

**Audit records whether attestation held, which version presented it, and
that a session was issued — never the key and never the session's value.**
Same rule as SEB, same reason: an audit row is read by people who should
not be able to use what they are reading.

---

## 6. The honest framing, which is not optional

`PROCTORING.md` §1 is the whole posture: **detection, evidence and
deterrence — never prevention.** An installed application does not change
it, and the temptation to say otherwise is strongest here, which is why
`tests/repo/forbidden-words.test.ts` scans every text file in this
repository *and every commit message* for the five phrases that overclaim.

Three specifics worth stating before anybody writes the marketing:

* **Refusing paste does not stop clipboard transfer.** AutoHotkey and
  Karabiner type the clipboard as synthetic keystrokes, and inside our
  window those are keystrokes. Refusing paste is deterrence and a cleaner
  signal; it is not a control.
* **`PROCTORING.md` §3 still governs every signal.** Nothing the exam
  browser observes may automatically penalise anybody. The maximum
  automatic consequence stays: flag the attempt for human review, and
  withhold its result from the public leaderboard. A VM report, a second
  display, a matched remote-control tool — each is a line a reviewer reads,
  never a verdict.
* **§3's other line also stands:** only `LAB_SUPERVISED` results may feed
  shortlisting, certificates or placement eligibility. A `KIOSK_RECX`
  sitting on a candidate's own laptop is better evidence than a web page,
  and it is still not a credential.

---

## 7. The fences this adds

Written here so they are built with the application rather than after it.

* **No persistence.** No `app.setLoginItemSettings`, no service or scheduled
  task installation, no tray icon, and `app.quit()` on the sitting ending.
* **No capture and no recording.** `desktopCapturer`, `getUserMedia`,
  `getDisplayMedia`, `MediaRecorder` and
  `systemPreferences.askForMediaAccess` appear nowhere in the application.
* **No global input hooks.** No native keyboard or mouse hook; the only
  accelerators are the ones registered on our own focused window.
* **Renderer privileges.** `contextIsolation: true`, `nodeIntegration:
  false`, `sandbox: true`, `webSecurity: true` and `devTools: false`,
  proved by the fence rather than by review.
* **One origin.** `will-navigate`, `will-redirect` and
  `setWindowOpenHandler` refuse anything but the configured exam origin, and
  every permission request is denied.
* **A clean command line.** The application refuses to start when argv
  carries a debugging, extension-loading or security-disabling switch.
* **`forbidden-words` and the capability catalogue extend to the new app**,
  so the posture documents stay true of it.

---

## 8. Build and release shape

* `apps/exam-browser`, package `@recx/exam-browser`, Electron with its own
  `release` script. Excluded from `pnpm size`, whose budgets are about what
  a candidate downloads over the hall's network.
* Windows and macOS installers, code-signed in CI from secrets that are not
  in this repository. Linux is an AppImage, unsigned, for lab machines that
  already run a managed image.
* The deployment serves the installers and a `latest.json` naming the
  minimum version each platform must present. `deploy/` gains a static path
  and nothing else.
* The version floor is a platform setting, so a bad build is cut off without
  a redeploy.

---

## 9. Phase plan

Each closes on the repository gate, recorded in `docs/RUNBOOK.md` §3.

| Slice | What lands |
|---|---|
| 14a | The protocol in `packages/shared`: headers, signature input, version floor, verdicts — with its tests, and no application yet. |
| 14b | Server side: `KIOSK_RECX` on `ProctorMode`, the launch-token model and migration, the `containment.ts` branch, audit. |
| 14c | The application: window, origin lock, argv refusal, the launch handshake. |
| 14d | The measures of §3, each with its fence, and the proctor events they emit. |
| 14e | Readiness and admin surfaces: launching, installing, the version floor, what the examiner chooses. |
| 14g | The sitting carries its own session, so the window never meets a sign-in form — what launching the real application found (§5). |
| 14h | The sitting is bound to the attempt at start, and ends with it. Until this lands a `KIOSK_RECX` paper cannot be sat: the containment check reads the expected sitting off the attempt, and nothing writes it. |
| 14f | Packaging, signing, the installer path in `deploy/`, and the runbook for a hall. |
