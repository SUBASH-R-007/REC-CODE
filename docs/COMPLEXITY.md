# Measured growth, and where a solution stands (Phase 17)

A student who has just read **Accepted** asks two more questions, and until
Phase 17 this platform could answer neither:

1. *What is the complexity of what I wrote?*
2. *Is it any good, compared with everyone else's?*

This document is what the answers are, what they are not, and why each
threshold is the number it is. It is the reference for
`packages/shared/src/complexity.ts`,
`packages/shared/src/solution-standing.ts`,
`apps/web/src/server/queries/solution-standing.ts` and the `measureComplexity`
half of `apps/web/src/lib/judge/finalize.ts`.

---

## 1. The one thing to understand first

**Nothing here reads the submitted code.** Deciding the running time of an
arbitrary program is the halting problem in a different hat, and the
practical approximation — count the nested loops — is confidently wrong about
memoisation, early exits, a library sort, a short-circuit, a hash map that
degrades, and every recursive function. A platform that printed `O(n²)`
because it saw two `for` statements would be teaching students something
false about their own programs, which is worse than saying nothing.

What this reads is **the run**. Every submission already stores one CPU-ms
and one peak-KB reading per test case (`Submission.testResults`), and the
test cases of a problem come in different sizes. That is a scatter plot, and
a scatter plot can be fitted.

So the claim this platform makes is precise and small:

> Over the cases this run passed, its time grew like *this curve*.

It is a **measurement with a confidence**, never a proof. The student-facing
copy says so in the first sentence of the section, every weak fit says so
beside itself, and when the readings cannot carry a claim the answer is a
refusal with a reason rather than a guess.

---

## 2. The method

For each metric (time, then memory) and each candidate class, fit

```
y = a · f(n) + c
```

by ordinary least squares, where `y` is the case's reading, `n` is the size
in bytes of the input that case was given, and `f` is the class's own shape.
Both unknowns are linear in the parameters, so each candidate is one
closed-form two-parameter fit: no iteration, no local minima, no seed. The
candidate with the smallest residual sum of squares wins. Every candidate has
the same two parameters, so comparing residuals directly is fair and needs no
AIC-style penalty.

The ladder: **O(log n), O(√n), O(n), O(n log n), O(n²), O(n³)**.

`c` is not a nuisance term; it is the reason this works at all. A Python
process spends 20–30 ms starting before the student's first statement runs,
and a C++ process reports about 2 MB of peak memory before `main`. That
constant floor is exactly what makes a naive log–log regression read every
fast solution as sub-linear. Here it is a fitted parameter, and the growth is
measured on top of it.

### Why there is no O(1) rung

Because a flat curve does not mean constant time — it means *this could not
see any growth*. Those are different statements and only the second one is
true, so a flat reading is reported as a refusal
(`GROWTH_BELOW_NOISE`) whose sentence deliberately does not mention
constant time.

### Why there is no exponential rung

An O(2ⁿ) solution does not produce a curve. It passes the small cases and is
killed by the time limit on the first case big enough to matter, and a killed
case is not a measurement of anything. What such a student sees is a TLE and
the growth over the cases that *did* finish — which is the true and useful
half of the answer.

### Which cases become samples

Only cases whose verdict is **AC**. A case killed at the time limit reports
the limit rather than the work; a case that crashed reports where it died; a
wrong answer may have taken a shortcut past the work the curve is supposed to
describe. A curve fitted through any of those describes the judge's limits.

This is also why the feature is useful on a **TLE**: with
`stopOnFirstFailure` the earlier cases did finish, and the growth measured
over them is precisely the evidence for why the next one did not.

### Repeated sizes

Two cases can be the same number of bytes and different work, and timing
noise is one-sided — a case is never faster than the work it does, and is
sometimes slower because of the scheduler, a cold cache or a neighbour on the
host. So each distinct size keeps its **smallest** reading. Same reasoning as
the SQL calibration benchmark, which scores the fastest of five runs.

