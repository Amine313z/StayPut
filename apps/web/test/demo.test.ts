import { describe, expect, it } from 'vitest';
import { RISK_FACTORS } from '@stayput/core';
import { createWorld } from '../src/demo/world';

const NOW = Date.parse('2026-10-02T10:00:00.000Z');

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
    expect(joined.length).toBe(56);
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
    expect(summary.failedPayments).toBe(2);
    // Today's line of the history is today's count.
    const today = home.riskHistory.at(-1)!;
    expect(home.riskHistory).toHaveLength(30);
    expect(today.departure + today.high).toBe(home.atRisk.members);
    expect(home.retention30.rate).toBeGreaterThan(0.85);
    expect(home.retention30.rate).toBeLessThan(1);
  });

  it('tells one story, from the hero row to the chart', () => {
    const home = world.dashboard();
    expect(home.revenueHistory).toHaveLength(90);
    // Today's risk is the hero row's; three months ago it was higher (StayPut at work).
    expect(home.revenueHistory.at(-1)!.atRisk).toBe(home.atRisk.revenue);
    expect(home.revenueHistory[0]!.atRisk).toBeGreaterThan(home.atRisk.revenue);
    expect(home.revenueHistory.every((d) => d.atRisk !== null && d.atRisk > 0)).toBe(true);
    // The month's money saved is its days' in the chart.
    const month = home.revenueHistory.filter((d) => d.day.startsWith('2026-10'));
    expect(home.saved.thisMonth.direct).toBe(month.reduce((total, d) => total + d.saved, 0));
    // Credible: a payment saved every few days, a fraction of what the community earns.
    const last30 = home.revenueHistory.slice(-30).reduce((total, d) => total + d.saved, 0);
    expect(last30).toBeGreaterThan(0);
    expect(last30 / home.monthlyRevenue!).toBeLessThan(0.25);
    expect(home.stayputActions30d.saved).toBeGreaterThan(0);
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

  it('asks to approve what waits first, as Automations shows it, then to message', () => {
    const demo = createWorld(NOW);
    const queue = demo.pages.actions('queue');
    expect(queue.counts).toEqual({ queue: 6, scheduled: 3, history: 11 });
    expect(demo.dashboard().priority).toEqual({
      kind: 'approve',
      actions: 6,
      members: 6,
      revenue: 294,
    });
    // Approved, they leave at their hour; the member at high risk nobody reached comes next.
    expect(demo.pages.approve()).toBe(6);
    expect(demo.pages.actions('scheduled').counts).toEqual({ queue: 0, scheduled: 9, history: 11 });
    const next = demo.dashboard().priority;
    expect(next?.kind).toBe('message');
    const ids = next?.kind === 'message' ? next.memberIds : [];
    expect(ids.map((id) => joined.find((m) => m.id === id)?.name)).toEqual(['Théo Fontaine']);
  });

  it('remembers what the creator did until the page is reloaded', () => {
    const demo = createWorld(NOW);
    demo.pages.approve();
    const home = demo.dashboard();
    const ids = home.priority?.kind === 'message' ? home.priority.memberIds : [];
    expect(demo.message(ids)).toBe(1);
    expect(demo.dashboard().priority).toBeNull();
    const target = ids[0]!;
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

  it('ties a Discord or Telegram account to a member, and sets one aside', () => {
    const { pages } = createWorld(NOW);
    const [first, second] = pages.accounts().unlinked;
    const memberId = first!.suggestions[0]!.memberId;
    const linked = pages.changeAccount('link', { ...first!, memberId });
    expect(linked?.linked[0]).toMatchObject({ accountId: first!.accountId, via: 'creator' });
    expect(linked?.unlinked.some((a) => a.accountId === first!.accountId)).toBe(false);
    pages.changeAccount('unlink', { platform: first!.platform, accountId: first!.accountId });
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
