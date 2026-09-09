import { config } from '../config';
import { audit } from '../auth/store';
import { emailLayout, sendEmail } from '../auth/email';
import { createInternalTicket, zendeskConfigured } from '../providers/tickets/zendesk';

/**
 * Where an outbound notice goes.
 *
 * NetKit has two ways of telling a person something: an internal Zendesk
 * ticket, or a transactional email through Resend. Zendesk comes first, and
 * not only because Joe would rather not pay for a mailer — a ticket lands in
 * the queue the team already watches, it keeps its own history, and it can be
 * assigned and closed. An email is read once and then it is gone.
 *
 * Resend stays as the fallback for a deployment that has no Zendesk, and for
 * the two things that must never go near a shared agent queue:
 *
 *   - sign-in codes, and
 *   - temporary passwords.
 *
 * Those are credentials. A 2FA code sitting in a ticket that any agent can
 * open is not two-factor authentication, so `sendNotice` is deliberately not
 * the route for them: they call `sendEmail` directly and stay email-only
 * until the Microsoft 365 sign-in work lands, which is where they belong.
 *
 * Nothing here throws. A notice that cannot be delivered is recorded in the
 * audit log with the reason, because a sweep or an escalation must not fail
 * because the mailer is down.
 */

export type NotifyChannel = 'zendesk' | 'email' | 'none';

export interface NotifyRequest {
  /** Subject line, and the ticket subject. */
  subject: string;
  /** Plain text. This is what a Zendesk ticket carries, so write it readable. */
  text: string;
  /**
   * Optional HTML for the email path. Omitted, the text is wrapped in the
   * brand layout, so a caller only writes HTML when it has a reason to.
   */
  html?: string;
  /** People who should see it. Zendesk adds them as collaborators. */
  recipients: string[];
  /** Extra Zendesk tags, on top of the alert tag the provider always sets. */
  tags?: string[];
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Who should own the ticket, when there is an obvious owner. */
  assigneeEmail?: string;
}

export interface NotifyResult {
  channel: NotifyChannel;
  ok: boolean;
  /** How many recipients were actually reached. */
  delivered: number;
  ticketId?: string;
  url?: string;
  error?: string;
  /** Set when Zendesk was tried first and failed, so email picked it up. */
  fellBackFrom?: NotifyChannel;
}

/** Whether the email path can be attempted at all. */
export const emailUsable = (): boolean => config().resend.configured;

/**
 * Which channel wins, given what is configured.
 *
 * Split out from the config read so the precedence can be tested without a
 * process whose environment has to be rebuilt for every case — `config()`
 * memoises on first call, so a test that wanted three orderings would need
 * three processes.
 */
export function pickChannel(hasZendesk: boolean, hasEmail: boolean): NotifyChannel {
  if (hasZendesk) return 'zendesk';
  if (hasEmail) return 'email';
  return 'none';
}

/**
 * The channel a notice would use right now.
 *
 * Exposed so the admin status board can say which one is live, rather than
 * leaving somebody to infer it from which keys are filled in.
 */
export function notifyChannel(): NotifyChannel {
  return pickChannel(zendeskConfigured(), emailUsable());
}

/** A sentence for the status board and the handover docs. */
export function channelDetail(channel: NotifyChannel, hasEmail: boolean): string {
  switch (channel) {
    case 'zendesk':
      return hasEmail
        ? 'Notices are raised as internal Zendesk tickets, with email as the fallback if Zendesk rejects one.'
        : 'Notices are raised as internal Zendesk tickets. There is no email fallback configured.';
    case 'email':
      return 'Notices are emailed through Resend. Configure Zendesk to raise them as tickets instead.';
    default:
      return 'Nothing is configured to send notices — they are recorded in the audit log only.';
  }
}

export function notifyChannelDetail(): string {
  return channelDetail(notifyChannel(), emailUsable());
}

