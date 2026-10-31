# REC Code — Proctoring: what it can and cannot do

> **Status:** the proctoring engine ships in **Phase 6**. This document is
> the posture it will be built to, written first so the limits are agreed
> before any code exists. Nothing here is implemented in Phase 1.

---

## 1. The posture

Browser-based proctoring is **detection, evidence and deterrence — never
prevention.** A proctored REC Code assessment is **monitored and recorded**.
It is never described, in the product, in documentation or to students, as
something that prevents cheating, because no web page can.

What a web page can do is record what it observes, make that record
tamper-evident, and put it in front of a human reviewer. What it observes is
reported by the candidate's own browser, on a machine the candidate
controls. Every limitation below follows from that one fact.

**The actual enforcement is environmental** (§4): who is in the room, whose
machine it is, and which network it is on.

---

## 2. Limitations, one by one

Each of these is a property of browsers and operating systems, not a gap
that more engineering will close.

**Focus and visibility can be spoofed.** A browser extension's content script
that runs at `document_start` executes before any page script. It can
redefine `document.visibilityState`, `document.hidden` and
`document.hasFocus()`, and stub `addEventListener` so `blur` and
`visibilitychange` listeners never fire. It wins that race by specification,
every time.

**A page cannot enumerate extensions.** `chrome.management` is available to
extensions only. Probing `web_accessible_resources` detects only extensions
that expose a known resource; a purpose-built extension exposes nothing and
reveals nothing.

**A private window cannot be required, and would not help.** A page cannot
detect one: there is no API, Chrome treats private-mode detectability as a
leak and has closed each one found, and the heuristics that survive
misreport Guest mode and some ordinary profiles — so a sitting gated on it
would refuse honest candidates at random. Nor is a private window
extension-free: *Allow in incognito* is a per-extension toggle, two clicks
and no restart, and developer-mode unpacked extensions ignore the question
entirely. §8 and `deploy/lab-policy/` cover what does work.

**Fullscreen cannot be enforced.** Entering fullscreen needs a user gesture
and Esc always exits; that is a browser guarantee to the user. The best a page
can do is request it, detect the exit, record it, warn, and allow a 10-second
grace period to re-enter.

**Blocking copy and paste does not stop clipboard transfer.** Tools such as
AutoHotkey or Karabiner type the clipboard's contents as synthetic
keystrokes, which a page cannot tell from typing. So paste is
**instrumented, not blocked**: the event and its size are recorded (never its
content), and blocking it would only inconvenience honest candidates.

**Devtools detection is unreliable in both directions.** Size heuristics and
debugger timing produce false positives (docked panels, zoom, slow machines)
and are trivially defeated (undocked or remote devtools). It is weighted
near zero.

**Multiple monitors cannot be reliably detected.** `screen.isExtended` is
Chromium-only, needs no permission to be absent, and is easy to falsify; its
absence means nothing.

**Remote and virtual setups are invisible.** Virtual machines, remote
desktops (RDP, Parsec, Chrome Remote Desktop), HDMI splitters and capture
cards are undetectable from a web page.

**A second device is the largest hole.** A phone, tablet or second laptop
beside the candidate is undetectable by any browser software. Only a human
in the room addresses it.

**Telemetry is self-reported by the adversary.** Every signal comes from the
candidate's own browser. Flag counts are therefore **not evidence of guilt**,
and an empty report is **not a clearance**.

**Typing-cadence analysis cannot tell cheating from legitimate behaviour.**
Bursts of fast, steady input look the same whether they come from a
transcribed answer or from fast typing, editor autocomplete, snippets,
speech-to-text, or a solution first drafted on paper.

**Safe Exam Browser is the strongest realistic lockdown, and it is still
bypassable.** It runs only on Windows, macOS and iOS; a configuration key
extracted from a shared `.seb` file can be used to forge its request
headers; and SEB running inside a virtual machine, or beside a second
device, still works as normal.

**Genuine device attestation exists only on college-managed hardware:**
managed Chrome or ChromeOS with Verified Access and a force-installed
college extension, or a locked lab image. On a student's own device there is
no attestation; Chrome's Web Environment Integrity proposal was abandoned.

**WebAuthn proves less than it seems.** It proves that an enrolled
authenticator was present and unlocked. It does not prove the device is
unmodified, that it is the only device in use, or who is typing.

**IP/CIDR allowlisting** is defeated by a VPN or a phone hotspot outside a
lab. Inside a lab it is useful the other way round: it detects a machine
leaving the lab network.

