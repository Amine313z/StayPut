import { WebhookVerificationError, unwrapWebhook } from '@whop/sdk/helpers';

/**
 * Whop signs webhooks the Standard Webhooks way: base64(HMAC-SHA256(secret,
 * "<webhook-id>.<webhook-timestamp>.<raw body>")) in `webhook-signature` as `v1,<signature>`
 * (several, space-separated, during a secret rotation). The signature is checked by Whop's own
 * SDK (`unwrapWebhook`, @whop/sdk/helpers, on the `ws_…` secret as Whop shows it), never by
 * hand (decision of 2026-10-10); what is around it here only says why a delivery is refused.
 */

/** Deliveries older or newer than this are refused (replay protection). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookVerification =
  | { ok: true; id: string; timestamp: number }
  | {
      ok: false;
      reason:
        | 'missing_secret'
        | 'missing_headers'
        | 'invalid_timestamp'
        | 'timestamp_out_of_range'
        | 'invalid_signature';
    };

/** A delivery checked: its id and time when Whop signed it, else why it is refused. */
export function verifyWebhook(
  rawBody: string,
  headers: Headers,
  secret: string | undefined,
  now: Date,
): Promise<WebhookVerification> {
  return Promise.resolve(verify(rawBody, headers, secret, now));
}

function verify(
  rawBody: string,
  headers: Headers,
  secret: string | undefined,
  now: Date,
): WebhookVerification {
  if (!secret) return { ok: false, reason: 'missing_secret' };
  const id = headers.get('webhook-id');
  const timestampHeader = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestampHeader || !signatures) return { ok: false, reason: 'missing_headers' };

  if (!/^\d{1,12}$/.test(timestampHeader)) return { ok: false, reason: 'invalid_timestamp' };
  const timestamp = Number(timestampHeader);
  if (Math.abs(now.getTime() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  try {
    unwrapWebhook(rawBody, {
      headers: {
        'webhook-id': id,
        'webhook-timestamp': timestampHeader,
        'webhook-signature': signatures,
      },
      key: secret,
    });
  } catch (error) {
    // The SDK parses the body once the signature holds: a body that is not JSON is signed, and
    // refused later as a bad request, never as a forgery.
    if (!(error instanceof WebhookVerificationError)) {
      if (error instanceof SyntaxError) return { ok: true, id, timestamp };
      return { ok: false, reason: 'invalid_signature' };
    }
    // It checks the time too, against the clock: a delivery too old is no signature error.
    if (/timestamp/i.test(error.message)) return { ok: false, reason: 'timestamp_out_of_range' };
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true, id, timestamp };
}

/** The `webhook-signature` value Whop would send: for tests and local replays. */
export async function signWebhook(
  rawBody: string,
  secret: string,
  id: string,
  timestamp: number,
): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  return `v1,${btoa(String.fromCharCode(...signature))}`;
}

function hmacKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}
