import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HIGH_FROM,
  RISK_FACTORS,
  addDays,
  scoreDistribution,
  zonedDay,
  zonedMoment,
  type MemberRow,
  type RevenueDay,
} from '@stayput/core';
import { createTranslator } from '@stayput/i18n';
import { DEMO_WHOP_ID } from '../src/api';
import { membershipLine } from '../src/components/MemberRows';
import { renewalText, stateText } from '../src/components/MemberTable';
import { createWorld } from '../src/demo/world';
import { keepMember, memberState, pausedUntil, unpaidSince } from '../src/members';
import { balanceWindow, savedOver } from '../src/views/creator/balance';

const NOW = Date.parse('2026-10-02T10:00:00.000Z');
const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);

describe('the demo community', () => {
  const world = createWorld(NOW);
  const joined = world.members.members.filter((m) => m.status === 'joined');

  it('is the same community at every visit (screenshots match)', () => {
    expect(createWorld(NOW).members).toEqual(world.members);
    expect(createWorld(NOW).dashboard()).toEqual(world.dashboard());
  });

  it('keeps its own clock: the same day of the demo whatever the real date', () => {
    // Everything is dated from `now`: the real date must change nothing, the 5-day windows
    // included (they drifted on 2026-10-07, five days after NOW, when they read the real clock).
    // Each demo made and read on its own day (time never runs backwards inside one).
    const seenOn = (realDate: number) => {
      vi.setSystemTime(realDate);
      const demo = createWorld(NOW);
      return {
        dashboard: demo.dashboard(),
        queue: demo.pages.actions('queue'),
        reached: [...demo.pages.reached()].sort(),
      };
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(seenOn(NOW + 40 * 86_400_000)).toEqual(seenOn(NOW));
    } finally {
      vi.useRealTimers();
    }
  });

  it('looks real: full names, each once, never a test placeholder', () => {
    const names = world.members.members.map((m) => m.name ?? '');
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^\p{Lu}[\p{L}’-]+ \p{Lu}[\p{L}’-]+$/u);
      expect(name.toLowerCase()).not.toMatch(/test|demo|lorem|foo|user/);
    }
    expect(world.session.companyName).not.toMatch(/test|demo/i);
    // 25 to 40 members (brief v3 §11): 35 here, and four who left.
    expect(joined.length).toBe(35);
    expect(world.members.members.length).toBeLessThanOrEqual(40);
  });

  it('adds up: the home says what the members are', () => {
    const { summary } = world.members;
    const home = world.dashboard();
    expect(summary.members).toBe(joined.length);
    expect(home.members.total).toBe(joined.length);
    const levels = { scheduled_departure: 0, high: 0, medium: 0, low: 0 };
    for (const member of joined) if (member.risk) levels[member.risk.level] += 1;
    expect(summary.risk).toMatchObject({
      scheduledDeparture: levels.scheduled_departure,
      high: levels.high,
      medium: levels.medium,
      low: levels.low,
    });
    expect(home.atRisk).toEqual({
      revenue: summary.revenue!.atRisk,
      members: levels.scheduled_departure + levels.high,
      departures: levels.scheduled_departure,
      high: levels.high,
    });
    expect(home.monthlyRevenue).toBe(summary.revenue!.monthly);
    expect(summary.scheduledCancellations).toBe(3);
    expect(summary.failedPayments).toBe(3);
    // Today's line of the history is today's count.
    const today = home.riskHistory.at(-1)!;
    expect(home.riskHistory).toHaveLength(30);
    expect(today.departure + today.high).toBe(home.atRisk.members);
    expect(home.retention30.rate).toBeGreaterThan(0.85);
    expect(home.retention30.rate).toBeLessThan(1);
  });

  it('tells one story, from the hero row to the chart', () => {
    const home = world.dashboard();
    const history = home.revenueHistory;
    // As the Worker sends it: from the 1st of the month 89 days ago (4 July) to today.
    expect(history[0]!.day).toBe('2026-07-01');
    expect(history.at(-1)!.day).toBe('2026-10-02');
    expect(history).toHaveLength(94);
    // Today's risk is the hero row's; three months ago it was higher (StayPut at work).
    expect(history.at(-1)!.atRisk).toBe(home.atRisk.revenue);
    expect(history[0]!.atRisk).toBeGreaterThan(home.atRisk.revenue);
    expect(history.every((d) => d.atRisk !== null && d.atRisk > 0)).toBe(true);
    // Credible: a payment saved every few days, a fraction of what the community earns.
    const last30 = savedOver(history, 30);
    expect(last30).toBeGreaterThan(0);
    expect(last30 / home.monthlyRevenue!).toBeLessThan(0.25);
  });

  it('has one number for the money saved: the hero, the chart, the members saved (§13)', () => {
    const home = world.dashboard();
    const history = home.revenueHistory;
    // The hero is the month's days added up, nothing forced: the chart's today says it too.
    expect(balanceWindow(history, 30).days.at(-1)!.inMonth).toBe(home.saved.thisMonth.direct);
    expect(home.saved.thisMonth.direct).toBeGreaterThan(0);
    // Each save is a member's plan, at its price.
    const member = (id: string) => world.members.members.find((m) => m.id === id)!;
    for (const save of world.saves)
      expect(save.amount).toBe(member(save.memberId).membership!.price);
    // « Members saved » are the chart's last 30 days, each member once: their plans add up to
    // what the chart saved in those days.
    const days = new Set(history.slice(-30).map((d) => d.day));
    const saved = world.saves.filter((save) =>
      days.has(zonedDay(Date.parse(save.at), 'Europe/Paris')),
    );
    const ids = saved.map((save) => save.memberId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(home.stayputActions30d.saved).toBe(ids.length);
    const plans = ids.reduce((total, id) => total + member(id).membership!.price!, 0);
    expect(Math.round(plans * 100) / 100).toBe(savedOver(history, 30));
    // The feed's saves are among them, and a member saved this period paid last that day.
    for (const item of world.feed().items.filter((i) => i.event === 'saved')) {
      expect(saved.find((save) => save.memberId === item.memberId)?.amount).toBe(item.amount);
    }
    for (const save of saved) expect(member(save.memberId).lastPayment!.at).toBe(save.at);
  });

  it('counts each save on its day in the community’s time zone, at 00:30 as at 23:30', () => {
    const on = (history: readonly RevenueDay[], day: string) =>
      history.find((entry) => entry.day === day)?.saved;
    // 3 October, 01:11 in Paris: Clara Faure was saved at 00:30, still 2 October in UTC.
    const paris = createWorld(Date.parse('2026-10-02T23:11:00Z'), 'Europe/Paris');
    expect(paris.settings.timezone).toBe('Europe/Paris');
    let home = paris.dashboard();
    expect(home.revenueHistory.at(-1)!.day).toBe('2026-10-03');
    expect(on(home.revenueHistory, '2026-10-03')).toBe(49);
    // Anaïs Robin (149) at 23:11 and Arthur Lemoine (49) in the morning: 1 October.
    expect(on(home.revenueHistory, '2026-10-01')).toBe(198);
    expect(on(home.revenueHistory, '2026-10-02')).toBe(0);
    expect(home.saved.thisMonth.direct).toBe(247);
    // 3 October, 01:30 in New York: Anaïs Robin was saved at 23:30 on 1 October, already the
    // 2nd in UTC.
    const newYork = createWorld(Date.parse('2026-10-03T05:30:00Z'), 'America/New_York');
    home = newYork.dashboard();
    expect(home.revenueHistory.at(-1)!.day).toBe('2026-10-03');
    expect(on(home.revenueHistory, '2026-10-01')).toBe(198);
    expect(on(home.revenueHistory, '2026-10-02')).toBe(0);
    expect(on(home.revenueHistory, '2026-10-03')).toBe(49);
    expect(home.saved.thisMonth.direct).toBe(247);
    // Another zone in Settings › Automations: the same saves on that zone's days, at once.
    paris.saveSettings({ ...paris.settings, timezone: 'America/New_York' });
    home = paris.dashboard();
    expect(home.revenueHistory.at(-1)!.day).toBe('2026-10-02');
    expect(on(home.revenueHistory, '2026-10-02')).toBe(49);
    // Whatever the zone, the month's days add up to the hero, the history starts on a 1st.
    for (const zone of ['Pacific/Honolulu', 'Asia/Tokyo', 'Australia/Sydney', 'UTC']) {
      const world = createWorld(NOW, zone);
      const view = world.dashboard();
      const month = view.revenueHistory.at(-1)!.day.slice(0, 7);
      expect(view.revenueHistory.at(-1)!.day, zone).toBe(zonedDay(NOW, zone));
      expect(view.revenueHistory[0]!.day.endsWith('-01'), zone).toBe(true);
      expect(
        Math.round(
          view.revenueHistory
            .filter((entry) => entry.day.startsWith(month))
            .reduce((total, entry) => total + entry.saved, 0) * 100,
        ) / 100,
        zone,
      ).toBe(view.saved.thisMonth.direct);
      const days = new Set(view.revenueHistory.map((entry) => entry.day));
      for (const save of world.saves) {
        const day = zonedDay(Date.parse(save.at), zone);
        if (days.has(day)) expect(on(view.revenueHistory, day), zone).toBeGreaterThan(0);
      }
    }
  });

  it('shows « Getting started » half done, and ticks the steps the visitor takes', () => {
    const demo = createWorld(NOW);
    expect(demo.dashboard().gettingStarted).toEqual({
      discord: true,
      automation: true,
      reviewed: false,
      guardrails: false,
    });
    demo.started('reviewed');
    expect(demo.saveSettings({ ...demo.settings, maxMessagesPerMonth: 3 })).toMatchObject({
      maxMessagesPerMonth: 3,
    });
    expect(demo.dashboard().gettingStarted).toEqual({
      discord: true,
      automation: true,
      reviewed: true,
      guardrails: true,
    });
  });

  it('goes through the actions of the day the way the Worker chooses them, never calm', () => {
    const demo = createWorld(NOW);
    const queue = demo.pages.actions('queue');
    expect(queue.counts).toEqual({ queue: 6, scheduled: 3, history: 32 });
    // What StayPut prepared first (Kevin's annual plan counts a twelfth a month).
    expect(demo.dashboard().priority).toEqual({
      kind: 'approve',
      actions: 6,
      members: 6,
      revenue: 384.17,
    });
    // Approved, they leave at their hour; the three failed payments come next (brief v3 §6.2).
    expect(demo.pages.approve()).toBe(6);
    expect(demo.pages.actions('scheduled').counts).toEqual({ queue: 0, scheduled: 9, history: 32 });
    expect(demo.dashboard().priority).toEqual({ kind: 'retry', payments: 3, revenue: 347 });
    expect(demo.retry()).toBe(3);
    expect(demo.retry()).toBe(0);
    // Then a pause for the three members leaving.
    const pause = demo.dashboard().priority;
    expect(pause).toMatchObject({ kind: 'pause', revenue: 237.17 });
    const leaving = pause?.kind === 'pause' ? pause.memberIds : [];
    expect(leaving.map((id) => joined.find((m) => m.id === id)?.name)).toEqual([
      'Hugo Bernard',
      'Margaux Picard',
      'Kevin Nguyen',
    ]);
    for (const id of leaving)
      expect(demo.offer(id, 'pause_offer')).toMatchObject({ kind: 'pause_offer' });
    // Then the member at high risk nobody reached.
    const message = demo.dashboard().priority;
    const ids = message?.kind === 'message' ? message.memberIds : [];
    expect(ids.map((id) => joined.find((m) => m.id === id)?.name)).toEqual(['Théo Fontaine']);
    expect(demo.message(ids)).toBe(1);
    // Nothing left to do, but three payments are still unpaid: never « nothing urgent ».
    expect(demo.dashboard().priority).toEqual({
      kind: 'review',
      filter: 'failed',
      members: 3,
      revenue: 347,
    });
  });

  it('opens on its dashboard, and keeps the welcome’s choice of mode', () => {
    const demo = createWorld(NOW);
    // The demo never welcomes by itself (`/demo?welcome` asks for it).
    expect(demo.dashboard().welcomed).toBe(true);
    expect(demo.setMode('auto')).toMatchObject({ mode: 'auto' });
    expect(demo.dashboard().mode).toBe('auto');
    expect(demo.setMode('manual').mode).toBe('manual');
  });

  it('takes a Discord server or a Telegram group off, as the Worker does', () => {
    const demo = createWorld(NOW);
    const [server] = demo.integrations.discord.servers;
    const [group] = demo.integrations.telegram.groups;
    demo.disconnect('discord', server!.guildId);
    demo.disconnect('telegram', group!.chatId);
    expect(demo.integrations.discord.servers.map((s) => s.guildId)).not.toContain(server!.guildId);
    // The group goes, rather than staying « removed » (the bot is gone from it).
    expect(demo.integrations.telegram.groups.map((g) => g.chatId)).not.toContain(group!.chatId);
  });

  it('opens each member’s drawer on what their row says (§13: one story)', () => {
    const demo = createWorld(NOW);
    for (const row of demo.members.members) {
      const detail = demo.memberDetail(row.id)!;
      // The score ends on today's; none before a member is scored.
      if (row.risk) expect(detail.scores.at(-1)?.score).toBe(row.risk.score);
      else expect(detail.scores).toEqual([]);
      expect(detail.scores.length).toBeLessThanOrEqual(30);
      // The latest payment is the row's, and every payment is the plan's price.
      if (row.lastPayment) {
        expect(detail.payments[0]).toMatchObject({
          status: row.lastPayment.status,
          at: row.lastPayment.at,
          amount: row.membership?.price,
        });
      } else expect(detail.payments).toEqual([]);
      expect(detail.memberships.map((m) => m.status)).toEqual(
        row.membership ? [row.membership.status] : [],
      );
      // What they did, place by place, adds up to their row's 30 days.
      const total = row.activity.messages + row.activity.reactions + row.activity.posts;
      expect(sum(detail.platforms.map((p) => p.events))).toBeLessThanOrEqual(
        total + row.activity.lessons,
      );
      expect(detail.platforms.map((p) => p.platform)).toEqual(['whop', 'discord', 'telegram']);
    }
    // Sarah's last payment failed: it heads her payments.
    const sarah = joined.find((m) => m.name === 'Sarah Cohen')!;
    expect(demo.memberDetail(sarah.id)?.payments[0]).toMatchObject({
      status: 'failed',
      failureReason: 'Card declined',
    });
    // Margaux's Discord account still waits to be tied: nothing counted for her there yet.
    const margaux = joined.find((m) => m.name === 'Margaux Picard')!;
    expect(demo.memberDetail(margaux.id)?.platforms[1]).toMatchObject({
      platform: 'discord',
      linked: false,
      events: 0,
    });
    expect(demo.memberDetail('mber_nobody')).toBeNull();
  });

  it('remembers what the creator did until the page is reloaded', () => {
    const demo = createWorld(NOW);
    const target = joined.find((m) => m.name === 'Théo Fontaine')!.id;
    expect(demo.message([target])).toBe(1);
    expect(demo.offer(target, 'pause_offer')).toMatchObject({
      kind: 'pause_offer',
      terms: { days: 30 },
    });
    expect(demo.offer(target, 'promo_offer')).toEqual({ error: 'offer_open' });
    expect(demo.setContact(target, true)).toBe(true);
    expect(demo.message([target])).toBe(0);
    // A member who left is no one's to make an offer to.
    const gone = demo.members.members.find((m) => m.status === 'left')!;
    expect(demo.offer(gone.id, 'promo_offer')).toEqual({ error: 'not_a_member' });
    // Cancelled before it left: in the history.
    const scheduled = demo.pages.actions('scheduled').actions[0]!;
    expect(demo.pages.cancel(scheduled.id)).toBe(true);
    expect(demo.pages.cancel(scheduled.id)).toBe(false);
    expect(demo.pages.actions('history').actions.find((a) => a.id === scheduled.id)?.status).toBe(
      'cancelled',
    );
  });

  it('fills Automations with what StayPut proposes, planned and did, in its own words', () => {
    const { pages } = createWorld(NOW);
    const queue = pages.actions('queue');
    expect(queue.mode).toBe('manual');
    expect(queue.actions.map((a) => `${a.type} ${a.member.name}`)).toEqual([
      'exit_survey Margaux Picard',
      'high_risk_message Yanis Benali',
      'high_risk_message Maxime Vidal',
      'payment_failed_notice Elena Novak',
      'welcome_message Ethan Brooks',
      'extend_offer Kevin Nguyen',
    ]);
    // The message as the member will read it: their first name, the community's name.
    expect(queue.actions[0]?.message?.body).toContain('Hi Margaux, we saw you are leaving Atlas');
    expect(queue.actions[1]?.message?.body).toContain('19 days');
    // The history, the newest first, with what a guardrail stopped.
    const history = pages.actions('history').actions;
    const times = history.map((a) => Date.parse(a.sentAt ?? a.createdAt));
    expect(times.slice(0, -1)).toEqual([...times.slice(0, -1)].sort((a, b) => b - a));
    expect(history.find((a) => a.status === 'blocked_by_guardrail')?.blockedReason).toBe(
      'message_spacing',
    );
    // A discount goes on the membership: nothing to type, the membership kept.
    expect(history.find((a) => a.type === 'promo_offer')?.offer).toMatchObject({
      promoApplied: true,
      keep: true,
    });
  });

  it('gives Alumni figures that add up (SPEC 6.13)', () => {
    const alumni = world.pages.alumni();
    const everyone = alumni.entered + alumni.left + alumni.returned;
    expect(alumni.returnRate).toBe(alumni.returned / everyone);
    // Those who came back took the monthly plan again: whole monthly payments, one each at least.
    const monthly = 49;
    expect(joined.some((m) => m.membership?.price === monthly)).toBe(true);
    expect(alumni.recovered!.amount % monthly).toBe(0);
    expect(alumni.recovered!.amount / monthly).toBeGreaterThanOrEqual(alumni.returned);
  });

  it('fills Analytics, Integrations › Activity and Settings › Risk score', () => {
    const { pages } = createWorld(NOW);
    // July's arrivals left faster: flagged; a month too recent shows no rate.
    const july = pages.insights.cohorts.find((c) => c.month === '2026-07-01');
    expect(july?.alertHorizon).toBe(30);
    expect(pages.insights.cohorts.at(-1)?.rates).toEqual({ 30: null, 60: null, 90: null });
    expect(pages.insights.lessons.filter((l) => l.flagged).map((l) => l.title)).toEqual([
      'Module 3 · Risk management',
      'Module 5 · Backtesting',
    ]);
    // Each platform's days add up to its messages.
    for (const platform of pages.platformActivity().platforms) {
      expect(platform.daily).toHaveLength(30);
      expect(platform.daily.reduce((t, n) => t + n, 0)).toBe(platform.messages);
    }
    expect(pages.people().people.length).toBe(pages.people().total);
    // Saved weights come back to 100 %.
    const saved = pages.saveRiskSettings({
      ...pages.riskSettings(),
      weights: { recency: 1, frequency: 1, progress: 1, payment: 1, friction: 0 },
    });
    expect(RISK_FACTORS.reduce((total, f) => total + saved.weights[f], 0)).toBeCloseTo(1);
  });

  it('counts Discord and Telegram from the members, as the server would', () => {
    const world = createWorld(NOW);
    const { pages } = world;
    const joined = world.members.members.filter((m) => m.status === 'joined');
    const activity = pages.platformActivity();
    const people = pages.people().people;
    for (const tile of activity.platforms) {
      const accounts = people.filter((p) => p.platform === tile.platform && p.messages > 0);
      const count = (status: string) => accounts.filter((a) => a.status === status).length;
      // Who wrote there: each account once, each a member, the team, a guest or one to tie.
      expect(tile.authors).toBe(accounts.length);
      expect(tile.members).toBe(count('member'));
      expect(tile.team + tile.guests + tile.unlinked).toBe(
        count('team') + count('guest') + count('unlinked'),
      );
      // Never more members than the community has, never one who wrote nothing.
      expect(tile.members).toBeLessThanOrEqual(joined.length);
      // The messages are theirs, day by day, and the server's or group's.
      expect(tile.messages).toBe(accounts.reduce((total, a) => total + a.messages, 0));
      expect(tile.daily.reduce((total, n) => total + n, 0)).toBe(tile.messages);
      expect(activity.places.find((p) => p.platform === tile.platform)?.messages).toBe(
        tile.messages,
      );
      // The last message is the latest of them.
      expect(tile.lastAt).toBe(
        accounts
          .map((a) => a.lastMessageAt!)
          .sort()
          .at(-1),
      );
    }
    // A member's messages there are part of their own (Members, 30 days).
    for (const member of joined) {
      const there = people
        .filter((p) => p.member?.id === member.id)
        .reduce((total, p) => total + p.messages, 0);
      expect(there).toBeLessThanOrEqual(member.activity.messages);
    }
    // Members who wrote nothing are there, silent; the most active add up from their accounts.
    expect(people.some((p) => p.status === 'member' && p.messages === 0)).toBe(true);
    for (const top of activity.topMembers) {
      const theirs = people.filter((p) => p.member?.id === top.id);
      expect(top.discord + top.telegram).toBe(theirs.reduce((t, p) => t + p.messages, 0));
    }
    // The accounts to tie are the tiles' ones; every member who wrote there is tied.
    const accounts = pages.accounts();
    expect(accounts.unlinked.filter((a) => a.messages > 0)).toHaveLength(
      activity.platforms.reduce((total, p) => total + p.unlinked, 0),
    );
    expect(accounts.linked).toHaveLength(
      activity.platforms.reduce((total, p) => total + p.members, 0),
    );
  });

  it('keeps Discord and Telegram live while the demo is open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const world = createWorld(NOW);
    const before = world.pages.platformActivity();
    const members = world.members.summary.activity30d;
    // Ten minutes later: what members wrote meanwhile is counted, today, where they wrote it.
    vi.setSystemTime(NOW + 10 * 60_000);
    const lines = world
      .feed()
      .items.filter((i) => Date.parse(i.at) > NOW && i.activity === 'message');
    const after = world.pages.platformActivity();
    vi.useRealTimers();
    expect(lines.length).toBeGreaterThan(0);
    for (const tile of after.platforms) {
      const written = lines.filter((i) => i.source === tile.platform).length;
      const was = before.platforms.find((p) => p.platform === tile.platform)!;
      expect(tile.messages).toBe(was.messages + written);
      expect(tile.daily.at(-1)).toBe(was.daily.at(-1)! + written);
      if (written > 0) expect(Date.parse(tile.lastAt!)).toBeGreaterThan(NOW);
    }
    // The same messages in the members' own counts.
    expect(world.members.summary.activity30d).toBeGreaterThan(members);
    const author = world.members.members.find((m) => m.id === lines[0]!.memberId)!;
    expect(Date.parse(author.lastActivityAt!)).toBe(Date.parse(lines[0]!.at));
  });

  it('ties a Discord or Telegram account to a member, and sets one aside', () => {
    const world = createWorld(NOW);
    const { pages } = world;
    const [first, second] = pages.accounts().unlinked;
    const memberId = first!.suggestions[0]!.memberId;
    const member = world.members.members.find((m) => m.id === memberId)!;
    const before = member.activity.messages;
    const linked = pages.changeAccount('link', { ...first!, memberId });
    expect(linked?.linked[0]).toMatchObject({ accountId: first!.accountId, via: 'creator' });
    expect(linked?.unlinked.some((a) => a.accountId === first!.accountId)).toBe(false);
    // Its messages waiting are the member's now, and a member's on the platform's tile.
    expect(member.activity.messages).toBe(before + first!.messages);
    pages.changeAccount('unlink', { platform: first!.platform, accountId: first!.accountId });
    expect(member.activity.messages).toBe(before);
    expect(pages.accounts().unlinked[0]?.accountId).toBe(first!.accountId);
    pages.changeAccount('dismiss', { ...second!, as: 'guest' });
    expect(pages.accounts().dismissed[0]).toMatchObject({
      accountId: second!.accountId,
      as: 'guest',
    });
    pages.changeAccount('restore', { platform: second!.platform, accountId: second!.accountId });
    expect(pages.accounts().unlinked[0]?.accountId).toBe(second!.accountId);
    expect(pages.changeAccount('link', { platform: 'discord', accountId: 'nobody' })).toBeNull();
  });

  it('feeds the live activity: the newest first, and a new line now and then', () => {
    const demo = createWorld(Date.now());
    const items = demo.feed().items;
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    const times = items.map((i) => Date.parse(i.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(items.every((i) => i.memberName !== null)).toBe(true);
  });
});