**Similarity detection cannot establish direction or intent.** It can show
that two submissions are alike; it cannot show who copied whom, or whether
anyone did. A miss against the comparison corpus is not evidence of
originality. Short canonical problems (reverse a string, two-sum) have high
legitimate similarity, and their thresholds must reflect that.

**Editor snapshots are the most probative artefact — and still not proof.**
A periodic record of the editor's contents shows how a solution developed
(incrementally, or appearing whole). It informs a reviewer's judgement; it
does not replace it.

**Every threshold starts as an engineering guess.** Every threshold in the
engine is initial engineering judgement with **zero calibration data**. The
retune loop — reviewers' decisions fed back into the thresholds — and
reporting of the **overturn rate** (how often reviewers clear what the
engine flagged) are load-bearing parts of the design, not afterthoughts.

---

## 3. What any signal may cause

**No signal ever automatically penalises a student.** The maximum automatic
consequence anywhere in REC Code is:

> **flag the attempt for human review, and withhold its result from the
> public leaderboard.**

Review has a **72-hour SLA**. If no reviewer has acted by then, the result
is published automatically as **CLEARED**. Every decision a reviewer makes
is recorded in the audit log with its reason.

**Only `LAB_SUPERVISED` results may feed shortlisting, certificates or
placement eligibility.** A result obtained anywhere else — however clean its
telemetry — is practice evidence, not a credential.

---

## 4. The controls that actually enforce

Recommended for any assessment whose result matters:

1. **A supervised lab on college-managed machines** — a locked image, or
   managed Chrome/ChromeOS with the force-installed college extension.
   `deploy/lab-policy/` is the browser half of this as installable files,
   and `docs/RUNBOOK.md` §2.14 installs and verifies it per hall. §8 says
   why this is the only place "no extensions" can be made true.
2. **An `ExamSession` CIDR allowlist re-verified on every heartbeat**, so a
   machine that leaves the lab network is flagged at once.
3. **Safe Exam Browser in kiosk mode, with server-side verification of its
   configuration key** on every request.
4. **Seat mapping:** each candidate's machine is recorded against a seat, so
   a reviewer can see who sat where.
5. **A physical invigilator in the room.** The only control that addresses
   a second device.

---

## 5. Forbidden by name

The engine will never include, enable by default, or quietly add:

