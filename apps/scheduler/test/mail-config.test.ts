import { describe, expect, it } from "vitest";
import { DEFAULT_MAIL_FROM, loadConfig } from "../src/config";

/** MAIL_TRANSPORT / SMTP_URL / MAIL_FROM: log is development-only; smtp needs a URL. */

const DIRECT = "postgresql://recx:pw@db.internal:5432/recx";
const prod = { NODE_ENV: "production", DATABASE_URL_DIRECT: DIRECT, REDIS_URL: "redis://cache:6379" } as const;

describe("mail configuration", () => {
  it("defaults to log in development and disabled elsewhere", () => {
    expect(loadConfig({ DATABASE_URL: DIRECT }).mail).toEqual({ transport: "log", smtpUrl: null, from: DEFAULT_MAIL_FROM });
    expect(loadConfig({ ...prod }).mail.transport).toBe("disabled");
    expect(loadConfig({ NODE_ENV: "test", DATABASE_URL_DIRECT: DIRECT }).mail.transport).toBe("disabled");
  });

  it("refuses the log transport in production", () => {
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: "log" })).toThrow(/MAIL_TRANSPORT: log is refused in production/);
  });

  it("requires SMTP_URL for smtp, and accepts smtp:// or smtps:// only", () => {
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: "smtp" })).toThrow(/SMTP_URL: is required/);
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: "smtp", SMTP_URL: "http://mail" })).toThrow(/SMTP_URL/);
    const config = loadConfig({ ...prod, MAIL_TRANSPORT: "smtp", SMTP_URL: "smtps://u:p@mail.example.test:465", MAIL_FROM: "REC Code <noreply@rec.test>" });
    expect(config.mail).toEqual({ transport: "smtp", smtpUrl: "smtps://u:p@mail.example.test:465", from: "REC Code <noreply@rec.test>" });
  });

  it("refuses an unknown transport", () => {
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: "sendgrid" })).toThrow(/MAIL_TRANSPORT/);
  });
});
