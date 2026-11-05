# REC Exam Browser — what it is, and what it is worth

> **Status:** the posture, written before any code exists, in the same way
> `docs/PROCTORING.md` was written before the proctoring engine. Nothing
> here is implemented yet. The phase plan is §9.

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
* **Paste can actually be refused.** Not merely instrumented. Read the
  honesty note in §6 before believing this is worth much.

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
  behind.

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
   for a **sitting key** it holds in memory only. The token is spent; a
   second exchange fails and is audited.
5. Every subsequent request carries a signature over the method, the URL, a
   hash of the body, a nonce and a timestamp, under that sitting key, plus
   the application's version.
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

**Audit records whether attestation held and which version presented it,
never the key.** Same rule as SEB, same reason.

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
| 14f | Packaging, signing, the installer path in `deploy/`, and the runbook for a hall. |
