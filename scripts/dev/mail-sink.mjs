/**
 * A local SMTP sink, so the mail path can be exercised without a relay
 * (Phase 16p, `docs/ROADMAP.md` §1.6).
 *
 * The outbox, the scheduler's drain and `createMailTransport`'s `smtp` case
 * have existed since Phase 11 and have never carried a message, because
 * `MAIL_TRANSPORT=log` is what a development checkout sets and the only
 * alternative was a real relay with real credentials. So the one thing
 * nobody could check was the thing most likely to be wrong: whether
 * nodemailer, the short timeouts, the `MAIL_FROM` and the drain's
 * bookkeeping actually deliver a message end to end.
 *
 * This accepts one. It speaks the minimum of RFC 5321 that nodemailer uses —
 * a greeting, EHLO, MAIL, RCPT, DATA, QUIT — and writes each message to a
 * file. It is NOT a mail server: it never relays, never authenticates,
 * refuses to listen on anything but the loopback address, and is for a
 * development machine only.
 *
 *   node scripts/dev/mail-sink.mjs                 # 127.0.0.1:1025
 *   node scripts/dev/mail-sink.mjs --port 2525
 *   node scripts/dev/mail-sink.mjs --out /tmp/mail
 *
 * Then, for the scheduler (apps/scheduler/.env.local, gitignored):
 *
 *   MAIL_TRANSPORT=smtp
 *   SMTP_URL=smtp://127.0.0.1:1025
 *
 * **On addresses.** `docs/SECURITY.md` and `apps/scheduler/src/mail.ts` hold
 * the rule that no transport ever logs a recipient: a log is read by people
 * who have no business knowing who was emailed. A sink cannot honour that in
 * the FILE — the recipient is part of the message it exists to show you —
 * so it honours it everywhere else: what it prints masks the local part, and
 * the output directory must be outside the repository (it refuses one
 * inside, so a student's address cannot be committed by accident).
 */
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 1025;
const CRLF = "\r\n";
/** RFC 5321 §4.5.3.1.6: a server must accept a message of at least 64 kB. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", String(DEFAULT_PORT)));
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`--port must be a port number, not ${JSON.stringify(arg("port", ""))}`);
  process.exit(64);
}

const outDir = path.resolve(arg("out", path.join(tmpdir(), "recx-mail")));
// The repository is where a committed address would end up, so it is the one
// place this will not write.
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
if (outDir === repoRoot || outDir.startsWith(repoRoot + path.sep)) {
  console.error(`--out must be outside the repository (${repoRoot}): a saved message holds a real address`);
  process.exit(64);
}
mkdirSync(outDir, { recursive: true });

/** "someone@example.edu" → "s***@example.edu"; anything else is unchanged. */
function maskAddress(raw) {
  const at = raw.lastIndexOf("@");
  if (at <= 0) return "<address>";
  return `${raw[0]}***${raw.slice(at)}`;
}

/** The angle-addr inside "Name <a@b>", or the whole thing trimmed. */
function addressOf(parameter) {
  const angled = /<([^>]*)>/.exec(parameter);
  return (angled ? angled[1] : parameter).trim();
}

function headerOf(message, name) {
  const line = new RegExp(`^${name}:(.*)$`, "im").exec(message);
  return line ? line[1].trim() : "";
}

let accepted = 0;

const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let inData = false;
  let data = "";
  let envelope = { from: "", to: [] };
  let overflowed = false;

  const say = (line) => socket.write(line + CRLF);
  say("220 recx-mail-sink ESMTP ready (development only)");

  const reset = () => {
    envelope = { from: "", to: [] };
    data = "";
    overflowed = false;
  };

  const finishData = () => {
    inData = false;
    if (overflowed) {
      say("552 message too large");
      reset();
      return;
    }
    accepted += 1;
    // Dot-stuffing, undone: RFC 5321 §4.5.2.
    const message = data.replace(/^\.\./gm, ".");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(outDir, `${stamp}-${String(accepted).padStart(3, "0")}.eml`);
    writeFileSync(file, message, "utf8");
    console.log(
      `[mail-sink] #${accepted} to ${envelope.to.map(maskAddress).join(", ") || "<none>"}` +
        ` subject ${JSON.stringify(headerOf(message, "Subject"))}` +
        ` from ${JSON.stringify(headerOf(message, "From"))}` +
        ` -> ${file}`,
    );
    say("250 2.0.0 Ok: queued");
    reset();
  };

  socket.on("data", (chunk) => {
    buffer += chunk;

    while (true) {
      if (inData) {
        // The message ends at a line containing a single dot.
        const end = buffer.indexOf(CRLF + "." + CRLF);
        if (end === -1) {
          // Keep the last two characters in case the terminator straddles
          // two reads.
          if (data.length + buffer.length > MAX_MESSAGE_BYTES) overflowed = true;
          if (!overflowed) data += buffer.slice(0, Math.max(0, buffer.length - 2));
          buffer = buffer.slice(Math.max(0, buffer.length - 2));
          return;
        }
        if (!overflowed) data += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        finishData();
        continue;
      }

      const line = buffer.indexOf(CRLF);
      if (line === -1) return;
      const command = buffer.slice(0, line);
      buffer = buffer.slice(line + 2);
      const verb = command.split(/[ :]/, 1)[0].toUpperCase();
      const rest = command.slice(verb.length).replace(/^[ :]+/, "");

      switch (verb) {
        case "EHLO":
          // No STARTTLS and no AUTH advertised, so nodemailer stays in
          // plaintext and never offers credentials to a sink.
          say("250-recx-mail-sink");
          say("250-8BITMIME");
          say(`250 SIZE ${MAX_MESSAGE_BYTES}`);
          break;
        case "HELO":
          say("250 recx-mail-sink");
          break;
        case "MAIL":
          envelope.from = addressOf(rest.replace(/^FROM:?/i, ""));
          say("250 2.1.0 Ok");
          break;
        case "RCPT":
          envelope.to.push(addressOf(rest.replace(/^TO:?/i, "")));
          say("250 2.1.5 Ok");
          break;
        case "DATA":
          if (envelope.to.length === 0) {
            say("503 5.5.1 RCPT first");
            break;
          }
          inData = true;
          say("354 End data with <CR><LF>.<CR><LF>");
          break;
        case "RSET":
          reset();
          say("250 2.0.0 Ok");
          break;
        case "NOOP":
          say("250 2.0.0 Ok");
          break;
        case "QUIT":
          say("221 2.0.0 Bye");
          socket.end();
          return;
        default:
          say(`502 5.5.1 ${verb} not implemented`);
      }
    }
  });

  socket.on("error", (error) => console.error(`[mail-sink] socket: ${error.message}`));
});

server.on("error", (error) => {
  console.error(`[mail-sink] ${error.message}`);
  process.exit(1);
});

// Loopback only, and not configurable. A sink reachable from the network is
// an open relay with a friendly name.
server.listen(port, LOOPBACK, () => {
  console.log(`[mail-sink] listening on smtp://${LOOPBACK}:${port}, writing to ${outDir}`);
  console.log(`[mail-sink] set MAIL_TRANSPORT=smtp and SMTP_URL=smtp://${LOOPBACK}:${port} for the scheduler`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[mail-sink] ${accepted} message(s) accepted; stopping`);
    server.close(() => process.exit(0));
  });
}