/**
 * Fix prompt v4.1, block 4: one source of truth. Every page tells the same story, rule by rule,
 * on the founder's day (3 October, 16:00 in Paris).
 */
describe('the demo tells one story (fix prompt v4.1, block 4)', () => {
  const AT = Date.parse('2026-10-03T14:00:00Z');
  const world = createWorld(AT, 'Europe/Paris');
  const members = world.members.members;
  const joined = members.filter((m) => m.status === 'joined');
  const named = (name: string) => members.find((m) => m.name === name)!;
  const en = createTranslator('en');
  const DAY = 86_400_000;
  const periodOf = (m: MemberRow) => m.membership!.billingPeriodDays! * DAY;
  const lastPaid = (m: MemberRow) =>
    Date.parse(world.memberDetail(m.id)!.payments.find((p) => p.status === 'succeeded')!.at);
  const history = world.pages.actions('history').actions;

  it('1. ends or renews each membership one period after the payment that paid it', () => {
    for (const m of members.filter((m) => m.membership)) {
      const end = Date.parse(m.membership!.currentPeriodEnd!);
      const until = pausedUntil(m);
      // A pause defers the renewal to the day it ends; otherwise one period after the last
      // payment that came in: a renewal that failed was due on that day, and is still unpaid.
      expect(end).toBe(until ?? lastPaid(m) + periodOf(m));
      if (m.lastPayment?.status === 'failed') expect(unpaidSince(m)).toBe(end);
    }
    // Hugo paid on 29 September for a month: he leaves on 29 October, as his reason says.
    const hugo = named('Hugo Bernard');
    expect(hugo.lastPayment!.at.slice(0, 10)).toBe('2026-09-29');
    expect(hugo.membership!.currentPeriodEnd!.slice(0, 10)).toBe('2026-10-29');
    expect(renewalText(hugo, AT, en)).toBe('Ends Oct 29');
    // Kevin's year, paid on 13 May, runs to 13 May 2027, its year said.
    const kevin = named('Kevin Nguyen');
    expect(kevin.lastPayment!.at.slice(0, 10)).toBe('2026-05-13');
    expect(kevin.membership!.currentPeriodEnd!.slice(0, 10)).toBe('2027-05-13');
    expect(renewalText(kevin, AT, en)).toBe('Ends May 13, 2027');
    // A departure's reason is its end.
    for (const m of joined.filter((m) => m.membership?.cancelAtPeriodEnd)) {
      expect(m.risk?.reasons.find((r) => r.code === 'cancel_scheduled')).toEqual({
        code: 'cancel_scheduled',
        date: m.membership!.currentPeriodEnd,
      });
    }
  });

  it('2. says « ended on » for every member gone, never « renews »', () => {
    const gone = members.filter((m) => m.status === 'left');
    expect(gone.map((m) => m.name)).toEqual([
      'Benoît Lacroix',
      'Sabrina Aït',
      'Lucie Moulin',
      'Paul Henry',
    ]);
    for (const m of gone) {
      const line = membershipLine(m.membership!, en, { now: AT, gone: true });
      expect(line).toMatch(/· ended on \w{3} \d{1,2}, 2026$/);
      expect(line).not.toMatch(/renews/);
      expect(renewalText(m, AT, en)).toBe('–');
      // Their drawer says the same membership.
      expect(world.memberDetail(m.id)!.memberships[0]?.status).toBe('canceled');
    }
  });

  it('3. shows a pause StayPut applied: « Paused · resumes Nov 2 » on Members and in the drawer', () => {
    const juliette = named('Juliette Caron');
    expect(memberState(juliette, AT)).toBe('paused');
    expect(stateText(juliette, 'paused', AT, en)).toBe('Paused · resumes Nov 2');
    expect(
      membershipLine(juliette.membership!, en, { now: AT, pausedUntil: pausedUntil(juliette) }),
    ).toBe('Paused · $149.00 per month · resumes on Nov 2, 2026');
    // The pause of the History is hers, and ends the same day.
    const pause = history.find((a) => a.member.id === juliette.id && a.type === 'pause_offer');
    expect(pause?.offer?.resumesAt).toBe(juliette.membership!.pausedUntil);
    expect(pause?.outcome).toEqual({ kind: 'paused', until: juliette.membership!.pausedUntil });
  });

  it('4. sends « Score turned high » only to a member whose score was high that day', () => {
    const all = (['queue', 'scheduled', 'history'] as const).flatMap(
      (view) => world.pages.actions(view).actions,
    );
    const turnedHigh = all.filter((a) => a.trigger === 'score_high');
    expect(turnedHigh.length).toBeGreaterThan(0);
    for (const action of turnedHigh) {
      const day = zonedDay(Date.parse(action.createdAt), 'Europe/Paris');
      const score = world.memberDetail(action.member.id)!.scores.find((s) => s.day === day);
      expect(score?.score, action.member.name ?? '').toBeGreaterThanOrEqual(DEFAULT_HIGH_FROM);
    }
    // Lou, at medium risk (62), got the creator's own message, not StayPut's.
    const lou = all.find((a) => a.member.name === 'Lou Marchand');
    expect(lou).toMatchObject({ type: 'creator_message', trigger: 'creator' });
  });

  it('5. follows each payment retry on its member: recovered and counted, or still failing', () => {
    const retries = history.filter((a) => a.type === 'payment_retry' && a.status === 'sent');
    expect(retries.map((a) => a.outcome?.kind)).toContain('recovered');
    expect(retries.map((a) => a.outcome?.kind)).toContain('still_failing');
    const chart = world.dashboard().revenueHistory;
    for (const retry of retries) {
      const member = members.find((m) => m.id === retry.member.id)!;
      const sent = Date.parse(retry.sentAt!);
      if (retry.outcome?.kind === 'recovered') {
        // The payment came in after it; the save is in the money saved, on its day.
        const save = world.saves.find(
          (s) =>
            s.memberId === member.id && Date.parse(s.at) >= sent && Date.parse(s.at) - sent < DAY,
        )!;
        expect(save.amount).toBe(retry.outcome.amount);
        const day = zonedDay(Date.parse(save.at), 'Europe/Paris');
        const onChart = chart.find((d) => d.day === day);
        if (onChart) expect(onChart.saved).toBeGreaterThanOrEqual(save.amount);
        if (sent > AT - periodOf(member)) {
          expect(member.lastPayment).toMatchObject({ status: 'succeeded', at: save.at });
        }
      } else {
        expect(retry.outcome?.kind).toBe('still_failing');
        expect(member.lastPayment?.status).toBe('failed');
      }
    }
    // Clara: retried 47 minutes ago, recovered; Elena: retried 2 hours ago, still failing.
    expect(history.find((a) => a.member.name === 'Clara Faure')?.outcome).toEqual({
      kind: 'recovered',
      amount: 49,
      currency: 'usd',
    });
    expect(
      history.find((a) => a.member.name === 'Elena Novak' && a.type === 'payment_retry')?.outcome,
    ).toEqual({ kind: 'still_failing' });
  });

  it('6. says what came of every action that reached a member: the proof of value', () => {
    for (const action of history.filter((a) => a.status === 'sent')) {
      expect(action.outcome, `${action.type} ${action.member.name}`).not.toBeNull();
    }
    const kinds = new Set(history.map((a) => a.outcome?.kind));
    for (const kind of ['recovered', 'came_back', 'paused', 'no_reply', 'still_failing', 'left']) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
    // Every save of the money saved is an action of the History that says it, at its amount.
    for (const save of world.saves) {
      const action = history.find(
        (a) =>
          a.member.id === save.memberId &&
          a.outcome?.kind === 'recovered' &&
          Date.parse(a.sentAt!) <= Date.parse(save.at) &&
          Date.parse(save.at) - Date.parse(a.sentAt!) <= 31 * DAY,
      );
      expect(action?.outcome).toMatchObject({ kind: 'recovered', amount: save.amount });
    }
    // The home's « StayPut's actions » are the History's last 30 days.
    const done = history.filter(
      (a) => a.status === 'sent' && AT - Date.parse(a.sentAt!) < 30 * DAY,
    );
    expect(world.dashboard().stayputActions30d).toMatchObject({
      total: done.length,
      paymentRetries: done.filter((a) => a.type === 'payment_retry').length,
      pauses: done.filter((a) => a.type === 'pause_offer').length,
    });
  });

  it('7. moves the counts of every list together when an action is approved', () => {
    const demo = createWorld(AT, 'Europe/Paris');
    const before = demo.pages.actions('queue');
    const [first] = before.actions;
    expect(demo.pages.approve([first!.id])).toBe(1);
    const after = demo.pages.actions('queue');
    expect(after.counts).toEqual({
      queue: before.counts.queue - 1,
      scheduled: before.counts.scheduled + 1,
      history: before.counts.history,
    });
    // « Approve all (5) » counts the same list as the tab.
    expect(after.actions.filter((a) => a.status === 'proposed')).toHaveLength(after.counts.queue);
  });

  it('8. never lists a member without a membership with a risk score: Paul Henry is gone', () => {
    for (const m of joined) expect(m.membership, m.name ?? '').not.toBeNull();
    for (const m of members.filter((m) => m.risk)) expect(m.membership).not.toBeNull();
    const paul = named('Paul Henry');
    expect(paul).toMatchObject({ status: 'left', risk: null });
    expect(keepMember('left', paul)).toBe(true);
    for (const filter of ['all', 'leaving', 'high', 'medium', 'low', 'newcomers'] as const) {
      if (filter !== 'all') expect(keepMember(filter, paul)).toBe(false);
    }
  });

  it('9. counts on Integrations › Activity the messages each member’s 30 days add up to', () => {
    // Each account once: one id, one person.
    const ids = world.pages.people().people.map((p) => `${p.platform}:${p.accountId}`);
    expect(new Set(ids).size).toBe(ids.length);
    const activity = world.pages.platformActivity();
    const drawers = joined.map((m) => world.memberDetail(m.id)!);
    for (const tile of activity.platforms) {
      const by = tile.messagesBy!;
      // The members' part is theirs, member by member; the rest the team's, guests', to tie.
      const theirs = drawers
        .flatMap((d) => d.platforms)
        .filter((p) => p.platform === tile.platform)
        .reduce((total, p) => total + p.events, 0);
      expect(by.members).toBe(theirs);
      expect(by.members + by.team + by.guests + by.unlinked).toBe(tile.messages);
    }
    // Each member's places add up to their 30 days, and all of them to the home's figure.
    for (const [i, m] of joined.entries()) {
      const places = drawers[i]!.platforms.reduce((total, p) => total + p.events, 0);
      const { messages, reactions, posts, lessons } = m.activity;
      expect(places, m.name ?? '').toBe(messages + reactions + posts + lessons);
    }
    expect(world.dashboard().memberActivity30d).toBe(world.members.summary.activity30d);
  });
});

