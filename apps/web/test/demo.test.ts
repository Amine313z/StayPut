import { describe, expect, it } from 'vitest';
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

  it('asks to message the members at high risk, the best paying first', () => {
    const home = world.dashboard();
    expect(home.priority?.kind).toBe('message');
    const ids = home.priority?.kind === 'message' ? home.priority.memberIds : [];
    expect(ids).toHaveLength(6);
    for (const id of ids) {
      expect(joined.find((m) => m.id === id)?.risk?.level).toBe('high');
    }
    expect(joined.find((m) => m.id === ids[0])?.name).toBe('Sarah Cohen');
  });

  it('remembers what the creator did until the page is reloaded', () => {
    const demo = createWorld(NOW);
    const home = demo.dashboard();
    const ids = home.priority?.kind === 'message' ? home.priority.memberIds : [];
    expect(demo.message(ids)).toBe(6);
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
