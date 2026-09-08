import { config } from '../config';
import { setResendStatus, settings } from './store';

/**
 * Transactional email via Resend.
 *
 * Email two-factor authentication is only offered when a Resend key is
 * present *and* a test send has actually succeeded — an unverified key would
 * otherwise lock people out of their own accounts.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function sendEmail(to: string, subject: string, html: string, text?: string): Promise<SendResult> {
  const cfg = config();
  if (!cfg.resend.configured) return { ok: false, error: 'RESEND_API_KEY is not set.' };

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.resend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${cfg.resend.fromName} <${cfg.resend.fromEmail}>`,
        to: [to],
        subject,
        html,
        ...(text ? { text } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      return { ok: false, error: body.message ?? `Resend returned ${res.status}` };
    }
    return { ok: true, ...(body.id ? { id: body.id } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether email 2FA may be used. Requires both a configured key and a
 * verified test send.
 */
export function twoFactorAvailable(): boolean {
  return config().resend.configured && settings().resend.verified;
}

/** Sends a test email and records the outcome, gating 2FA on success. */
export async function verifyResend(to: string): Promise<SendResult> {
  const result = await sendEmail(
    to,
    'SupportWizard NetKit — email delivery test',
    emailLayout(
      'Email delivery test',
      `<p>This is a test from SupportWizard NetKit. Receiving it confirms Resend is configured correctly, which enables email two-factor authentication for the portal.</p>`,
    ),
    'This is a test from SupportWizard NetKit. Receiving it confirms Resend is configured correctly.',
  );

  await setResendStatus(
    result.ok
      ? { verified: true, verifiedAt: new Date().toISOString(), lastTestTo: to }
      : { verified: false, lastError: result.error ?? 'Unknown error', lastTestTo: to },
  );
  return result;
}

/**
 * Brand email layout — the client-facing system from the brand guide: cyan to
 * lilac masthead, near-black headings, grey field panel.
 */
export function emailLayout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F6F7F8;font-family:'Segoe UI',Inter,Helvetica,Arial,sans-serif;color:#3C444E;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E4E6E8;border-radius:10px;overflow:hidden;">
        <tr><td style="background:linear-gradient(105deg,#CCF3FF 0%,#DEE9FF 50%,#F1DCF9 100%);padding:22px 26px;">
          <div style="font-size:17px;font-weight:700;color:#101317;letter-spacing:-0.01em;">Support Wizard.</div>
          <div style="font-size:9px;font-weight:600;letter-spacing:0.13em;text-transform:uppercase;color:#3C444E;margin-top:4px;">NetKit</div>
        </td></tr>
        <tr><td style="padding:26px;">
          <h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:#101317;font-weight:600;">${title}</h1>
          <div style="font-size:14px;line-height:1.6;color:#3C444E;">${bodyHtml}</div>
        </td></tr>
        <tr><td style="border-top:1px solid #E4E6E8;padding:16px 26px;font-size:11px;line-height:1.5;color:#66707A;">
          SupportWizard – a division of ClubWizard Ltd · 26 Fitzroy Square, London W1T 6ES<br>
          help@supportwizard.net · +44 20 7043 3171
        </td></tr>
        <tr><td style="height:3px;background:#E51032;"></td></tr>
        <tr><td style="background:#0D1B3E;padding:10px 26px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#C9D7FA;">
          SupportWizard Internal · Confidential
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Escapes text going into an HTML email.
 *
 * Needed because some of what these emails carry is not ours: a provider's
 * error string, an address out of AddressBase, a company name off the
 * register. None of it is likely to contain markup, and "unlikely" is not a
 * reason to interpolate it raw into HTML that lands in somebody's inbox.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escalation email — an integration has been failing long enough that
 * automatic recovery has demonstrably not fixed it, so a person needs to
 * know. Sent once per incident, not once per sweep.
 */
