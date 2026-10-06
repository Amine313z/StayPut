import type { ApiErrorBody, ApiErrorCode } from '@stayput/core';

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  whop_unavailable: 503,
  not_configured: 503,
  internal: 500,
};

/** Every API error has this shape; the frontend maps `code` to a translated message. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  extra: Pick<ApiErrorBody['error'], 'login'> = {},
): Response {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return Response.json(body, { status: STATUS[code] });
}

/**
 * A request's or a response's body, or null once it passes `maxBytes`. Read chunk by chunk: a
 * body sent without a Content-Length (chunked) is never taken whole into memory before it is
 * refused.
 */
export async function readBytesCapped(
  message: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = message.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return null;
  if (!message.body) return new Uint8Array(0);
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** A request's body as text (UTF-8), or null once it passes `maxBytes` (readBytesCapped). */
export async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBytesCapped(request, maxBytes);
  return bytes && new TextDecoder().decode(bytes);
}

/** Headers of every response the Worker itself produces (API, webhooks, health). */
export const API_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