---

## 3. What `n` is, and the one problem shape this cannot measure

`n` is **the size of the input in bytes**. The student-facing copy says this
in so many words, because it is not the same thing as the problem's own `n`.

For every problem whose input is a list, a grid, a string or a graph, the
bytes are proportional to the size of the thing, and the class carries over
unchanged. For one shape it does not: a problem whose input is a single
number — *"given n ≤ 10⁹, compute f(n)"* — has `bytes ≈ log n`, so a
linear-time solution would be read as exponential.

That shape is excluded, almost for free, by the size-span gate below. A single
integer written out cannot span 8× in bytes without reaching 10¹⁵, so those
problems refuse on the span rather than being misreported on it. This is the
main reason `MIN_SIZE_RATIO` is 8 and not 2.

---

## 4. The gates, and the number each one is

Three gates run before any fitting. Each exists because the alternative is a
confident wrong answer in a student's face.

| Gate | Value | Why that number |
|---|---|---|
| `MIN_FIT_POINTS` | 5 distinct sizes | Six curves through four points is numerology |
| `MIN_SIZE_RATIO` | 8× | Below it every curve in the ladder is a straight line and whichever wins wins on noise — and see §3 |
| `COMPLEXITY_METRIC_RULES.TIME.minSpan` | 15 ms | The worker reports whole CPU ms and the same case varies by one or two between runs. Fifteen of those is the smallest rise whose slope is the solution's rather than the clock's |
| `COMPLEXITY_METRIC_RULES.SPACE.minSpan` | 512 KB | Peak RSS is page-quantised and both the allocator and the runtime round upward in chunks far larger than a page. Half a megabyte is the smallest rise that is the program's data rather than its allocator's arithmetic |

Two more things can refuse after fitting: an R² below `MIN_R_SQUARED` (0.5 —
nothing in the ladder describes this curve), and a curve that only fits by
claiming the solution gets *faster* as its input grows, which no candidate is
allowed to do.

**Null is the normal state, not an error state.** On a catalogue of problems
authored before any of this existed, most submissions will carry no class and
a reason instead. That is the honest outcome, and the surface says which
reason.

---

## 5. STRONG and WEAK, and the measurement behind the margin

A fitted class is reported either way; the confidence decides whether the
copy adds *"read this as the shape of the curve rather than the exact
class"* and names the runner-up.

STRONG needs all of: ≥ 6 distinct sizes, ≥ 16× span, R² ≥ 0.95, the
runner-up's residual ≥ 4× the winner's, and agreement with the second
opinion (§6).

**The 4× margin is measured, not chosen.** Residuals are squared, so four
times the residual is twice the RMS error. Each class's curve was generated at
several noise levels and the winner's actual margin over the runner-up read
off:

| noise | O(log n) | O(√n) | O(n) | O(n log n) | O(n²) | O(n³) |
|---|---|---|---|---|---|---|
| 0% | 97,000× | 101,000× | 1,950× | 879× | 29,600× | 18,500× |
| 3% | 127× | 147× | 9.9× | 3.6× | 331× | 760× |
| 8% | 22× | 26× | 3.0× | **mislabelled**, 1.9× | 50× | 141× |
| 15% | 7.6× | 6.3× | 1.8× | **mislabelled**, 1.9× | 17× | 25× |

Two things in that table set the value. Every class except the
O(n) / O(n log n) pair separates by more than 6× even at 15% noise, so 4 costs
them nothing. And that pair is in a different position from the rest:
`n log n` is only about 9% steeper than `n` over any span a test suite covers,
so it separates by 879× on perfectly clean data where the others manage tens
of thousands — and by 8% noise the two have swapped places.

So the threshold states the true thing: **this method distinguishes O(n) from
O(n log n) only when the readings are very clean**, and whenever they are not
it says WEAK and names the other one. `packages/shared/test/complexity.test.ts`
asserts exactly that, in both directions.