export function escalationEmail(input: {
  name: string;
  key: string;
  failingSince: string;
  lastError?: string;
  recoveryAttempts: number;
  capability: string;
}): { subject: string; html: string; text: string } {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(input.failingSince).getTime()) / 60_000));

  return {
    subject: `NetKit: ${input.name} has been failing for ${minutes} minutes`,
    html: emailLayout(
      'An integration needs attention',
      `<p><strong style="color:#101317;">${escapeHtml(input.name)}</strong> has been failing for about
       ${minutes} minutes. Automatic recovery has been attempted
       ${input.recoveryAttempts} time${input.recoveryAttempts === 1 ? '' : 's'} and has not fixed it, so it needs a
       person.</p>

       <p style="margin:18px 0;padding:14px 16px;background:#F6F7F8;border:1px solid #E4E6E8;border-radius:8px;">
         <strong style="color:#101317;">What it provides</strong><br>${escapeHtml(input.capability)}<br><br>
         <strong style="color:#101317;">Last error</strong><br>
         <span style="font-family:Consolas,monospace;font-size:12px;">${escapeHtml(input.lastError ?? 'not recorded')}</span>
       </p>

       <p>Lookups are still working — that integration is being skipped and the next provider in the chain is
       being used instead. Nothing is down for users, but that source is missing from what they see.</p>

       <p style="color:#66707A;font-size:13px;">Open the admin portal, Recovery &amp; self-test, to see the probe
       history and what recovery has tried. This is sent once per incident, not once per check.</p>`,
    ),
    text:
      `${input.name} has been failing for about ${minutes} minutes. Recovery has been attempted ` +
      `${input.recoveryAttempts} time(s) without success. Last error: ${input.lastError ?? 'not recorded'}. ` +
      `Lookups still work — the integration is being skipped and the next provider in the chain is used instead.`,
  };
}

/** Sent when an escalated integration comes back on its own. */
export function recoveryEmail(input: { name: string; downForMinutes: number }): {
  subject: string;
  html: string;
  text: string;
} {
  return {
    subject: `NetKit: ${input.name} is working again`,
    html: emailLayout(
      'Back to normal',
      `<p><strong style="color:#101317;">${input.name}</strong> is responding again after about
       ${input.downForMinutes} minutes. No action is needed.</p>
       <p style="color:#66707A;font-size:13px;">Lookups are back on live data for this integration.</p>`,
    ),
    text: `${input.name} is responding again after about ${input.downForMinutes} minutes. No action needed.`,
  };
}

/** The 2FA code email. */
export function twoFactorEmail(code: string): { subject: string; html: string; text: string } {
  return {
    subject: `${code} is your NetKit sign-in code`,
    html: emailLayout(
      'Your sign-in code',
      `<p>Use this code to finish signing in to SupportWizard NetKit:</p>
       <p style="margin:20px 0;padding:16px;background:#F6F7F8;border:1px solid #E4E6E8;border-radius:8px;text-align:center;
                 font-family:Consolas,monospace;font-size:30px;letter-spacing:0.18em;color:#101317;font-weight:700;">${code}</p>
       <p style="color:#66707A;font-size:13px;">The code expires in 10 minutes and can only be used once.
       If you didn't try to sign in, someone may have your password — change it and tell an administrator.</p>`,
    ),
    text: `Your SupportWizard NetKit sign-in code is ${code}. It expires in 10 minutes.`,
  };
}

/**
 * Something changed at a watched premises.
 *
 * The changes are already sentences by the time they reach here -- the
 * comparison that produced them knows what it compared, and rebuilding that
 * meaning from a diff in an email template would be a second place to get it
 * wrong.
 */
export function watchChangeEmail(input: {
  address: string;
  uprn: string;
  changes: string[];
}): { subject: string; html: string; text: string } {
  const subject = `Change at ${input.address}`;

  const html = emailLayout(
    'A watched premises has changed',
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;">
       Something has changed at a premises you are watching.
     </p>
     <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:#101317;">${escapeHtml(input.address)}</p>
     <p style="margin:0 0 18px;font-size:12px;color:#66707A;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
       UPRN ${escapeHtml(input.uprn)}
     </p>
     <ul style="margin:0 0 18px;padding-left:20px;font-size:14px;line-height:1.7;">
       ${input.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
     </ul>
     <p style="margin:0;font-size:12.5px;color:#66707A;line-height:1.6;">
       This is a wholesale availability check, not an order. Open the premises in NetKit to see the full picture
       before promising anything.
     </p>`,
  );

  const text = [
    'A watched premises has changed.',
    '',
    input.address,
    `UPRN ${input.uprn}`,
    '',
    ...input.changes.map((c) => `- ${c}`),
    '',
    'This is a wholesale availability check, not an order. Open the premises in NetKit before promising anything.',
  ].join('\n');

  return { subject, html, text };
}
