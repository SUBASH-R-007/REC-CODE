import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The calendar and leave invariants (migration 20261019260000).
 *
 * SPEC §5 Phase 8 asks for inactivity to be "a policy engine, not a kill
 * switch", and these two tables are what make the engine's arithmetic a
 * statement about a student rather than a date subtraction. So the invariants
 * are not hygiene: a leave that could be widened after approval, or a past
 * holiday that could be edited away, would both turn a Phase 8c evidence row
 * into a lie about a decision already taken.
 *
 * Every one of these is tested through Prisma — the path the application
 * actually takes — and the two immutability triggers are tested through raw
 * SQL as well, because a guard that only stops the ORM is not a guard.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS
  ? "calendar and leave invariants (live database)"
  : "calendar and leave invariants (set RECX_DB_TESTS=1 to run)";

/** A "yyyy-MM-dd" day as the UTC-midnight Date a @db.Date column holds. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * Days this suite writes are chosen FAR in the future on purpose.
 *
 * `CalendarDay_past_immutable` compares against the database's
 * `current_date`, and the WSL database's clock runs ~200 ms ahead of the
 * Windows host. A suite that wrote "today" would be a suite whose teardown
 * occasionally could not delete its own rows, which is how a shared
 * `recx_test` acquires a row nobody owns.
 */