describe('Analytics › Overview in the demo (fix prompt v4.1, block 7)', () => {
  const world = createWorld(NOW);
  const overview = world.overview();
  const DAY = 86_400_000;

  it('draws the Members page’s activity, day by day, up to today', () => {
    expect(overview.activity).toHaveLength(30);
    expect(overview.activity.at(-1)!.day).toBe(zonedDay(NOW, 'Europe/Paris'));
    expect(sum(overview.activity.map((d) => d.actions))).toBe(world.members.summary.activity30d);
    // A newcomer of this morning did a thing or two, not a month's worth.
    const pauline = world.members.members.find((m) => m.name === 'Pauline Giraud')!;
    const { messages, reactions, posts, lessons } = pauline.activity;
    expect(messages + reactions + posts + lessons).toBeGreaterThan(0);
    expect(messages + reactions + posts + lessons).toBeLessThan(5);
  });

  it('forecasts from the dashboard’s own revenue, at risk included', () => {
    const revenue = world.members.summary.revenue!;
    expect(overview.currency).toBe(revenue.currency);
    expect(sum(Object.values(overview.revenue))).toBeCloseTo(revenue.monthly, 1);
    expect(overview.revenue.high + overview.revenue.scheduled_departure).toBeCloseTo(
      revenue.atRisk,
      1,
    );
    // Eight weeks of history: StayPut's starting figures, said as such.
    expect(overview.calibrated).toEqual([]);
    expect(overview.saveRateObserved).toBe(false);
  });

  it('takes why members leave from the offers the queue and the History show', () => {
    const offers = (['queue', 'scheduled', 'history'] as const)
      .flatMap((view) => world.pages.actions(view).actions)
      .filter((a) => a.offer?.reason && NOW - Date.parse(a.createdAt) <= 90 * DAY);
    expect(overview.reasons).toEqual([
      { reason: 'no_time', count: 3 },
      { reason: 'other', count: 2 },
      { reason: 'too_expensive', count: 1 },
    ]);
    expect(sum(overview.reasons.map((r) => r.count))).toBe(
      new Set(offers.map((a) => a.member.id)).size,
    );
  });
});

