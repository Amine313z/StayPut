import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  LIMITS,
  TIERS,
  allows,
  higherTier,
  isFeature,
  isTier,
  requiredTier,
  serverAllowed,
  tierAtLeast,
  type Feature,
} from '../src/plans';

/**
 * The plans' one table (decision of 2026-10-10): each level opens what the levels below open, and
 * the offer's lines sit at the level the founder set.
 */

describe('the plans', () => {
  it('orders the levels, each opening what the ones below open', () => {
    expect(TIERS).toEqual(['free', 'pro', 'scale']);
    expect(tierAtLeast('scale', 'pro')).toBe(true);
    expect(tierAtLeast('pro', 'scale')).toBe(false);
    expect(higherTier('free', 'pro')).toBe('pro');
    for (const feature of Object.keys(FEATURES) as Feature[]) {
      const min = requiredTier(feature);
      for (const tier of TIERS) expect(allows(tier, feature)).toBe(tierAtLeast(tier, min));
    }
  });

  it('puts each line of the offer at its level', () => {
    const at = (tier: string) =>
      (Object.keys(FEATURES) as Feature[]).filter((f) => FEATURES[f] === tier).sort();
    expect(at('free')).toEqual(
      [
        'badge',
        'benchmarks',
        'dashboard',
        'export',
        'forecast_preview',
        'manual_actions',
        'needs_attention',
        'one_platform',
        'risk_score',
        'team',
        'whop_activity',
      ].sort(),
    );
    expect(at('pro')).toEqual(
      [
        'automations',
        'both_platforms',
        'cohorts',
        'exit_survey',
        'forecast',
        'pause_offers',
        'payment_recovery',
        'platform_dms',
        'prepared_actions',
        'unlimited_actions',
        'weekly_report',
      ].sort(),
    );
    expect(at('scale')).toEqual(
      [
        'autopilot',
        'forecast_scenarios',
        'lessons',
        'priority_support',
        'several_servers',
        'several_whops',
        'winback',
      ].sort(),
    );
  });

  it('limits Free to 5 manual actions a month and 7 days of history', () => {
    expect(LIMITS.free).toEqual({ manualActionsPerMonth: 5, historyDays: 7, servers: 1 });
    expect(LIMITS.pro.manualActionsPerMonth).toBeNull();
    expect(LIMITS.pro.historyDays).toBe(90);
    expect(LIMITS.pro.servers).toBe(2);
    expect(LIMITS.scale.servers).toBeNull();
  });

  it('lets Free connect one server, Pro one of each platform, Scale as many as it likes', () => {
    const none = { discord: 0, telegram: 0 };
    expect(serverAllowed('free', none, 'discord')).toBeNull();
    expect(serverAllowed('free', { discord: 1, telegram: 0 }, 'telegram')).toBe('pro');
    expect(serverAllowed('free', { discord: 1, telegram: 0 }, 'discord')).toBe('scale');
    expect(serverAllowed('pro', { discord: 1, telegram: 0 }, 'telegram')).toBeNull();
    expect(serverAllowed('pro', { discord: 1, telegram: 1 }, 'discord')).toBe('scale');
    expect(serverAllowed('scale', { discord: 4, telegram: 3 }, 'telegram')).toBeNull();
  });

  it('knows its own words, and nothing else', () => {
    expect(isTier('pro')).toBe(true);
    expect(isTier('performance')).toBe(false);
    expect(isFeature('autopilot')).toBe(true);
    expect(isFeature('toString')).toBe(false);
  });
});
