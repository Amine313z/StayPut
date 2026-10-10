import { describe, expect, it } from 'vitest';
import type { MembersPage, PlatformDashboard } from '@stayput/core';
import { ApiError, DEMO_API } from '../src/api';
import { answerDemo, resetDemo } from '../src/demo/api';

/**
 * /demo answers every reading of the creator's dashboard the way the Worker does (apps/worker
 * app.ts): no screen of the demo can fall on « no demo data » or a 404. The member space's
 * readings (goals, buddies, rescues) and the operator's status stay out: neither shows in the
 * demo (MEMBER_SPACE_ENABLED, OPERATOR_COMPANY_ID).
 */

const READINGS = [
  'session',
  'members',
  'dashboard',
  'feed',
  'sync',
  'integrations?lang=en',
  'settings/actions',
  'settings/risk',
  'insights',
  'insights/overview',
  'alumni',
  'actions?view=queue',
  'actions?view=scheduled',
  'actions?view=history',
  'people',
  'accounts',
  'reports',
  'team',
  'export',
  'benchmarks',
  'badge',
  'platforms/whop',
  'platforms/discord',
  'platforms/telegram',
];

const read = (route: string) => answerDemo('GET', `${DEMO_API}${route}`, null);

describe('the demo’s answers', () => {
  it('reads every page of the dashboard, each with data', async () => {
    resetDemo();
    const answers = await Promise.all(READINGS.map(async (route) => [route, await read(route)]));
    for (const [route, answer] of answers) {
      expect(answer, String(route)).toBeTruthy();
    }
  });

  it('opens each member, their file, and a day and an hour of each platform', async () => {
    resetDemo();
    const { members } = (await read('members')) as MembersPage;
    const someone = members.find((m) => m.status === 'joined')!;
    const id = encodeURIComponent(someone.id);
    const [detail, file] = await Promise.all([read(`members/${id}`), read(`members/${id}/export`)]);
    expect(detail).toMatchObject({ memberId: someone.id });
    expect(file).toMatchObject({ member: { id: someone.id } });
    for (const platform of ['whop', 'discord', 'telegram'] as const) {
      const view = (await read(`platforms/${platform}`)) as PlatformDashboard;
      const busy = view.daily.findLast((d) => d.messages > 0)!;
      const cell = view.heatmap[0]!;
      const [day, slot] = await Promise.all([
        read(`platforms/${platform}/days/${busy.day}`),
        read(`platforms/${platform}/slots/${cell.dow}/${cell.hour}`),
      ]);
      expect(day, platform).toMatchObject({ day: busy.day, messages: busy.messages });
      expect(slot, platform).toMatchObject({ dow: cell.dow, hour: cell.hour });
    }
  });

  it('says « not found » for a member or a page it does not know, as the Worker does', async () => {
    resetDemo();
    for (const route of ['members/mber_Nobody', 'members/mber_Nobody/export', 'nothing-here']) {
      await expect(read(route), route).rejects.toBeInstanceOf(ApiError);
    }
  });
});