describe('« Communities like yours » in the demo (SPEC Phase 6.10)', () => {
  const world = createWorld(NOW);

  it('compares its own arrivals of 6 months with an imaginary niche, and stops sharing', () => {
    const view = world.pages.benchmarks();
    expect(view).toMatchObject({ optedIn: true, niche: 'trading', minimum: 5 });
    // Its departures by horizon (Analytics › Cohorts): retention falls from 30 to 90 days.
    const mine = view.horizons.map((h) => h.mine!);
    expect(mine.every((rate) => rate > 0.5 && rate < 1)).toBe(true);
    expect(mine[0]).toBeGreaterThan(mine[1]!);
    expect(mine[1]).toBeGreaterThan(mine[2]!);
    expect(view.horizons.every((h) => h.niche !== null)).toBe(true);
    const off = world.pages.setBenchmarks(false);
    expect(off.optedIn).toBe(false);
    expect(off.horizons.map((h) => h.niche)).toEqual([null, null, null]);
    expect(off.horizons.map((h) => h.mine)).toEqual(mine);
  });
});

describe('the « Verified retention » badge in the demo (SPEC Phase 6.11)', () => {
  it('shows the demo’s own retention at 90 days, from its arrivals of 12 months', () => {
    const world = createWorld(NOW);
    const view = world.pages.badge('https://demo.example');
    expect(view).toMatchObject({ enabled: true, locale: 'en' });
    expect(view.retention).toBeGreaterThan(0.5);
    expect(view.retention).toBeLessThan(1);
    expect(view.members).toBeGreaterThanOrEqual(10);
    expect(view.badgeUrl).toBe('https://demo.example/badge/biz_AtlasTradingClub.svg');
    expect(world.pages.setBadge(false, 'https://demo.example').enabled).toBe(false);
  });

  it('is the same community as Settings › Developer and the export (one id)', () => {
    const world = createWorld(NOW);
    expect(world.exportData().company.id).toBe(DEMO_WHOP_ID);
    expect(world.pages.badge('https://demo.example').verifyUrl).toBe(
      `https://demo.example/verify/${DEMO_WHOP_ID}`,
    );
  });
});