* webcam, microphone or screen recording by default;
* desktop agents (installed software on the student's machine);
* content keylogging — keystroke *timing* metadata at most, never what was
  typed outside the editor;
* clipboard content capture — paste events and sizes only;
* access to browser history or saved credentials;
* face recognition or any other biometrics.

`apps/web/next.config.ts` already denies the camera, microphone, geolocation
and display-capture permissions to every page (`Permissions-Policy`), so
none of these can be switched on without a deliberate, reviewed change.

---

## 6. What is proctored, and what is not (Phase 11b)

**Only an assessment is.** The engine is attached to an
`AssessmentAttempt` and nothing else: `IntegrityFlag` hangs off one, a
proctor mode belongs to an `Assessment`, and the telemetry client runs on
the exam surface alone.

**A contest is not proctored, and that is a decision rather than an
omission.** A contest has no proctor mode, the arena emits no telemetry,
and no contest result can be flagged. Three reasons:

1. Nobody is told they are being watched in a contest, and §1 means that
   literally — a monitored sitting is announced as monitored. Adding
   collection without disclosure would break the first promise in this
   document.
2. A contest is practice with stakes, and the product never treats its
   output as a credential. The signed student export says so in its own
   words: readiness "is not a prediction of job performance, and REC Code
   does not use it to decide who may sit a drive".
3. The controls that make an assessment worth proctoring — a supervised
   lab, a managed machine, an invigilator in the room — are exactly what a
   contest does not have. Browser signals without them produce a queue of
   flags nobody can act on, which costs students queue position and buys
   nothing.

`tests/repo/proctoring-posture.test.ts` holds that line: it fails if the
contest surface starts collecting proctoring telemetry, so the decision
cannot be reversed quietly.

**Practice is not proctored either**, for the same reasons and more
plainly: there is nothing at stake but the student's own record.

## 7. The vocabulary says who produces it

Twenty-five signal kinds are declared. Which of them the product actually
produces is written down in code —
`CLIENT_EMITTED_KINDS`, `SERVER_DERIVED_KINDS` and `RESERVED_EVENT_KINDS`
in `packages/shared/src/exam-telemetry.ts` — and they partition the
vocabulary, with a test that fails if they stop doing so.

This exists because of what an audit found in Phase 11b: **seven declared
kinds were produced by nothing at all**, and nothing said so. A reviewer
could not tell a signal that was absent because the candidate did not
trigger it from one that was absent because the product never emits it, and
those mean opposite things. The worst case was `SNAPSHOT_JUMP` — the
heaviest substantive signal in the triage engine, the one §5 of SPEC calls
"the most probative artefact" and "the one piece of evidence that survives
client tampering". Its derivation was written and tested in Phase 6, and
never called. Every exam before Phase 11b was reviewed without it.

Five of the seven now have producers: `FIRST_KEYSTROKE`, `IDLE_GAP`,
`NETWORK_DROP` and `CLIENT_SCRIPT_ERROR` from the exam client, and
`SNAPSHOT_JUMP` derived at submit, when the final solution — which the rule
is a share of — first exists. `INVIGILATOR_NOTE` gained one too: an
invigilator can now record what they saw against the attempt, which the
control §4 rates highest previously had no way to do.

Two are reserved, with their reasons in the code:

* `DEVTOOLS_HEURISTIC` — unreliable in both directions (§2). A signal that
  fires because a student zoomed to 150 % to read the question is worse
  than no signal.
* `SUBMISSION_RATE_ANOMALY` — a sitting submits once, at the end, so an
  attempt has no submission rate for anything to be anomalous about.

Neither an invigilator's note nor a rate anomaly may raise a triage band:
both are in `CONTEXT_ONLY_KINDS`. A human's sentence belongs in front of
the human who decides, not inside the arithmetic that decides for them.

---

## 8. The browser is not the control (Phase 11c)

The question this section exists to answer, because it is the one everybody
asks: *can proctor mode require an incognito window, so no extensions can
be plugged in?*

**No, and the reason is worth understanding, because it is the same reason
most proctoring ideas fail.** Three separate walls, any one of which is
enough:

1. **The page cannot tell.** There is no API for private mode. Chrome
   treats detectability as a leak and has closed each one found — the
   FileSystem probe in Chrome 76, the storage-quota probe after it — and
   what survives is a version-specific heuristic that reports Guest mode
   and some ordinary profiles as private. Gating a sitting on it would
   refuse honest candidates at random on the morning of the exam.
2. **A private window is not extension-free.** *Allow in incognito* is a
   per-extension toggle: two clicks, no restart. Developer-mode unpacked
   extensions, a second profile and `--load-extension` ignore the question
   altogether.
3. **The page cannot see extensions at all** (§2), in either kind of
   window. So there is nothing to verify even if the first two walls fell.

The pattern: **what the candidate's browser reports about the candidate's
browser is not a control.** It is self-reported by the adversary, which §2
already says about every signal we collect, and a *gate* built on a
self-reported value is strictly worse than a *signal*, because when it is
wrong it stops an honest student from sitting the paper rather than merely
adding a line a reviewer can discount.

**What does work is owning the machine.** `deploy/lab-policy/` holds a
managed-browser policy for a college lab machine — `chrome-policy.json` for
Linux and ChromeOS, `recx-exam-policy.reg` for Windows — and
`docs/RUNBOOK.md` §2.14 has the install and the per-hall verification.
`ExtensionInstallBlocklist: ["*"]` is the real version of "no extensions",
and it holds because the college, not the candidate, owns the policy file.
Chrome Sync is disabled in the same policy, which is the part people miss:
without it, a Google sign-in reinstalls the candidate's own extension set
on arrival and the blocklist was theatre.

Two things that follow, and are easy to get backwards:

* **The policy disables private windows rather than requiring them.** What
  the incognito idea actually wants is a clean browser for the next
  candidate, and `ClearBrowsingDataOnExitList` does that properly. Private
  mode's own hazard is real: a window closed by accident takes the
  candidate's session with it and makes them sign in again against a
  running clock.
* **This is operations, not product.** Nothing in the exam client detects,
  requires or reports the window type, and `tests/repo/proctoring-posture.test.ts`
  fails if a private-mode or extension-sniffing heuristic appears in
  `apps/web/src` — the same fence that keeps `getUserMedia` out. A control
  the college can install and an invigilator can verify at
  `chrome://policy` does not need the product to guess at it, and the guess
  would cost honest students their sittings.

None of this is a claim about the sitting. The policy raises the cost of
the easy routes on one machine. The phone on the candidate's lap is
untouched by all of it, and §4's last line still holds: the human in the
room is the control that matters most.
