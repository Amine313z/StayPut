import type {
  ActionSettingsView,
  CreatorMessagesResult,
  CreatorOffersResult,
  CreatorRetryResult,
  RiskSettingsView,
  SyncRun,
} from '@stayput/core';
import { ACTION_VIEWS, isCreatorOfferKind } from '@stayput/core';
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
  // What members did since the last answer: every page tells the same community.
  world.advance(Date.now());
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
  const [route = '', query = ''] = path.slice(DEMO_API.length).split('?');
  const answer = (value: unknown) => structuredClone(value);
  const pages = demo.pages;
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
        return answer(pages.integrations(demo.integrations));
      case 'settings/actions':
        return answer(demo.settings);
      case 'settings/risk':
        return answer(pages.riskSettings());
      case 'alumni':
        return answer(pages.alumni());
      case 'actions': {
        const view = ACTION_VIEWS.find((v) => v === new URLSearchParams(query).get('view'));
        return answer(pages.actions(view ?? 'queue'));
      }
      case 'insights':
        return answer(pages.insights);
      case 'people':
        return answer(pages.people());
      case 'accounts':
        return answer(pages.accounts());
    }
    if (/^discord\/[^/]+\/channels$/.test(route)) return answer(pages.discordChannels());
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
  if (method === 'POST' && route === 'payments/retry') {
    return { queued: demo.retry() } satisfies CreatorRetryResult;
  }
  if (method === 'POST' && route === 'members/offers') {
    const { memberIds, kind } = (body ?? {}) as { memberIds?: unknown; kind?: unknown };
    if (!isCreatorOfferKind(kind) || !Array.isArray(memberIds)) {
      throw new ApiError('invalid_request', 'expected { memberIds, kind }');
    }
    const ids = [...new Set(memberIds.filter((id): id is string => typeof id === 'string'))];
    const made = ids.filter((id) => !('error' in demo.offer(id, kind))).length;
    return { made, refused: ids.length - made } satisfies CreatorOffersResult;
  }
  if (method === 'POST' && route === 'actions/approve') {
    const ids = (body as { ids?: unknown } | null)?.ids;
    const chosen = Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string')
      : undefined;
    return { approved: pages.approve(chosen) };
  }
  const cancel = /^actions\/([^/]+)\/cancel$/.exec(route);
  if (method === 'POST' && cancel) {
    if (!pages.cancel(decodeURIComponent(cancel[1]!))) {
      throw new ApiError('conflict', 'this action can no longer be cancelled');
    }
    return { cancelled: true };
  }
  if (method === 'POST' && route === 'platform-activity/refresh') {
    return answer(pages.platformActivity());
  }
  const account = /^accounts\/(link|unlink|dismiss|restore)$/.exec(route);
  if (method === 'POST' && account) {
    const next = pages.changeAccount(account[1]!, (body ?? {}) as Record<string, unknown>);
    if (!next) throw new ApiError('not_found', 'no such account here');
    return answer(next);
  }
  if (method === 'PUT' && route === 'settings/risk') {
    return answer(pages.saveRiskSettings(body as RiskSettingsView));
  }
  if (method === 'POST' && route === 'alumni') return answer(pages.alumni());
  if (method === 'PUT' && /^discord\/[^/]+\/channels$/.test(route)) {
    const ids = (body as { channelIds?: unknown } | null)?.channelIds;
    return answer(
      pages.saveDiscordChannels(
        Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
      ),
    );
  }
  const server = /^discord\/([^/]+)$/.exec(route);
  if (method === 'DELETE' && server) {
    demo.disconnect('discord', decodeURIComponent(server[1]!));
    return { removed: true };
  }
  const group = /^telegram\/([^/]+)$/.exec(route);
  if (method === 'DELETE' && group) {
    demo.disconnect('telegram', decodeURIComponent(group[1]!));
    return { removed: true };
  }
  if (method === 'POST' && route === 'getting-started/reviewed') {
    demo.started('reviewed');
    return { done: true };
  }
  if (method === 'POST' && route === 'test-mode/off') return answer(demo.testModeOff());
  if (method === 'POST' && route === 'getting-started/welcomed') return { done: true };
  if (method === 'POST' && route === 'mode') {
    const mode = (body as { mode?: unknown } | null)?.mode;
    if (mode !== 'auto' && mode !== 'manual') {
      throw new ApiError('invalid_request', 'expected { mode: "auto" | "manual" }');
    }
    return answer(demo.setMode(mode));
  }
  if (method === 'PUT' && route === 'settings/actions') {
    return answer(demo.saveSettings(body as ActionSettingsView));
  }
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