---

## 6. The second opinion, and what subtracting the floor costs

A log–log slope is computed beside the ladder, and a class is only STRONG when
the two agree within `EXPONENT_TOLERANCE` (0.5).

The slope is taken **after subtracting the winning curve's own fitted floor**,
and that detail is the difference between a useful check and a useless one.
The raw slope of a curve sitting on a constant is not the exponent of
anything: a textbook-clean O(n²) rise of 800 ms on top of 20 ms of start-up has
a raw log–log slope of **0.77**. A gate on the raw slope marks almost every
honest fit WEAK — which is how this was first written, and the first test run
said so.

Subtracting the winner's floor means the check is not independent of the
winner, and the limit that creates is worth naming: it can no longer detect an
offset the ladder got wrong, only a shape it got wrong. That is the error
worth catching, and it still works in the right direction — fit a straight
line to quadratic data and the leftover slope comes out near 2, disagrees with
LINEAR's nominal 1, and the fit is downgraded.

The tolerance is deliberately wider than the 0.09 that separates O(n) from
O(n log n). Separating those two is the ladder's job and §5's.

**And it is under-confident on purpose, which real data showed.** A live
py312 submission to `two-sum` reported memory as O(n) with an r-squared of
**0.999** -- readings of 5224 KB at the bottom and 16648 KB at the top, which
is as clean as this gets -- and was still called WEAK. The reason is this
check: with a 5.2 MB floor, the leftover growth at the small end is 24 KB of
allocator noise, its logarithm is meaningless, and the slope over all twelve
points comes out at 0.42 instead of 1.0. Over the top decade alone it is
0.95.

That could be fixed by measuring the slope only where there is growth to
measure. It is not, and the reason is the same as the one in §10: every
candidate rule for "where" is a number chosen from this one problem's test
data, and a gate tuned on one problem is a gate that fits the fitter. The
failure here is conservative -- the right class, first, with a hedge beside
it -- and that is the direction this whole module is meant to fail in.
Recorded in `docs/OPEN-QUESTIONS.md` as worth revisiting when there are
several problems' worth of real submissions to choose a rule against.

---

## 7. Where the estimate is computed, and why it is stored

It is computed **at finalise**, in `apps/web/src/lib/judge/finalize.ts`, and
written to three columns on `Submission`: `timeComplexity`, `spaceComplexity`
(both the `ComplexityClass` enum, nullable) and `complexityDetail` (jsonb).

Three reasons, and the first is a rule rather than a preference:

1. **The sizes of a frozen version's hidden cases are not readable from a
   student-facing path.** `tests/repo/student-exposure.test.ts` rule R3
   refuses any `testCase` query selecting `input` without `isSample: true`,
   and the import graph (R5) keeps a student page out of every module that is
   allowed to make one. Computing the fit on page render would have meant
   widening that fence. The fit happens where reading hidden test data is
   already the job, and what reaches the student is the fitted class rather
   than the sizes. **The rule stands untouched**: a hidden case still shows a
   student its index, verdict, CPU ms and memory KB and nothing else
   (SPEC §7).
2. **The class has to be `GROUP BY`-able.** "What do the other accepted
   solutions here grow like" is a count per class over the peer population,
   and a jsonb path cannot be grouped without a functional index.
3. **An estimate kept beside the run that produced it stays auditable.** When
   the estimator changes, an old row keeps the reading its own run earned, and
   `complexityDetail.version` says which rules produced it. This is the same
   argument as `Submission.calibrationScore`, which is stored on the row for
   exactly that reason.

`measureComplexity` **cannot fail a finalise.** Every error is caught and the
columns are left alone: a student's verdict, their XP and their daily CPU
charge are not worth risking for a line of commentary under them. It also
short-circuits before the query when fewer than `MIN_FIT_POINTS` cases passed,
which is every compile error, every wrong answer on case one, and every
problem with four tests.

