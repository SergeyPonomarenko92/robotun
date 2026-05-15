/**
 * Module 9 — email channel transport.
 *
 * Dev: SMTP via mailpit at localhost:11025 (no auth, no TLS).
 * Prod: any SMTP via SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS.
 *
 * The notifications consumer enqueues email rows with status='pending';
 * drainEmailQueue (in notifications.service) picks them up, calls send()
 * here, then flips to 'sent' or 'failed' based on result.
 *
 * Failures (network, auth, 5xx) return { ok: false }; the row stays at
 * status='failed' and is NOT retried automatically — this is a v1 cut.
 * v2 should add a retry counter + exponential backoff cron.
 */
import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 11025);
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASS = process.env.SMTP_PASS ?? "";
const SMTP_FROM = process.env.SMTP_FROM ?? "Robotun <noreply@robotun.dev>";

let transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    // mailpit accepts any auth; prod swaps these in via env.
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transport;
}

export type SendResult =
  | { ok: true; message_id: string }
  | { ok: false; error: string };

export async function sendEmail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendResult> {
  try {
    const info = await getTransport().sendMail({
      from: SMTP_FROM,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    return { ok: true, message_id: info.messageId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Smoke probe — connects + verifies SMTP banner. */
export async function verifyConnection(): Promise<boolean> {
  try {
    await getTransport().verify();
    return true;
  } catch {
    return false;
  }
}