async function viaEmail(input: NotifyRequest): Promise<NotifyResult> {
  const html = input.html ?? emailLayout(input.subject, textToHtml(input.text));
  const results = await Promise.all(
    input.recipients.map((to) => sendEmail(to, input.subject, html, input.text)),
  );
  const delivered = results.filter((r) => r.ok).length;
  const firstError = results.find((r) => !r.ok)?.error;
  return {
    channel: 'email',
    ok: delivered > 0,
    delivered,
    ...(delivered === 0 && firstError ? { error: firstError } : {}),
  };
}

/**
 * Sends a notice down whichever channel is available.
 *
 * `action` is the audit action to record under, so the caller keeps its own
 * vocabulary ('supervisor.escalated', 'watch.notified') and the delivery
 * outcome is attached to the event it belongs to rather than to a generic
 * 'notify' row nobody would think to search for.
 */
export async function sendNotice(
  input: NotifyRequest,
  action: string,
  detail: Record<string, unknown> = {},
  /**
   * Whether a person asked for this notice.
   *
   * Defaults to `automatic` because every caller today is a sweep on a timer,
   * and because the two ways of being wrong are not symmetrical: labelling a
   * person's action as automatic understates who did it, while labelling
   * automatic work as a person's invents a decision nobody made. A human
   * path must say so.
   */
  origin: 'automatic' | 'person' = 'automatic',
): Promise<NotifyResult> {
  const recipients = [...new Set(input.recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
  const request = { ...input, recipients };

  let result: NotifyResult;

  if (zendeskConfigured()) {
    try {
      const ticket = await createInternalTicket({
        subject: request.subject,
        body: request.text,
        ...(request.assigneeEmail ? { assigneeEmail: request.assigneeEmail } : {}),
        ...(recipients.length ? { ccEmails: recipients } : {}),
        ...(request.tags ? { tags: request.tags } : {}),
        ...(request.priority ? { priority: request.priority } : {}),
      });
      result = {
        channel: 'zendesk',
        ok: true,
        delivered: recipients.length,
        ticketId: ticket.ticketId,
        ...(ticket.url ? { url: ticket.url } : {}),
      };
    } catch (err) {
      const zendeskError = err instanceof Error ? err.message : String(err);
      // Zendesk was there and said no. If there is a mailer, use it rather
      // than losing the notice, and keep the original reason in the record.
      if (emailUsable() && recipients.length) {
        const fallback = await viaEmail(request);
        result = {
          ...fallback,
          fellBackFrom: 'zendesk',
          error: fallback.ok ? zendeskError : `${zendeskError}; email also failed: ${fallback.error}`,
        };
      } else {
        result = { channel: 'zendesk', ok: false, delivered: 0, error: zendeskError };
      }
    }
  } else if (emailUsable() && recipients.length) {
    result = await viaEmail(request);
  } else {
    result = {
      channel: 'none',
      ok: false,
      delivered: 0,
      error: recipients.length
        ? 'No notification channel is configured (set ZENDESK_* or RESEND_API_KEY).'
        : 'Nobody to notify.',
    };
  }

  audit({
    action,
    ...(origin === 'automatic' ? { automatic: true } : {}),
    detail: {
      ...detail,
      subject: request.subject,
      channel: result.channel,
      recipients: recipients.length,
      delivered: result.delivered,
      ...(result.ticketId ? { ticketId: result.ticketId } : {}),
      ...(result.fellBackFrom ? { fellBackFrom: result.fellBackFrom } : {}),
      ...(result.ok ? {} : { notifyFailed: result.error }),
    },
  });

  return result;
}

/**
 * Turns the plain-text body into the paragraphs and bullets the email layout
 * expects, so a caller can write one body and have both channels read well.
 *
 * Escapes as it goes: some of what these notices carry is a provider's error
 * string or an address out of AddressBase, and none of it should be able to
 * put markup in somebody's inbox.
 */
export function textToHtml(text: string): string {
  const escape = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  return blocks
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.every((l) => /^[-*•]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${escape(l.replace(/^[-*•]\s+/, ''))}</li>`).join('');
        return `<ul style="margin:0 0 16px;padding-left:20px;line-height:1.7;">${items}</ul>`;
      }
      return `<p style="margin:0 0 14px;line-height:1.6;">${lines.map(escape).join('<br>')}</p>`;
    })
    .join('');
}
