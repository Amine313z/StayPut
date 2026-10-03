import { describe, expect, it, vi } from 'vitest';
import { RISK_FACTORS, zonedDay, type RevenueDay } from '@stayput/core';
import { createWorld } from '../src/demo/world';
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

  it('looks real: full names, each once, never a test placeholder', () => {
    const names = world.members.members.map((m) => m.name ?? '');
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^\p{Lu}[\p{L}’-]+ \p{Lu}[\p{L}’-]+$/u);
      expect(name.toLowerCase()).not.toMatch(/test|demo|lorem|foo|user/);
    }
    expect(world.session.companyName).not.toMatch(/test|demo/i);
    // 25 to 40 members (brief v3 §11): 36 here, and three who left.
    expect(joined.length).toBe(36);
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
    expect(queue.counts).toEqual({ queue: 6, scheduled: 3, history: 11 });
    // What StayPut prepared first (Kevin's annual plan counts a twelfth a month).
    expect(demo.dashboard().priority).toEqual({
      kind: 'approve',
      actions: 6,
      members: 6,
      revenue: 384.17,
    });
    // Approved, they leave at their hour; the three failed payments come next (brief v3 §6.2).
    expect(demo.pages.approve()).toBe(6);
    expect(demo.pages.actions('scheduled').counts).toEqual({ queue: 0, scheduled: 9, history: 11 });
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
    const free = demo.members.members.find((m) => m.membership === null && m.status === 'joined')!;
    expect(demo.offer(free.id, 'promo_offer')).toEqual({ error: 'no_membership' });
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
    expect(history.find((a) => a.type === 'promo_offer')?.offer?.promoCode).toMatch(/^STAY-/);
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