**No backfill.** Existing rows keep null in all three columns, because the
estimate describes a run and a run judged before the estimator existed was
never measured. An admin rejudge writes them, which is the only honest way an
old row acquires one.

---

## 8. The standing, and the four ways it could have been unfair

`getSolutionStanding` builds the population; `rankSolution` shapes it. The
population is **one row per other student — their fastest accepted
submission** — and each filter is there for a reason:

| Rule | Why |
|---|---|
| One row per student, `DISTINCT ON ("userId")` | A student who submitted forty times while tuning would otherwise be forty of the population, and the distribution would describe their afternoon |
| Time, memory and growth from that **same** submission | Three different students' bests stitched together is not a solution |
| The same frozen revision | Tests and limits change between revisions, so a time against revision 2 is not a time against revision 3 |
| The same language | Comparing a Python time to a C++ time ranks the language, and the student cannot act on it |
| PRACTICE and Accepted only | A contest or assessment submission is not a practice solution; a failed one has no time worth comparing |
| Calibration-normalised | Practice work is not restricted to a calibrated fleet, so two accepted solutions can differ by a third purely because of the node |

**The normalisation.** Ordering is on `cpuMs × calibrationScore`, and the
numbers a student is shown are divided back by *their own* node's
calibration — so what they read is "what these solutions would have cost on
the machine that judged mine", which is the only scale they have intuition
for. A submission with no recorded calibration is not ranked at all, because
there is no honest scale to put the peers on.

**The refusal.** Below `MIN_RANKED_PEERS` (20) there is no ranking. Twenty is
lower than `MIN_PERCENTILE_COHORT` (30) on purpose and for a different reason:
that threshold guards a student's own readiness percentile, where the figure
is about a person and a small cohort makes it identifiable. This one guards a
figure about a piece of code — no name, no profile, nothing that follows the
student anywhere — so what it has to carry is only that the number means
something, and twenty peers put each rank about five points apart.

**Mid-rank, and never 100%.** The share beaten uses the mid-rank definition
already in `percentile.ts`, so a tied group sits in the middle of the band it
occupies rather than at one end. `standingSentence` caps the reading at 99%:
the fastest solution in a population of 500 computes to 99.9%, and rounding
that to 100% would tell a student they are faster than a population they are
a member of.

**The distribution is log-scaled.** On any problem worth setting, the slowest
accepted solution is often twenty times the fastest, and ten linear bands put
everybody in the first one.

**Nothing identifying comes back.** The query returns a time, a memory figure
and a growth class per row — no name, no id, no profile, and no ordering a
position could be read back from. `apps/web/test/solution-standing.db.test.ts`
asserts that no fixture user id appears anywhere in the result.

---

## 9. What this never does

* It never affects a verdict, a score, XP, a contest standing, an assessment
  result, a readiness component, a leaderboard or any eligibility decision. A
  slow Accepted solution is Accepted, and stays Accepted.
* It is never shown for a contest or assessment submission's ranking: the
  population is practice solutions, and a live comparison against other
  candidates during a paper is not something this platform offers.
* It never shows a hidden case's input, its size, its expected output, the
  student's output or a diff. The fitted class is an aggregate over the whole
  run.
* It never claims a proof. `packages/shared/test/complexity.test.ts` asserts
  that no sentence this module produces contains "prove", "guarantee" or
  "certain".

---

## 10. What it actually says, measured on 259 real submissions

Synthetic curves prove the arithmetic. The question they cannot answer is
what this reports about real students' real submissions on real test data, so
it was run over every accepted submission to `two-sum` in the development
database -- **259 of them**, py312 and cpp20, with their own stored per-case
readings and the version's own case sizes. Nothing was written; the estimator
was simply asked.

