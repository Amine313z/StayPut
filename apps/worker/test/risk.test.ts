import type { MemberRow } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  riskReport,
  runSeed,
  seedMembers,
  type Profile,
} from '../../../scripts/seed/sandbox-members';
import { readInsights, readMembers, readRiskSettings } from '../src/members';
import { RISK_BATCH, analyzeCompany, scoreCompany, scoreDueCompanies } from '../src/risk';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Detection end to end (SPEC Phase 3) on the sandbox's 25 fake members: Postgres gathers, the
 * pure functions of packages/core decide, Postgres keeps; then the dashboard reads the members
 * sorted by score, with their reasons.
 */

// The real time: the dashboard reads under RLS, which checks access against the database clock.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const COMPANY = 'biz_RiskSeed';
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [
    COMPANY,
    NOW.toISOString(),
  ]);
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_owner', now())`,
    [COMPANY],
  );
  await runSeed(t.db, COMPANY, NOW);
});
afterAll(() => t.close());

const profileOf = new Map(seedMembers(NOW).map((m) => [m.memberId, m.profile]));
const scoresOf = (members: MemberRow[], profile: Profile) =>
  members.filter((m) => profileOf.get(m.id) === profile).map((m) => m.risk!.score);
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

describe('detection on the sandbox members', () => {
  it('scores every member, and sorts the dashboard by score', async () => {
    expect(await scoreCompany(t.db, COMPANY, NOW)).toBe(25);
    // Already scored this hour: nothing is due.
    expect(await scoreCompany(t.db, COMPANY, NOW)).toBe(0);

    const page = await readMembers(t.db, 'user_owner', COMPANY, NOW);
    const members = page.members;
    expect(members.every((m) => m.risk !== null)).toBe(true);
    const scores = members.map((m) => m.risk!.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(page.summary.risk).toMatchObject({ scheduledDeparture: 3, inactiveNewcomers: 1 });
    expect(page.summary.risk.high + page.summary.risk.medium + page.summary.risk.low + 3).toBe(25);
    expect(page.summary.risk.computedAt).toBe(NOW.toISOString());
  });

  it('ranks the profiles as the SPEC expects, with reasons in plain codes', async () => {
    const { members } = await readMembers(t.db, 'user_owner', COMPANY, NOW);
    const of = (profile: Profile) => members.filter((m) => profileOf.get(m.id) === profile);

    // A scheduled cancellation: score 100, its own status, said first.
    for (const m of of('scheduled_cancellation')) {
      expect(m.risk).toMatchObject({ score: 100, level: 'scheduled_departure' });
      expect(m.risk?.reasons[0]?.code).toBe('cancel_scheduled');
    }
    // Inactive for 3 weeks: high risk, inactivity first.
    for (const m of of('inactive')) {
      expect(m.risk?.level).toBe('high');
      expect(m.risk?.reasons[0]).toMatchObject({ code: 'inactive' });
    }
    // A failed payment always shows among the reasons.
    for (const m of of('failed_payment')) {
      expect(m.risk?.reasons.map((r) => r.code)).toContain('payment_failed');
    }
    // Active members stay low; the order of the profiles holds on average.
    for (const m of of('active')) expect(m.risk?.level).toBe('low');
    expect(mean(scoresOf(members, 'inactive'))).toBeGreaterThan(
      mean(scoresOf(members, 'declining')),
    );
    expect(mean(scoresOf(members, 'declining'))).toBeGreaterThan(mean(scoresOf(members, 'active')));
    // The activation radar: the newcomer who did nothing is on it, the one who started is not.
    for (const m of of('newcomer')) expect(m.risk?.inactiveNewcomer).toBe(false);
    for (const m of of('inactive_newcomer')) {
      expect(m.risk).toMatchObject({ inactiveNewcomer: true });
      // Opened the community once when joining (Whop's last action), nothing since.
      expect(m.risk?.reasons[0]).toMatchObject({ code: 'inactive', days: 4 });
    }
  });

  it('runs the weekly analyses and reads them back', async () => {
    await analyzeCompany(t.db, COMPANY, NOW);
    const insights = await readInsights(t.db, 'user_owner', COMPANY);
    expect(insights.computedAt).toBe(NOW.toISOString());
    // Fake members never leave: no departure, no alert.
    expect(insights.cohorts.length).toBeGreaterThan(0);
    expect(insights.cohorts.every((c) => c.alertHorizon === null)).toBe(true);
    expect(insights.averages[30]).toBe(0);
    expect(insights.lessons.length).toBeGreaterThan(0);
    // Not the company's team: nothing, not even when the analyses ran (RLS, analyses_at).
    expect(await readInsights(t.db, 'user_stranger', COMPANY)).toMatchObject({
      computedAt: null,
      cohorts: [],
      lessons: [],
    });
  });

  it('reads the settings of the company', async () => {
    expect(await readRiskSettings(t.db, 'user_owner', COMPANY)).toEqual({
      niche: 'other',
      weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
      recencyThresholdDays: 14,
      mediumFrom: 40,
      highFrom: 70,
    });
    // Not the company's team: nothing to read (RLS).
    expect(await readRiskSettings(t.db, 'user_stranger', COMPANY)).toBeNull();
  });

  it('writes the sandbox report: the members by score, the reasons in French', async () => {
    const lines = await riskReport(t.db, COMPANY, NOW);
    expect(lines[0]).toBe(`Fake members of ${COMPANY} by risk score (0 scores computed now):`);
    expect(lines[2]).toBe('| Score | Level | Member | Profile | Reasons |');
    const rows = lines.slice(4);
    expect(rows).toHaveLength(25);
    expect(rows[0]).toMatch(
      /^\| 100 \| Départ programmé \| .+ \| scheduled cancellation \| Part le /,
    );
    const scores = rows.map((row) => Number(row.split('|')[1]));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(rows.filter((row) => row.includes('| newcomer, inactive |'))[0]).toContain(
      'Nouveau, pas encore commencé',
    );
    expect(rows.join('\n')).toMatch(/Aucune activité depuis \d+ jours/);
  });

  it('scores again after new settings, within the run budget', async () => {
    await t.db.query(
      `select stayput.save_risk_settings($1, 'trading',
                                         '{"recency":0.35,"frequency":0.3,"progress":0.1,
                                           "payment":0.15,"friction":0.1}'::jsonb,
                                         7, 40, 70, $2::timestamptz)`,
      [COMPANY, NOW.toISOString()],
    );
    const runs = await scoreDueCompanies(t.db, NOW, 10);
    expect(runs.find((r) => r.companyId === COMPANY)?.scored).toBe(10);
    expect(RISK_BATCH).toBeGreaterThan(10);
    const later = await scoreDueCompanies(t.db, NOW);
    expect(later.find((r) => r.companyId === COMPANY)?.scored).toBe(15);
  });
});
