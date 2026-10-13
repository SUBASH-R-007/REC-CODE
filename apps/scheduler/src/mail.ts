import nodemailer from "nodemailer";
import type { MailTransportName } from "@recx/shared";
import type { Logger } from "pino";
import type { MailConfig } from "./config";

/**
 * Mail transports for the EmailOutbox drain (outbox.ts):
 *
 *   smtp      nodemailer over SMTP_URL (production)
 *   log       writes subject and body to the scheduler log (development only;
 *             config.ts refuses it in production)
 *   disabled  sends nothing: the drain claims nothing and rows stay PENDING,
 *             which /super shows as a danger alert
 *
 * No transport ever logs a recipient address, and SMTP_URL (it carries
 * credentials) is never logged either.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  readonly name: MailTransportName;
  send(message: MailMessage): Promise<void>;
}

const EMAIL_LIKE = /[^\s<>"'@]+@[^\s<>"'@]+/g;

/** An error text safe to store and log: addresses and URLs with credentials are masked. */
export function redactMailError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "<url>")
    .replace(EMAIL_LIKE, "<address>")
    .slice(0, 500);
}

export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 20_000;

export function createMailTransport(config: MailConfig, log: Logger): MailTransport {
  switch (config.transport) {
    case "smtp": {
      if (!config.smtpUrl) throw new Error("MAIL_TRANSPORT=smtp needs SMTP_URL");
      // Short timeouts: the outbox drains inside the scheduler's tick, so a
      // relay that hangs must fail fast, never for nodemailer's defaults
      // (2 minutes to connect, 10 minutes of socket idle).
      const transporter = nodemailer.createTransport(config.smtpUrl, {
        connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
        greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
        socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      });
      return {
        name: "smtp",
        async send(message) {
          await transporter.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text });
        },
      };
    }
    case "log":
      return {
        name: "log",
        async send(message) {
          // Development only. Never the address.
          log.info({ subject: message.subject, text: message.text }, "mail (log transport)");
        },
      };
    case "disabled":
    default:
      return {
        name: "disabled",
        async send() {
          throw new Error("mail transport is disabled");
        },
      };
  }
}
