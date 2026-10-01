import { afterEach, describe, expect, it, vi } from 'vitest';
import { WHOP_ANSWER_MS, WHOP_ORIGINS, insideWhop, openThroughWhop } from '../src/external';

/**
 * Opening a link from inside Whop's frame: the message Whop's iframe SDK would send
 * (`openExternalUrl`), to Whop's origins only, and the answer that confirms it.
 */

const realParent = Object.getOwnPropertyDescriptor(window, 'parent');

function framedBy(parent: { postMessage: (...args: unknown[]) => void }) {
  Object.defineProperty(window, 'parent', { configurable: true, value: parent });
}

afterEach(() => {
  if (realParent) Object.defineProperty(window, 'parent', realParent);
  vi.useRealTimers();
});

describe('openThroughWhop', () => {
  it('is only needed inside a frame', () => {
    expect(insideWhop()).toBe(false);
    framedBy({ postMessage: () => {} });
    expect(insideWhop()).toBe(true);
  });

  it('asks Whop to open the link in a new tab, and knows when Whop did', async () => {
    const posted: { message: unknown; origin: unknown }[] = [];
    framedBy({ postMessage: (message, origin) => posted.push({ message, origin }) });
    const opened = openThroughWhop('https://discord.com/oauth2/authorize?x=1', 'app_stayput');
    expect(posted.map((p) => p.origin)).toEqual(WHOP_ORIGINS);
    const message = posted[0]!.message as { event: string };
    expect(message).toEqual({
      event: expect.stringMatching(/^app_stayput:openExternalUrl:[0-9a-f]{12}$/) as string,
      data: { url: 'https://discord.com/oauth2/authorize?x=1', newTab: true },
      libId: 'typed-transport',
      receiverAppId: 'app_whop',
      senderAppId: 'app_stayput',
    });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          event: message.event,
          data: 'ok',
          libId: 'typed-transport',
          receiverAppId: 'app_stayput',
          senderAppId: 'app_whop',
        },
      }),
    );
    expect(await opened).toBe(true);
  });

  it('gives up when Whop does not answer, so the page offers the plain link', async () => {
    vi.useFakeTimers();
    framedBy({ postMessage: () => {} });
    const opened = openThroughWhop('https://t.me/StayPutBot?start=x', 'app_stayput');
    await vi.advanceTimersByTimeAsync(WHOP_ANSWER_MS);
    expect(await opened).toBe(false);
  });
});
