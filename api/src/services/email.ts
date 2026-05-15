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
 * HTML rendering: renderHtml() wraps the plain-text body in a minimal
 * editorial-styled shell (warm canvas + ink, system font stack) that
 * gracefully degrades in plain-text clients. v2 should switch to per-
 * code templates (mjml or handlebars) — today we use one shell for all.
 *
 * Failures (network, auth, 5xx) return { ok: false }; the row stays at
 * status='failed' and is NOT retried automatically — this is a v1 cut.
 * v2 should add a retry counter + exponential backoff cron.
 */
import nodemailer from "nodemailer";

const BRAND_NAME = "Robotun";
const BRAND_URL = process.env.BRAND_URL ?? "https://robotun.dev";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap a notification's plain title+body in a minimal HTML shell. */
export function renderHtml(args: { title: string; body: string }): string {
  const title = escapeHtml(args.title);
  // Preserve paragraph breaks from plain text bodies.
  const bodyHtml = escapeHtml(args.body)
    .split(/\n\n+/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.55;">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f7f4ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#14110e;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f4ee;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e2db;border-radius:6px;overflow:hidden;">
      <tr><td style="padding:24px 32px 0;">
        <p style="margin:0;font:11px/1.4 ui-monospace,'SF Mono',Consolas,monospace;letter-spacing:0.18em;text-transform:uppercase;color:#6b665d;">${escapeHtml(BRAND_NAME)}</p>
      </td></tr>
      <tr><td style="padding:8px 32px 4px;">
        <h1 style="margin:0;font:600 22px/1.3 Georgia,'Playfair Display',serif;color:#14110e;">${title}</h1>
      </td></tr>
      <tr><td style="padding:16px 32px 24px;font-size:15px;color:#3a3530;">
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:0 32px 24px;">
        <a href="${escapeHtml(BRAND_URL)}" style="display:inline-block;padding:10px 18px;background:#b3361b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;border-radius:4px;">Відкрити Robotun</a>
      </td></tr>
      <tr><td style="padding:16px 32px;border-top:1px solid #e5e2db;font-size:11px;color:#a39d92;">
        Ви отримуєте цей лист тому що увімкнули email-сповіщення в налаштуваннях.
        <a href="${escapeHtml(BRAND_URL)}/settings/notifications" style="color:#a39d92;text-decoration:underline;">Керувати</a>.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

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
      // Auto-render HTML shell if caller didn't supply one. Keeps
      // drainEmailQueue ergonomic (only has plain text from the
      // template registry).
      html: args.html ?? renderHtml({ title: args.subject, body: args.text }),
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