describe('Analytics › Reports in the demo (SPEC Phase 6.9)', () => {
  const world = createWorld(NOW);
  const view = world.reports();
  const moment = (day: string) => zonedMoment(day, 0, 0, 'Europe/Paris');

  it('lists six Mondays, the week that ended last first, each sent that Monday at 8:00', () => {
    // Friday 2 October: the last report went on Monday 28 September, for the week of the 21st.
    expect(view.reports.map((r) => r.weekStart)).toEqual([
      '2026-09-21',
      '2026-09-14',
      '2026-09-07',
      '2026-08-31',
      '2026-08-24',
      '2026-08-17',
    ]);
    expect(view.reports[0]!.sentAt).toBe('2026-09-28T06:00:04.000Z');
    expect(view.nextAt).toBe('2026-10-05T06:00:00.000Z');
  });

  it('counts the demo’s own saves, departures and answers, week by week', () => {
    for (const report of view.reports) {
      const from = moment(report.weekStart);
      const to = moment(addDays(report.weekStart, 7));
      const within = (at: number) => at >= from && at < to;
      const saves = world.saves.filter((save) => within(Date.parse(save.at)));
      expect(report.saved.direct, report.weekStart).toBeCloseTo(
        sum(saves.map((save) => save.amount)),
        2,
      );
      expect(report.saved.members).toBe(new Set(saves.map((save) => save.memberId)).size);
      const answers = world.pages.exitAnswers().filter((a) => within(a.at));
      expect(sum(report.reasons.map((r) => r.count))).toBe(answers.length);
    }
    // The four members who left, each in the week they left.
    expect(sum(view.reports.map((r) => r.lost))).toBe(
      world.members.members.filter((m) => m.status === 'left').length,
    );
  });

  it('gives the last report the dashboard’s priority, and turns off', () => {
    expect(view.reports[0]!.priority).toEqual(world.dashboard().priority);
    expect(world.setReports(false).enabled).toBe(false);
    expect(world.reports().enabled).toBe(false);
  });
});

