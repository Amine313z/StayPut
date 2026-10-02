import type { CreatorMessagesResult, SyncRun } from '@stayput/core';
import { isCreatorOfferKind } from '@stayput/core';
import { ApiError, DEMO_API } from '../api';
import { createWorld, type DemoWorld } from './world';

/**
 * The demo's « Worker »: answers the calls of /demo in the browser, from the imaginary community
 * of world.ts. Nothing leaves the page. What the creator does (message, offer, never contact)
 * changes the community until the page is reloaded; a page the demo has no data for answers
 * « no demo data yet ».
 */

/** A short wait, as a real answer takes: the screens show their loading and working states. */
export const DEMO_READ_MS = 250;
export const DEMO_WRITE_MS = 600;

let world: DemoWorld | null = null;

function current(): DemoWorld {
  world ??= createWorld(Date.now());
  return world;
}

/** Forgets what the creator did in the demo (tests start from the same community). */
export function resetDemo(): void {
  world = null;
}

export async function answerDemo(method: string, path: string, body: unknown): Promise<unknown> {
  await new Promise((resolve) =>
    setTimeout(resolve, method === 'GET' ? DEMO_READ_MS : DEMO_WRITE_MS),
  );
  const demo = current();
  const route = path.slice(DEMO_API.length).split('?')[0] ?? '';
  const answer = (value: unknown) => structuredClone(value);
  if (method === 'GET') {
    switch (route) {
      case 'session':
        return answer(demo.session);
      case 'members':
        return answer(demo.members);
      case 'dashboard':
        return answer(demo.dashboard());
      case 'feed':
        return answer(demo.feed());
      case 'sync':
        return answer(demo.sync);
      case 'integrations':
        return answer(demo.integrations);
      case 'settings/actions':
        return answer(demo.settings);
      case 'alumni':
        return { offer: null, entered: 0, left: 0, returned: 0 };
    }
  }
  if (method === 'POST' && route === 'sync') {
    demo.syncNow();
    return answer({ ...demo.sync, ran: true, calls: 14 } satisfies SyncRun);
  }
  if (method === 'POST' && route === 'members/message') {
    const ids = (body as { memberIds?: unknown } | null)?.memberIds;
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    return { queued: demo.message(list) } satisfies CreatorMessagesResult;
  }
  if (method === 'POST' && route === 'actions/approve') return { approved: 0 };
  const offer = /^members\/([^/]+)\/offer$/.exec(route);
  if (method === 'POST' && offer) {
    const kind = (body as { kind?: unknown } | null)?.kind;
    if (!isCreatorOfferKind(kind)) throw new ApiError('invalid_request', 'expected a kind');
    const made = demo.offer(decodeURIComponent(offer[1]!), kind);
    if ('error' in made) {
      throw made.error === 'not_a_member'
        ? new ApiError('not_found', 'no such member here')
        : new ApiError('conflict', made.error);
    }
    return made;
  }
  const contact = /^members\/([^/]+)\/contact$/.exec(route);
  if (method === 'PUT' && contact) {
    const wanted = (body as { doNotContact?: unknown } | null)?.doNotContact === true;
    const done = demo.setContact(decodeURIComponent(contact[1]!), wanted);
    if (done === null) throw new ApiError('not_found', 'no such member here');
    return { doNotContact: done };
  }
  throw new ApiError('demo', `no demo data for ${method} ${route}`);
}
