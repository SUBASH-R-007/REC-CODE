import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@recx/db";
import { createMailTransport, redactMailError } from "../src/mail";
import {
  OUTBOX_MAX_ATTEMPTS,
  OutboxDrainJob,
  isSecurityMail,
  outboxBackoffMs,
  outboxFailureAction,
} from "../src/outbox";
import { classifyPrivilegedOperation } from "../src/governance";

/** The outbox's pure rules, the transports, and the governance classifier. */

describe("outbox backoff and give-up", () => {
  it("backs off exponentially from 30 s, capped at 6 h", () => {
    expect(outboxBackoffMs(1)).toBe(30_000);
    expect(outboxBackoffMs(2)).toBe(60_000);
    expect(outboxBackoffMs(3)).toBe(120_000);
    expect(outboxBackoffMs(20)).toBe(6 * 3_600_000);
    for (let a = 1; a < 12; a++) expect(outboxBackoffMs(a + 1)).toBeGreaterThanOrEqual(outboxBackoffMs(a));
  });

  it("gives up after the last attempt", () => {
    expect(outboxFailureAction(OUTBOX_MAX_ATTEMPTS - 1)).toBe("retry");
    expect(outboxFailureAction(OUTBOX_MAX_ATTEMPTS)).toBe("give-up");
    expect(OUTBOX_MAX_ATTEMPTS).toBe(8);
  });

  it("knows security mail by its kind", () => {
    expect(isSecurityMail("security.break_glass")).toBe(true);
    expect(isSecurityMail("integrations.test")).toBe(false);
  });
});

describe("mail errors and transports", () => {
  it("never keeps an address or a URL with credentials in an error", () => {
    const text = redactMailError(new Error("550 <asha@example.test>: Recipient rejected via smtp://user:pw@mail.example.test:587"));
    expect(text).not.toContain("asha@example.test");
    expect(text).not.toContain("user:pw");
    expect(text).toContain("<address>");
    expect(text).toContain("<url>");
  });

  it("the log transport logs the subject and body but never the address", async () => {
    const lines: string[] = [];
    const log = pino({ level: "info" }, { write: (l: string) => lines.push(l) });
    const transport = createMailTransport({ transport: "log", smtpUrl: null, from: "REC Code <a@b.test>" }, log);
    await transport.send({ to: "asha@example.test", subject: "Break-glass approval", text: "body text" });
    expect(transport.name).toBe("log");
    expect(lines.join("")).toContain("Break-glass approval");
    expect(lines.join("")).not.toContain("asha@example.test");
  });

  it("the disabled transport refuses to send", async () => {
    const transport = createMailTransport({ transport: "disabled", smtpUrl: null, from: "x" }, pino({ level: "silent" }));
    await expect(transport.send({ to: "a@b.test", subject: "s", text: "t" })).rejects.toThrow(/disabled/);
  });
});

describe("OutboxDrainJob with the disabled transport", () => {
  it("claims nothing and only counts waiting security mail", async () => {
    const queryRaw = vi.fn();
    const db = { emailOutbox: { count: vi.fn(async () => 2) }, $queryRaw: queryRaw } as unknown as Db;
    const transport = createMailTransport({ transport: "disabled", smtpUrl: null, from: "x" }, pino({ level: "silent" }));
    const report = await new OutboxDrainJob({ db, log: pino({ level: "silent" }), dryRun: false, transport }).tick();
    expect(report).toMatchObject({ transport: "disabled", claimed: 0, sent: 0, pendingSecurity: 2 });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("classifyPrivilegedOperation", () => {
  const now = new Date("2026-10-10T10:00:00Z");
  it("expires PENDING at expiresAt, fails EXECUTING after 15 minutes, keeps the rest", () => {
    expect(classifyPrivilegedOperation({ status: "PENDING", expiresAt: now, executionStartedAt: null }, now)).toBe("expire");
    expect(
      classifyPrivilegedOperation({ status: "PENDING", expiresAt: new Date(now.getTime() + 1), executionStartedAt: null }, now),
    ).toBe("keep");
    expect(
      classifyPrivilegedOperation(
        { status: "EXECUTING", expiresAt: now, executionStartedAt: new Date(now.getTime() - 15 * 60_000 - 1) },
        now,
      ),
    ).toBe("fail-stale");
    expect(
      classifyPrivilegedOperation({ status: "EXECUTING", expiresAt: now, executionStartedAt: new Date(now.getTime() - 60_000) }, now),
    ).toBe("keep");
    // APPROVED is never expired: expiry bounds the wait for a decision only.
    expect(classifyPrivilegedOperation({ status: "APPROVED", expiresAt: new Date(0), executionStartedAt: null }, now)).toBe("keep");
  });

  it("fails an APPROVED operation that never started within 15 minutes of its approval", () => {
    const approved = (msAgo: number) => ({
      status: "APPROVED" as const,
      expiresAt: new Date(0),
      executionStartedAt: null,
      decidedAt: new Date(now.getTime() - msAgo),
    });
    expect(classifyPrivilegedOperation(approved(15 * 60_000 + 1), now)).toBe("fail-unstarted");
    expect(classifyPrivilegedOperation(approved(60_000), now)).toBe("keep");
  });
});