describe('Integrations › Discord, › Telegram and › Whop in the demo (fix prompt v4.1, block 7)', () => {
  const PLATFORMS = ['discord', 'telegram'] as const;

  it('adds up: the hero is its lists, the days its 30 days, the places and the hours its messages', () => {
    const world = createWorld(NOW);
    const joined = world.members.members.filter((m) => m.status === 'joined');
    const activity = world.pages.platformActivity();
    for (const platform of [...PLATFORMS, 'whop'] as const) {
      const view = world.pages.platforms.dashboard(platform);
      const { hero } = view;
      expect(view.platform).toBe(platform);
      expect(view.daily).toHaveLength(30);
      expect(view.to).toBe(zonedDay(NOW, 'Europe/Paris'));
      expect(sum(view.daily.map((d) => d.messages))).toBe(hero.messages30d);
      expect(sum(view.daily.map((d) => d.members))).toBe(hero.memberMessages30d);
      expect(sum(view.heatmap.map((c) => c.messages))).toBe(hero.messages30d);
      // Each message in one place: a channel, a group, its « General » or one of its topics.
      expect(sum(view.places.map((p) => p.messages))).toBe(hero.messages30d);
      // The live tile (the dashboard's « new message » mark) counts the same messages; Whop
      // has none (its synchronization brings its news).
      const tile = activity.platforms.find((p) => p.platform === platform);
      if (platform === 'whop') {
        expect(tile).toBeUndefined();
      } else {
        expect(tile!.messages).toBe(hero.messages30d);
        expect(tile!.daily).toEqual(view.daily.map((d) => d.messages));
      }
      // Active or gone silent: every member who wrote there over 90 days is one or the other.
      expect(view.silent.d7.total).toBe(hero.silentMembers7d);
      expect(view.active.d7).toHaveLength(Math.min(10, hero.activeMembers7d));
      expect(view.silent.d14.total).toBeLessThanOrEqual(view.silent.d7.total);
      expect(view.silent.d30.total).toBeLessThanOrEqual(view.silent.d14.total);
      // Each one listed is a member, with the ring the Members page shows.
      for (const listed of [...view.active.d30, ...view.silent.d7.members]) {
        const member = joined.find((m) => m.id === listed.id)!;
        expect(member.name).toBe(listed.name);
        expect(listed.score).toBe(member.risk?.score ?? null);
        expect(listed.level).toBe(member.risk?.level ?? null);
      }
      // The riskiest silent first; the most active first.
      const scores = view.silent.d7.members.map((m) => m.score ?? -1);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
      const counts = view.active.d30.map((m) => m.messages);
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
      // A day picked, an hour picked: the same messages.
      for (const day of view.daily.filter((d) => d.messages > 0).slice(-3)) {
        const picked = world.pages.platforms.day(platform, day.day);
        expect(picked.messages).toBe(day.messages);
        expect(sum(picked.places.map((p) => p.messages))).toBe(day.messages);
        expect(sum(picked.active.map((m) => m.messages))).toBe(day.members);
      }
      for (const cell of view.heatmap.slice(0, 5)) {
        const slot = world.pages.platforms.slot(platform, cell.dow, cell.hour);
        expect(slot.messages).toBe(cell.messages);
        expect(slot.members).toHaveLength(cell.members);
        expect(sum(slot.members.map((m) => m.messages)) + slot.others).toBe(cell.messages);
      }
    }
  });

  it('writes on Whop what its members wrote beyond Discord and Telegram, in its chats and forum', () => {
    const world = createWorld(NOW);
    const joined = world.members.members.filter((m) => m.status === 'joined');
    const view = world.pages.platforms.dashboard('whop');
    // The team writes there too (38 messages), never counted as the members'.
    expect(view.hero.messages30d - view.hero.memberMessages30d).toBe(38);
    // The members' part never exceeds what their own 30 days hold (messages and forum posts).
    expect(view.hero.memberMessages30d).toBeGreaterThan(0);
    expect(view.hero.memberMessages30d).toBeLessThanOrEqual(
      sum(joined.map((m) => m.activity.messages + m.activity.posts)),
    );
    // Its two chats and its forum by name; the announcements, followed, nobody writes in.
    expect(
      view.places
        .map((p) => [p.kind, p.name, p.messages > 0])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      ['chat', 'Announcements', false],
      ['chat', 'General', true],
      ['chat', 'Trade ideas', true],
      ['forum', 'Wins', true],
    ]);
    // Discord's and Telegram's figures are what they were: Whop's log is its own.
    expect(
      world.pages.platforms.dashboard('discord').places.every((p) => p.kind === 'channel'),
    ).toBe(true);
  });

  it('previews exactly what saving the signals does to the levels, and undoes it', () => {
    const world = createWorld(NOW);
    const joined = world.members.members.filter((m) => m.status === 'joined');
    const levels = () => {
      const counts = { scheduled_departure: 0, high: 0, medium: 0, low: 0 };
      for (const member of joined) if (member.risk) counts[member.risk.level] += 1;
      return counts;
    };
    const before = levels();
    const risks = joined.map((m) => m.risk);
    const { signals } = world.pages.platforms.dashboard('discord');
    const groups = signals.groups.map(([base, discord, telegram, rule, count]) => ({
      base,
      discord,
      telegram,
      rule,
      count,
    }));
    const thresholds = { mediumFrom: signals.mediumFrom, highFrom: signals.highFrom };
    // Today's settings: the preview's « Today » is the Members page.
    expect(scoreDistribution(groups, signals.settings, thresholds).levels).toEqual(before);

    const silent = { ...signals.settings.discord, silent: { on: true, points: 30 } };
    const preview = scoreDistribution(
      groups,
      { ...signals.settings, discord: silent },
      thresholds,
    ).levels;
    world.saveSignals('discord', silent);
    expect(levels()).toEqual(preview);
    expect(levels()).not.toEqual(before);
    expect(world.members.summary.risk).toMatchObject({
      high: preview.high,
      medium: preview.medium,
      low: preview.low,
      scheduledDeparture: preview.scheduled_departure,
    });
    expect(world.pages.platforms.dashboard('discord').signals.settings.discord).toEqual(silent);
    // Its reason, where it adds points and inactivity does not already say it.
    const quiet = joined.filter(
      (m) =>
        m.risk?.reasons.some((r) => r.code === 'platform_silent') &&
        !m.risk.reasons.some((r) => r.code === 'inactive'),
    );
    expect(quiet.length).toBeGreaterThan(0);

    world.saveSignals('discord', { ...silent, silent: { on: false, points: 30 } });
    expect(levels()).toEqual(before);
    expect(joined.map((m) => m.risk)).toEqual(risks);
  });
});