| | cpp20 (127) | py312 (132) |
|---|---|---|
| **Memory** | O(n) on **every one**, r-squared 1.00 | O(n) on 131, O(n log n) on 1 |
| **Time, a class reported** | 77 (LINEAR 35, LINEARITHMIC 32, SQRT 5, QUADRATIC 3, LOG 2) | 89 (LINEAR 24, SQRT 24, LINEARITHMIC 14, QUADRATIC 14, LOG 9, CUBIC 3) |
| **Time, refused** | 50 (46 GROWTH_BELOW_NOISE, 4 NO_MODEL_FITS) | 43 (all NO_MODEL_FITS) |
| **STRONG** | 1 | 1 |

**Four things in that table are worth keeping.**

**1. The memory half is simply right.** A two-sum keeps a hash map of n
entries, and 258 of 259 submissions report O(n) with an r-squared of 1.00.
That is the feature working exactly as designed, on data nobody tuned it
against.

**2. Nothing was confidently wrong.** Two submissions out of 259 earned
STRONG. Everything else is WEAK with the runner-up named, or a refusal. The
whole design is built so that the failure mode is "we cannot say" rather than
"here is a wrong class in a confident voice", and under real data that is
what it did.

**3. The refusals are correct, and they say different things.** The 46 C++
GROWTH_BELOW_NOISE are real: a C++ two-sum on a 1 MB case finishes inside the
15 ms floor, so there is no growth to see, and the honest answer is to say so.
The 43 Python NO_MODEL_FITS are also real, and for a better reason -- those
rows come from the Phase 16x load bursts, where a thousand jobs ran at once.
One of them reads `88, 49, 41, 60, 501, 346, 210, 44, 58, 61, 58, 50, 55, 95`
ms, with the 501 ms on a **12-byte** case and 95 ms on the 1 MB one. Those
readings are contention, not computation, and the estimator refuses them
instead of drawing a line through them.

**4. The spread of time classes is a property of the TEST DATA, and it is
the useful finding.** `two-sum`'s fourteen cases are ten edge cases of 8-39
bytes and four real ones at 6.8 KB, 104 KB, 519 KB and 1 MB. Twelve distinct
sizes clear every gate -- but only four of them carry any information about
scale, and the other eight measure the interpreter starting up. A quiet
py312 run reads `41, 35, 37, 41, 39, 40, 43, 41, 39, 37, 44, 53, 67, 70`: a
37 ms floor and 33 ms of growth, almost all of it in the top two cases. With
four points carrying the signal, LINEAR and SQRT and LINEARITHMIC are all
within the noise of each other, which is precisely why they come out WEAK.

That last one is also a true statement about the program rather than only
about the measurement, and it is worth saying out loud: **two-sum returns as
soon as it finds the pair.** Its cost is not proportional to its input, so
"this run grew like O(√n)" can be a correct description of what happened on
those tests even where the worst case is O(n). This section measures runs.

**What was changed as a result: nothing in the estimator.** Tuning a
threshold on one problem's test data would be fitting the fitter. What was
written instead is `docs/AUTHORING.md` 3a -- if an author wants growth to be
legible on their problem, the test data needs a **ladder** of sizes rather
than a cluster of edge cases and a cliff. That is actionable, and it is the
half of this that a threshold cannot fix.

---

## 11. Reading one in practice

On `/problems/<slug>/submissions/<id>`, under the verdict:

* **Time** and **Memory** cards: the class, what it was measured over
  (`Measured over 12 test sizes spanning 64×, fit 0.98.`), and the caveat
  when the fit is weak.
* **Time** and **Memory** standings: the share beaten, this submission's own
  reading, the best and the middle of the population, and the log-scaled
  distribution with this submission's band marked — in words as well as in
  colour.
* **What the others grow like**: the peers' classes up the ladder, with this
  submission's own row kept even when no peer reached it, and a count of the
  peers whose growth could not be measured so the shares are readable.

If a problem's tests are all one size, the cards say so and the standing still
works. The two halves degrade independently on purpose.
