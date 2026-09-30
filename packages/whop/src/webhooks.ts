/**
 * Whop signs webhooks the Standard Webhooks way: base64(HMAC-SHA256(secret,
 * "<webhook-id>.<webhook-timestamp>.<raw body>")) in `webhook-signature` as `v1,<signature>`
 * (several, space-separated, during a secret rotation). The HMAC key is the literal bytes of
 * the `ws_…` secret, prefix included, exactly as Whop's own `unwrapWebhook` does.
 *
 * WebCrypto only: it runs unchanged in the Worker, and `crypto.subtle.verify` compares in
 * constant time.
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

export async function verifyWebhook(
  rawBody: string,
  headers: Headers,
  secret: string | undefined,
  now: Date,
): Promise<WebhookVerification> {
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

  const key = await hmacKey(secret, 'verify');
  const signed = new TextEncoder().encode(`${id}.${timestampHeader}.${rawBody}`);
  for (const entry of signatures.split(' ')) {
    const [version, signature] = entry.split(',', 2);
    if (version !== 'v1' || !signature) continue;
    const bytes = decodeBase64(signature);
    if (bytes && (await crypto.subtle.verify('HMAC', key, bytes, signed))) {
      return { ok: true, id, timestamp };
    }
  }
  return { ok: false, reason: 'invalid_signature' };
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

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
