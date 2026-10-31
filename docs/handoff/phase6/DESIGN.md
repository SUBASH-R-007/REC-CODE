# Phase 6 design: assessments and proctoring

Coordinator working notes. Delete `docs/handoff/phase6/` once Phase 6 is gated.

Source of truth: `docs/handoff/SPEC.md` §5 "Phase 6 — Assessments and
proctoring", which opens "Read this section as written. It is the part most
likely to be built wrong." This design treats that literally: the honesty
requirements are the load-bearing part, not a preamble to the engine.

## 0. What is already built

Phase 6 is not greenfield everywhere. Already in place:

- **`docs/PROCTORING.md`** — the posture, the limitations one by one, what any
  signal may cause, the controls that actually enforce, and the forbidden
  phrases. Written in an earlier phase; Phase 6 must surface its substance in
  the admin UI, and check it still covers every limitation the spec lists.
- **`ProctorEventKind`** — all 24 kinds (Phase 4 needed it for
  `Accommodation.exemptSignals`).
- **`Accommodation`** — built and gated in Phase 4, with its state machine,
  SUPER_ADMIN approval, expiry and audit. Phase 6 only has to *read* it, in
  the server-side `expiresAt` computation.
- **`tests/repo/forbidden-words.test.ts`** — already scans code, UI strings
  and docs for the five banned phrases, including in negation.

Missing: every Assessment model, and the `ProctorMode`, `AttemptStatus`,
`FlagStatus`, `Severity` and `EventSource` enums.

## 1. Key decisions

1. **The hard rule is enforced twice, and it is the first thing built.**
   `Assessment.affectsPlacementEligibility = true` REQUIRES
   `proctorMode = LAB_SUPERVISED` — a zod refinement at the server boundary
   AND a Postgres CHECK. The spec gives the reason: it stops the predictable
   drift where an admin flips a Friday quiz into a shortlisting criterion
   because it was convenient. A CHECK means that drift cannot happen even by
   raw SQL, so this lands in the first migration of the phase, before any UI
   exists to tempt anyone.
2. **No signal ever auto-penalises.** The maximum automatic consequence is
   flag for review and withhold from the public leaderboard (§0). The only
   automatic server action in the whole phase is **auto-submit at
   `expiresAt`**, which is a deadline, not a penalty. `onLimit` offers
   `autosubmit | flag_only` and nothing else — there is deliberately no
   `void` value to pick, so a future UI cannot offer one.
3. **The clock is server-authoritative, always.** `expiresAt` is computed
   server-side from the accommodation-adjusted duration and never accepted
   from a client. The heartbeat returns `msRemaining`, and the client renders
   that rather than consulting `Date.now()`. Phase 5's arena clock could be
   advisory because a late contest submission simply does not score; an
   assessment clock cannot, because the attempt ends.
4. **`ProctorEvent` is partitioned monthly from day one** (§4, Partitioning),
   by a hand-written migration. A college-wide exam adds millions of rows
   that must be droppable wholesale by `DETACH PARTITION` at the retention
   boundary. Retrofitting partitioning later is the expensive path.
5. **Covering the question beats detecting the tab switch.** The overlay on
   focus loss / visibility hidden / fullscreen exit renders in the same tick
   and covers the question *entirely*. Detection is defeatable; hiding the
   content the instant focus is lost is not, and it is what makes a second
   monitor far less useful. The `ProctorEvent` is written server-side before
   the overlay becomes dismissible.
6. **Write-ahead to IndexedDB before every network call**, and the save-state
   pill always tells the truth — including "Not saved — check your
   connection" with a "Copy my code" button. A student must always be able to
   rescue their work.
7. **No browser fingerprinting as device identity** (§7). WebAuthn is the
   device-binding mechanism; fingerprinting is unstable, trivially spoofed,
   and covert tracking is the wrong posture for a college asking students to
   trust it.
8. **IP signals are scoped to change *within* an attempt**, never sharing
   across students: thousands of students behind one campus NAT present the
   same `ipHash`, so `IP_SHARED` would be noise. Never a raw IP — `hashIp()`.
9. **The student sees their own full integrity report** within 48 hours of
   any flag, every event and every similarity match. A person accused on the
   basis of evidence is entitled to the evidence, and this is also what makes
   the 7-day two-person appeal meaningful.
10. **Every report carries the self-reported-telemetry header**, verbatim:
    "Client telemetry is self-reported by the candidate's own device. An
    absence of flags is not evidence of honesty."

## 2. Sequencing

Phase 6 is far too large for one slice. It is built in five, each one green
on all four gates before the next starts. Only the last closes the phase.