const FUTURE = 2099;
let dayCursor = 0;
const nextDay = () => {
  dayCursor += 1;
  const date = new Date(Date.UTC(FUTURE, 0, 1));
  date.setUTCDate(date.getUTCDate() + dayCursor);
  return date.toISOString().slice(0, 10);
};

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let studentId = "";
  let staffId = "";
  let otherStaffId = "";
  const writtenDays: Date[] = [];

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  const calendarDay = (over: Record<string, unknown> = {}) => {
    const date = over.date ?? day(nextDay());
    writtenDays.push(date as Date);
    return db.calendarDay.create({
      data: { date, label: "A day", createdById: staffId, ...over } as never,
      select: { date: true, kind: true, isWorkingDay: true },
    });
  };

  const leave = (over: Record<string, unknown> = {}) =>
    db.leaveException.create({
      data: {
        userId: studentId,
        kind: "MEDICAL",
        startDate: day(`${FUTURE}-03-01`),
        endDate: day(`${FUTURE}-03-05`),
        reason: "Admitted with dengue; discharge summary attached.",
        requestedById: studentId,
        ...over,
      } as never,
      select: { id: true, status: true, startDate: true, endDate: true },
    });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const mk = async (suffix: string, role: "STUDENT" | "ADMIN") =>
      (
        await db.user.create({
          data: {
            collegeId: `CAL${run}${suffix}`,
            email: `cal-${run}-${suffix}@example.test`,
            firstName: "A",
            lastName: suffix,
            handle: `cal-${run}-${suffix}`,
            role,
          },
          select: { id: true },
        })
      ).id;

    studentId = await mk("s", "STUDENT");
    staffId = await mk("t", "ADMIN");
    otherStaffId = await mk("u", "ADMIN");
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.leaveException.deleteMany({ where: { userId: studentId } });
      await db.calendarDay.deleteMany({ where: { date: { in: writtenDays } } });
      await db.user.deleteMany({ where: { id: { in: [studentId, staffId, otherStaffId] } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("a calendar day is about a day, and says what it is", () => {
    it("defaults to a regular working day", async () => {
      const row = await calendarDay();
      expect(row).toMatchObject({ kind: "REGULAR", isWorkingDay: true });
    });

    it("refuses a blank label", async () => {
      expect(await refused(() => calendarDay({ label: "   " }))).toMatch(/CalendarDay_label_check/);
    });

    it("refuses a label over 120 characters", async () => {
      expect(await refused(() => calendarDay({ label: "x".repeat(121) }))).toMatch(/CalendarDay_label_check/);
    });

    it("lets an EXAM_WEEK be a working day, which is the truth about an exam week", async () => {
      // The draft design had a CHECK forcing every non-regular day to
      // isWorkingDay = false. That would have left the policy's
      // excludeNonWorkingDays toggle with nothing to switch, because `kind`
      // and `isWorkingDay` would carry the same information.
      const row = await calendarDay({ kind: "EXAM_WEEK", isWorkingDay: true, label: "CAT-2 week" });
      expect(row).toMatchObject({ kind: "EXAM_WEEK", isWorkingDay: true });
    });

    it("lets a PLACEMENT_WEEK be a working day too", async () => {
      const row = await calendarDay({ kind: "PLACEMENT_WEEK", isWorkingDay: true, label: "Drive week" });
      expect(row.isWorkingDay).toBe(true);
    });

    it("lets a REGULAR day be non-working, which is a Sunday", async () => {
      const row = await calendarDay({ isWorkingDay: false, label: "Sunday" });
      expect(row).toMatchObject({ kind: "REGULAR", isWorkingDay: false });
    });

    it("holds one row per date", async () => {
      const date = day(nextDay());
      await calendarDay({ date });
      expect(await refused(() => calendarDay({ date }))).toMatch(/Unique|CalendarDay_pkey/i);
    });
  });

  describe("a past calendar day is frozen", () => {
    const PAST = day("2020-01-15");

    beforeAll(async () => {
      // Written with triggers in force — INSERT is not guarded, only UPDATE
      // and DELETE, because a college loading last term's calendar late is
      // doing something reasonable.
      await db.calendarDay.create({
        data: { date: PAST, label: "A past day", createdById: staffId },
        select: { date: true },
      });
    });

    afterAll(async () => {
      // Only raw SQL can clear it, which is the point of the guard.
      await db.$executeRawUnsafe(`ALTER TABLE "CalendarDay" DISABLE TRIGGER "CalendarDay_past_immutable"`);
      await db.calendarDay.deleteMany({ where: { date: PAST } });
      await db.$executeRawUnsafe(`ALTER TABLE "CalendarDay" ENABLE TRIGGER "CalendarDay_past_immutable"`);
    });

    it("refuses an UPDATE through Prisma", async () => {
      const message = await refused(() =>
        db.calendarDay.update({ where: { date: PAST }, data: { kind: "HOLIDAY" } }),
      );
      expect(message).toMatch(/CalendarDay_past_immutable/);
      expect(message).toMatch(/retroactive LeaveException/);
    });

    it("refuses a DELETE through Prisma", async () => {
      expect(await refused(() => db.calendarDay.delete({ where: { date: PAST } }))).toMatch(
        /CalendarDay_past_immutable/,
      );
    });

    it("refuses an UPDATE through raw SQL — a guard that only stops the ORM is not a guard", async () => {
      const message = await refused(() =>
        db.$executeRawUnsafe(`UPDATE "CalendarDay" SET "label" = 'rewritten' WHERE "date" = '2020-01-15'`),
      );
      expect(message).toMatch(/CalendarDay_past_immutable/);
    });

    it("refuses moving a future day INTO the past", async () => {
      const future = day(nextDay());
      await calendarDay({ date: future });
      const message = await refused(() =>
        db.$executeRawUnsafe(
          `UPDATE "CalendarDay" SET "date" = '2020-02-02' WHERE "date" = '${future.toISOString().slice(0, 10)}'`,
        ),
      );
      expect(message).toMatch(/CalendarDay_past_immutable/);
    });

    it("still allows editing a future day, because a calendar is revised ahead", async () => {
      const date = day(nextDay());
      await calendarDay({ date });
      const updated = await db.calendarDay.update({
        where: { date },
        data: { kind: "HOLIDAY", isWorkingDay: false, label: "Pongal" },
        select: { kind: true, label: true },
      });
      expect(updated).toMatchObject({ kind: "HOLIDAY", label: "Pongal" });
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "CalendarDay"`))).toMatch(/TRUNCATE/i);
    });
  });

  describe("a leave is a request until somebody else decides it", () => {
    it("starts REQUESTED with no decider", async () => {
      const row = await leave({ startDate: day(`${FUTURE}-04-01`), endDate: day(`${FUTURE}-04-03`) });
      expect(row.status).toBe("REQUESTED");
    });

    it("refuses APPROVED with no decider", async () => {
      const message = await refused(() =>
        leave({ status: "APPROVED", startDate: day(`${FUTURE}-04-10`), endDate: day(`${FUTURE}-04-12`) }),
      );
      expect(message).toMatch(/LeaveException_decision_pair_check/);
    });

    it("refuses a decider on a row still REQUESTED", async () => {
      const message = await refused(() =>
        leave({
          decidedById: staffId,
          decidedAt: new Date(),
          startDate: day(`${FUTURE}-04-20`),
          endDate: day(`${FUTURE}-04-22`),
        }),
      );
      expect(message).toMatch(/LeaveException_decision_pair_check/);
    });

    it("refuses a self-approval", async () => {
      // The same two-person rule PrivilegedOperation uses. A student cannot
      // excuse their own absence.
      const message = await refused(() =>
        leave({
          status: "APPROVED",
          decidedById: studentId,
          decidedAt: new Date(),
          startDate: day(`${FUTURE}-05-01`),
          endDate: day(`${FUTURE}-05-02`),
        }),
      );
      expect(message).toMatch(/LeaveException_two_person_check/);
    });

    it("refuses a self-approval by the tutor who raised it, not only by the student", async () => {
      const message = await refused(() =>
        leave({
          requestedById: staffId,
          status: "APPROVED",
          decidedById: staffId,
          decidedAt: new Date(),
          startDate: day(`${FUTURE}-05-10`),
          endDate: day(`${FUTURE}-05-11`),
        }),
      );
      expect(message).toMatch(/LeaveException_two_person_check/);
    });

    it("refuses a REJECTED row with no note a student can read", async () => {
      const message = await refused(() =>
        leave({
          status: "REJECTED",
          decidedById: staffId,
          decidedAt: new Date(),
          startDate: day(`${FUTURE}-05-20`),
          endDate: day(`${FUTURE}-05-21`),
        }),
      );
      expect(message).toMatch(/LeaveException_rejection_note_check/);
    });

    it("refuses a REJECTED note shorter than 10 characters", async () => {
      const message = await refused(() =>
        leave({
          status: "REJECTED",
          decidedById: staffId,
          decidedAt: new Date(),
          decisionNote: "no",
          startDate: day(`${FUTURE}-05-25`),
          endDate: day(`${FUTURE}-05-26`),
        }),
      );
      expect(message).toMatch(/LeaveException_rejection_note_check/);
    });

    it("accepts a REJECTED row that explains itself", async () => {
      const row = await leave({
        status: "REJECTED",
        decidedById: staffId,
        decidedAt: new Date(),
        decisionNote: "No certificate was attached; please re-raise with one.",
        startDate: day(`${FUTURE}-06-01`),
        endDate: day(`${FUTURE}-06-02`),
      });
      expect(row.status).toBe("REJECTED");
    });
  });

  describe("the shape of the range and the reason", () => {
    it("refuses an end before its start", async () => {
      const message = await refused(() =>
        leave({ startDate: day(`${FUTURE}-07-10`), endDate: day(`${FUTURE}-07-09`) }),
      );
      expect(message).toMatch(/LeaveException_range_check/);
    });

    it("accepts a single-day leave", async () => {
      const row = await leave({ startDate: day(`${FUTURE}-07-15`), endDate: day(`${FUTURE}-07-15`) });
      expect(row.startDate).toEqual(row.endDate);
    });

    it("accepts exactly 180 days", async () => {
      const start = day(`${FUTURE}-08-01`);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 180);
      const row = await leave({ startDate: start, endDate: end });
      expect(row.id).toBeTruthy();
    });

    it("refuses 181 days — longer than that is a withdrawal, not a leave", async () => {
      const start = day(`${FUTURE}-08-20`);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 181);
      expect(await refused(() => leave({ startDate: start, endDate: end }))).toMatch(
        /LeaveException_range_check/,
      );
    });

    it("refuses a reason under 10 characters", async () => {
      expect(
        await refused(() => leave({ reason: "ill", startDate: day(`${FUTURE}-09-01`), endDate: day(`${FUTURE}-09-02`) })),
      ).toMatch(/LeaveException_reason_check/);
    });

    it("refuses a reason of whitespace", async () => {
      expect(
        await refused(() =>
          leave({ reason: " ".repeat(40), startDate: day(`${FUTURE}-09-05`), endDate: day(`${FUTURE}-09-06`) }),
        ),
      ).toMatch(/LeaveException_reason_check/);
    });

    it("refuses a reason over 1000 characters", async () => {
      expect(
        await refused(() =>
          leave({ reason: "x".repeat(1001), startDate: day(`${FUTURE}-09-10`), endDate: day(`${FUTURE}-09-11`) }),
        ),
      ).toMatch(/LeaveException_reason_check/);
    });
  });

  describe("one student never holds two overlapping APPROVED leaves", () => {
    const approve = (over: Record<string, unknown>) =>
      leave({ status: "APPROVED", decidedById: staffId, decidedAt: new Date(), ...over });

    it("accepts two approved leaves that do not touch", async () => {
      await approve({ startDate: day(`${FUTURE}-10-01`), endDate: day(`${FUTURE}-10-05`) });
      const second = await approve({ startDate: day(`${FUTURE}-10-06`), endDate: day(`${FUTURE}-10-10`) });
      expect(second.status).toBe("APPROVED");
    });

    it("refuses an approved leave overlapping another", async () => {
      // Without this a day could be excluded twice under two kinds, and the
      // evidence JSON's excludedReason would be whichever row was read first.
      await approve({ startDate: day(`${FUTURE}-11-01`), endDate: day(`${FUTURE}-11-10`) });
      const message = await refused(() =>
        approve({ startDate: day(`${FUTURE}-11-05`), endDate: day(`${FUTURE}-11-15`) }),
      );
      expect(message).toMatch(/LeaveException_no_overlapping_approved/);
    });

    it("refuses one that overlaps by a single shared end day — the range is inclusive", async () => {
      await approve({ startDate: day(`${FUTURE}-12-01`), endDate: day(`${FUTURE}-12-05`) });
      const message = await refused(() =>
        approve({ startDate: day(`${FUTURE}-12-05`), endDate: day(`${FUTURE}-12-09`) }),
      );
      expect(message).toMatch(/LeaveException_no_overlapping_approved/);
    });

    it("allows overlapping REQUESTED rows, because a request excuses nothing", async () => {
      await leave({ startDate: day(`${FUTURE + 1}-01-01`), endDate: day(`${FUTURE + 1}-01-10`) });
      const second = await leave({ startDate: day(`${FUTURE + 1}-01-05`), endDate: day(`${FUTURE + 1}-01-15`) });
      expect(second.status).toBe("REQUESTED");
    });

    it("allows an approved leave overlapping a CANCELLED one", async () => {
      const cancelled = await approve({ startDate: day(`${FUTURE + 1}-02-01`), endDate: day(`${FUTURE + 1}-02-10`) });
      await db.leaveException.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
      const replacement = await approve({
        startDate: day(`${FUTURE + 1}-02-05`),
        endDate: day(`${FUTURE + 1}-02-15`),
      });
      expect(replacement.status).toBe("APPROVED");
    });

    it("allows two students the same approved dates", async () => {
      const other = await db.user.create({
        data: {
          collegeId: `CAL${run}v`,
          email: `cal-${run}-v@example.test`,
          firstName: "A",
          lastName: "Peer",
          handle: `cal-${run}-v`,
          role: "STUDENT",
        },
        select: { id: true },
      });
      await approve({ startDate: day(`${FUTURE + 1}-03-01`), endDate: day(`${FUTURE + 1}-03-05`) });
      const theirs = await approve({
        userId: other.id,
        requestedById: other.id,
        startDate: day(`${FUTURE + 1}-03-01`),
        endDate: day(`${FUTURE + 1}-03-05`),
      });
      expect(theirs.status).toBe("APPROVED");
      await db.leaveException.deleteMany({ where: { userId: other.id } });
      await db.user.delete({ where: { id: other.id } });
    });
  });

  describe("the terms of a leave never change", () => {
    /**
     * A distinct range per call. Several of these tests approve their row,
     * and `LeaveException_no_overlapping_approved` is doing its job — a
     * fixture that reused one range would be a fixture the constraint
     * refuses, which is a test failing for the suite's reason rather than
     * the code's.
     */
    let slot = 0;
    const fresh = () => {
      slot += 1;
      const start = new Date(Date.UTC(FUTURE + 2, 0, 1));
      start.setUTCDate(start.getUTCDate() + slot * 10);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 4);
      return leave({ startDate: start, endDate: end });
    };

    it.each([
      ["kind", { kind: "SPORTS_EVENT" }],
      ["startDate", { startDate: day(`${FUTURE + 2}-01-02`) }],
      ["endDate", { endDate: day(`${FUTURE + 2}-02-05`) }],
      ["reason", { reason: "A different reason entirely, ten characters at least." }],
      ["evidenceFileId", { evidenceFileId: "file_123" }],
    ])("refuses an edit to %s", async (_field, data) => {
      const row = await fresh();
      const message = await refused(() =>
        db.leaveException.update({ where: { id: row.id }, data: data as never }),
      );
      expect(message).toMatch(/LeaveException_terms_immutable/);
    });

    it("refuses an edit to the terms through raw SQL too", async () => {
      const row = await fresh();
      const message = await refused(() =>
        db.$executeRawUnsafe(
          `UPDATE "LeaveException" SET "endDate" = '${FUTURE + 2}-06-30' WHERE "id" = '${row.id}'`,
        ),
      );
      expect(message).toMatch(/LeaveException_terms_immutable/);
    });

    it("allows the status to move REQUESTED to APPROVED with a decision", async () => {
      const row = await fresh();
      const decided = await db.leaveException.update({
        where: { id: row.id },
        data: { status: "APPROVED", decidedById: staffId, decidedAt: new Date() },
        select: { status: true },
      });
      expect(decided.status).toBe("APPROVED");
    });

    it("allows APPROVED to CANCELLED, and the approval stays on the record", async () => {
      /**
       * The reason `LeaveException_decision_pair_check` is three rules and
       * not one biconditional. `(status IN ('APPROVED','REJECTED')) =
       * (decided…)` reads well and is wrong: it makes CANCELLED mean "never
       * decided", so this cancel would have to erase the decider — which the
       * terms trigger rightly refuses, leaving an approved leave that can
       * never be withdrawn. A student who recovers early cancels their own
       * leave, and who approved it is still part of the record.
       *
       * This test is what found that. It was written before the constraint
       * was, and the constraint was rewritten to satisfy it.
       */
      const row = await fresh();
      await db.leaveException.update({
        where: { id: row.id },
        data: { status: "APPROVED", decidedById: staffId, decidedAt: new Date() },
      });
      const cancelled = await db.leaveException.update({
        where: { id: row.id },
        data: { status: "CANCELLED" },
        select: { status: true, decidedById: true, decidedAt: true },
      });
      expect(cancelled.status).toBe("CANCELLED");
      expect(cancelled.decidedById).toBe(staffId);
      expect(cancelled.decidedAt).not.toBeNull();
    });

    it("allows REQUESTED to CANCELLED with no decider, because nobody decided it", async () => {
      const row = await fresh();
      const cancelled = await db.leaveException.update({
        where: { id: row.id },
        data: { status: "CANCELLED" },
        select: { status: true, decidedById: true },
      });
      expect(cancelled).toMatchObject({ status: "CANCELLED", decidedById: null });
    });

    it("refuses a decider with no decision time, in either direction", async () => {
      const row = await fresh();
      expect(
        await refused(() =>
          db.leaveException.update({ where: { id: row.id }, data: { status: "APPROVED", decidedById: staffId } }),
        ),
      ).toMatch(/LeaveException_decision_pair_check/);
      expect(
        await refused(() =>
          db.leaveException.update({ where: { id: row.id }, data: { status: "APPROVED", decidedAt: new Date() } }),
        ),
      ).toMatch(/LeaveException_decision_pair_check/);
    });

    it("refuses REJECTED back to REQUESTED", async () => {
      const row = await fresh();
      await db.leaveException.update({
        where: { id: row.id },
        data: {
          status: "REJECTED",
          decidedById: staffId,
          decidedAt: new Date(),
          decisionNote: "No certificate attached; re-raise with one.",
        },
      });
      const message = await refused(() =>
        db.leaveException.update({ where: { id: row.id }, data: { status: "REQUESTED" } }),
      );
      expect(message).toMatch(/LeaveException_terms_immutable/);
    });

    it("refuses CANCELLED back to APPROVED", async () => {
      const row = await fresh();
      await db.leaveException.update({ where: { id: row.id }, data: { status: "CANCELLED" } });
      const message = await refused(() =>
        db.leaveException.update({
          where: { id: row.id },
          data: { status: "APPROVED", decidedById: staffId, decidedAt: new Date() },
        }),
      );
      expect(message).toMatch(/LeaveException_terms_immutable/);
    });

    it("refuses a second reviewer overwriting the first", async () => {
      // Otherwise a two-person rule quietly becomes a one-person rule.
      const row = await fresh();
      await db.leaveException.update({
        where: { id: row.id },
        data: { status: "APPROVED", decidedById: staffId, decidedAt: new Date() },
      });
      const message = await refused(() =>
        db.leaveException.update({ where: { id: row.id }, data: { decidedById: otherStaffId } }),
      );
      expect(message).toMatch(/LeaveException_terms_immutable/);
    });

    it("refuses re-dating a decision already made", async () => {
      const row = await fresh();
      await db.leaveException.update({
        where: { id: row.id },
        data: { status: "APPROVED", decidedById: staffId, decidedAt: new Date() },
      });
      const message = await refused(() =>
        db.leaveException.update({ where: { id: row.id }, data: { decidedAt: new Date(0) } }),
      );
      expect(message).toMatch(/LeaveException_terms_immutable/);
    });

    it("allows a decision note to be added to an approval", async () => {
      const row = await fresh();
      await db.leaveException.update({
        where: { id: row.id },
        data: { status: "APPROVED", decidedById: staffId, decidedAt: new Date() },
      });
      const noted = await db.leaveException.update({
        where: { id: row.id },
        data: { decisionNote: "Certificate verified with the health centre." },
        select: { decisionNote: true },
      });
      expect(noted.decisionNote).toMatch(/health centre/);
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "LeaveException"`))).toMatch(/TRUNCATE/i);
    });
  });
});
