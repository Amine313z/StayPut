/**
 * Opening a page outside StayPut (Discord's authorization page, a Telegram link) from Whop.
 * Inside Whop's frame, or Whop's mobile app, a plain link may be blocked: Whop asks apps to go
 * through its iframe SDK (`openExternalUrl`), a postMessage protocol reproduced here so that the
 * SDK and its dependencies stay out of the bundle (docs.whop.com, Iframe SDK; @whop/iframe 0.0.6).
 */

const LIB_ID = 'typed-transport';
const WHOP = 'app_whop';
/** The pages that frame Whop apps: whop.com, its dashboard, and the sandbox. */
export const WHOP_ORIGINS = [
  'https://whop.com',
  'https://dash.whop.com',
  'https://sandbox.whop.com',
];
/** Whop answers within this time when it handled the request. */
export const WHOP_ANSWER_MS = 2_000;

type NativeBridge = { postMessage: (data: string) => void };

/** Whop's mobile app gives its web views a bridge rather than a parent frame. */
function nativeBridge(): NativeBridge | null {
  const w = window as unknown as {
    ReactNativeWebView?: Partial<NativeBridge>;
    webkit?: { messageHandlers?: { SwiftWebView?: Partial<NativeBridge> } };
  };
  const bridge = w.ReactNativeWebView ?? w.webkit?.messageHandlers?.SwiftWebView;
  return typeof bridge?.postMessage === 'function' ? (bridge as NativeBridge) : null;
}

export function insideWhop(): boolean {
  return window.parent !== window || nativeBridge() !== null;
}

/**
 * Asks Whop to open `url` (in a new tab where it can). Resolves true when Whop answered, false
 * when it did not within WHOP_ANSWER_MS: the page then offers a plain link.
 */
export function openThroughWhop(url: string, appId: string): Promise<boolean> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const event = `${appId}:openExternalUrl:${id}`;
  const message = {
    event,
    data: { url, newTab: true },
    libId: LIB_ID,
    receiverAppId: WHOP,
    senderAppId: appId,
  };
  return new Promise((resolve) => {
    const done = (answered: boolean) => {
      window.removeEventListener('message', listen);
      clearTimeout(timer);
      resolve(answered);
    };
    const listen = (reply: MessageEvent) => {
      const data: unknown = typeof reply.data === 'string' ? safeParse(reply.data) : reply.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { libId?: unknown }).libId === LIB_ID &&
        typeof (data as { event?: unknown }).event === 'string' &&
        (data as { event: string }).event.startsWith(event) &&
        (data as { senderAppId?: unknown }).senderAppId === WHOP
      ) {
        done(true);
      }
    };
    const timer = setTimeout(() => done(false), WHOP_ANSWER_MS);
    window.addEventListener('message', listen);
    const bridge = nativeBridge();
    if (bridge) {
      bridge.postMessage(JSON.stringify(message));
    } else {
      for (const targetOrigin of WHOP_ORIGINS) window.parent.postMessage(message, targetOrigin);
    }
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