| Slice | Contents |
|---|---|
| **6a Foundation and the hard rule** | the five enums; `Assessment`, `AssessmentProblem`, `ExamSession`; the `affectsPlacementEligibility` → `LAB_SUPERVISED` CHECK and its zod refinement; `docs/PROCTORING.md` surfaced in the admin UI; the forbidden-words fence re-checked over the new copy |
| **6b The attempt engine** | `AssessmentAttempt` with its token, `expiresAt` computed server-side from the accommodation, the heartbeat route, the status machine, auto-submit at `expiresAt` (the only automatic action), `ProctorEvent` partitioned monthly |
| **6c The exam surface** | the TCS iON-shaped layout, the five-state question palette with roving tabindex, the timer announcing at exactly 10:00/5:00/1:00/0:10, the save-state pill with IndexedDB write-ahead, the covering overlay, the pre-exam readiness check that doubles as the consent moment |
| **6d Containment** | SEB key verification (server-side, the part deployments skip), WebAuthn `DeviceRegistration` with supervised enrolment and a single-use loaner path, CIDR allowlisting re-checked on every heartbeat, seat labels |
| **6e Review** | the invigilator dashboard and its SSE, `IntegrityFlag`, the mandatory human verdict with a written rationale, the student's own report, the 7-day two-person appeal, and the per-signal overturn-rate page with its documented retune trigger |

## 3. The accessibility rules that are requirements, not polish

These come straight from the spec and are easy to get wrong in an exam UI:

- the timer announces at **exactly** 10:00, 5:00, 1:00 and 0:10 and at no
  other time; never `role="timer"` with a per-second live region, which makes
  a screen reader unusable;
- the question palette is a `role="group"` of buttons with a **roving
  tabindex** and Arrow-key navigation, five states each with a distinct
  **shape + icon + full `aria-label`**, a text+icon legend and a counts row —
  never colour alone;
- the overlay is `aria-modal` with focus trapped on its single button;
- a `SCREEN_READER` accommodation **exempts focus loss and fullscreen exit**
  from penalty (§7), because assistive technology legitimately moves focus;
- the bottom bar keeps the TCS iON / AMCAT order — Previous · Mark for review
  & next · Clear response · Save & next — because an exam is the worst
  possible place to teach new muscle memory.

## 4. Tests the phase is gated on

From the spec's "Done when", plus what the design above implies:

1. a CHECK test and a zod test that `affectsPlacementEligibility` cannot be
   true outside `LAB_SUPERVISED`, through Prisma **and** through raw SQL;
2. `expiresAt` is computed server-side and never from client input, including
   with each accommodation shape applied;
3. the status machine refuses every illegal transition;
4. auto-submit fires at `expiresAt` and is the only automatic action;
5. a focus-loss event is persisted server-side **before** the overlay is
   dismissible;
6. the timer announces at exactly the four moments and no others;
7. the palette's five states each carry shape, icon and label;
8. SEB hash verification rejects absence and mismatch with an audit row;
9. a `SCREEN_READER` accommodation exempts the focus signals;
10. no signal path can reach a penalty without a recorded human verdict;
11. the forbidden-words fence stays green over all new copy.

Manual (spec): sit a full assessment as a student with a screen reader, in
each proctor mode; drop the network mid-attempt and confirm the work survives
and the pill tells the truth; confirm an invigilator cannot terminate without
a reason and a second confirmation; confirm a terminated attempt is still not
voided.

## 5. Open questions to record

- Does a `SEPARATE_ROOM` accommodation change `proctorMode` for that
  candidate, or only the seat label? Narrower reading: the seat label and the
  invigilator's roster, not the mode — changing the mode would change what
  the result may be used for.
- `ExamSession` CIDR allowlisting on every heartbeat means a lab whose NAT
  address changes mid-exam ends every session at once. Is a grace period
  wanted, or is a hard stop correct? Narrower reading: hard stop, because the
  allowlist is the actual enforcement; but it needs an invigilator override
  that is audited.
- ~~The spec puts `Accommodation` in Phase 6's list, but Phase 4 already
  built it.~~ **Checked 2026-10-19: nothing is missing.** Every one of the 14
  fields the Phase 6 shape names is on the Phase 4 model (`kinds`,
  `exemptSignals`, `extraTimePercent`, `extraTimeMinutes`, `allowBreaks`,
  `breakMinutes`, `fontScalePercent`, `allowScribe`, `highContrast`,
  `reason`, `documentFileId`, `approvedBySuperAdminId`, `grantedAt`,
  `validUntil`), and `AccommodationKind` holds exactly the six kinds it
  lists. So 6b can compute `expiresAt` from the existing model without a
  migration, and Phase 6 only ever reads it.
