import { describe, expect, it } from 'vitest';
import type { WeeklyReport } from '../src/api';
import {
  nextReportAt,
  prioritySentence,
  reportMoney,
  reportedWeek,
  weeklyNotification,
} from '../src/weekly';

/** Intl's no-break spaces (« 98,00 $ », « 1 234 ») as plain ones, to compare. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

const REPORT: WeeklyReport = {
  weekStart: '2026-09-28',
  currency: 'USD',
  saved: { members: 2, direct: 98, influenced: 49 },
  lost: 1,
  reasons: [
    { reason: 'too_expensive', count: 3 },
    { reason: 'no_time', count: 1 },
  ],
  priority: { kind: 'retry', payments: 2, revenue: 98 },
};

describe('the Monday report’s week (SPEC Phase 6.9)', () => {
  it('covers Monday to Monday in the community’s calendar, the week that just ended', () => {
    // Monday 5 October 2026, 08:00 in Paris (06:00 UTC): the week of 28 September.
    expect(reportedWeek(Date.parse('2026-10-05T06:00:00Z'), 'Europe/Paris')).toEqual({
      start: '2026-09-28',
      end: '2026-10-05',
    });
    // Sunday 4 October, 23:30 in Paris: still the week before (the current one has not ended).
    expect(reportedWeek(Date.parse('2026-10-04T21:30:00Z'), 'Europe/Paris')).toEqual({
      start: '2026-09-21',
      end: '2026-09-28',
    });
    // Monday 00:30 in Tokyo is still Sunday in UTC: Tokyo's Monday counts.
    expect(reportedWeek(Date.parse('2026-10-04T15:30:00Z'), 'Asia/Tokyo')).toEqual({
      start: '2026-09-28',
      end: '2026-10-05',
    });
  });

  it('goes next on Monday at 8:00 there, across a change of time', () => {
    // Saturday 3 October in New York: Monday 5 October 08:00 EDT (12:00 UTC).
    expect(new Date(nextReportAt(Date.parse('2026-10-03T15:00:00Z'), 'America/New_York'))).toEqual(
      new Date('2026-10-05T12:00:00Z'),
    );
    // Monday 07:59 in Paris: this Monday; 08:00 sharp, the next one.
    expect(new Date(nextReportAt(Date.parse('2026-10-05T05:59:00Z'), 'Europe/Paris'))).toEqual(
      new Date('2026-10-05T06:00:00Z'),
    );
    expect(new Date(nextReportAt(Date.parse('2026-10-05T06:00:00Z'), 'Europe/Paris'))).toEqual(
      new Date('2026-10-12T06:00:00Z'),
    );
    // Paris goes back to UTC+1 on Sunday 25 October: Monday 26, 08:00 is 07:00 UTC.
    expect(new Date(nextReportAt(Date.parse('2026-10-24T12:00:00Z'), 'Europe/Paris'))).toEqual(
      new Date('2026-10-26T07:00:00Z'),
    );
  });
});

describe('the Monday report’s notification', () => {
  it('says the week in one paragraph, in English and in French', () => {
    expect(weeklyNotification(REPORT, 'en')).toEqual({
      title: 'Your Monday report',
      content:
        'Last week: 2 members saved, $98.00 saved (+ $49.00 influenced), 1 member lost. ' +
        'Top reason for leaving: too expensive (3). This week: retry 2 failed payments ($98.00 at risk).',
    });
    const fr = weeklyNotification(REPORT, 'fr');
    expect({ ...fr, content: plain(fr.content) }).toEqual({
      title: 'Votre rapport du lundi',
      content:
        'La semaine dernière : 2 membres sauvés, 98,00 $ sauvés (+ 49,00 $ influencés), 1 membre perdu. ' +
        'Première raison de départ : trop cher (3). Cette semaine : relancez 2 paiements échoués (98,00 $ menacés).',
    });
  });

  it('says a quiet week as such: nothing saved, nobody lost, no answer, nothing urgent', () => {
    const quiet: WeeklyReport = {
      ...REPORT,
      saved: { members: 0, direct: 0, influenced: 0 },
      lost: 0,
      reasons: [],
      priority: null,
    };
    expect(weeklyNotification(quiet, 'en').content).toBe(
      'Last week: 0 members saved, $0.00 saved, 0 members lost. This week: nothing urgent.',
    );
    expect(plain(weeklyNotification(quiet, 'fr').content)).toBe(
      'La semaine dernière : 0 membre sauvé, 0,00 $ sauvés, 0 membre perdu. Cette semaine : rien d’urgent.',
    );
  });

  it('never names a member: only figures reach the lock screen', () => {
    const named: WeeklyReport = {
      ...REPORT,
      priority: { kind: 'message', memberIds: ['mber_Lea', 'mber_Paul'], revenue: 148 },
    };
    const { content } = weeklyNotification(named, 'en');
    expect(content).not.toContain('mber_');
    expect(content).toContain('This week: message 2 members at high risk ($148.00 at risk).');
  });

  it('says each priority as the dashboard does', () => {
    const say = (priority: Parameters<typeof prioritySentence>[1], locale: 'en' | 'fr' = 'en') =>
      plain(prioritySentence(locale, priority, 'EUR'));
    expect(say({ kind: 'approve', actions: 1, members: 1, revenue: 49 })).toBe(
      'approve the action StayPut prepared (€49.00 at risk)',
    );
    expect(say({ kind: 'approve', actions: 3, members: 2, revenue: 98 }, 'fr')).toBe(
      'validez les 3 actions préparées par StayPut (98,00 € menacés)',
    );
    expect(say({ kind: 'pause', memberIds: ['mber_A'], revenue: 49 })).toBe(
      'offer a pause to 1 member leaving (€49.00 at risk)',
    );
    expect(say({ kind: 'pause', memberIds: ['mber_A', 'mber_B'], revenue: 98 }, 'fr')).toBe(
      'proposez une pause à 2 membres qui partent (98,00 € menacés)',
    );
    expect(say({ kind: 'review', filter: 'failed', members: 1, revenue: 49 })).toBe(
      '1 member still has a failed payment (€49.00 at risk)',
    );
    expect(say({ kind: 'review', filter: 'cancelling', members: 3, revenue: 147 }, 'fr')).toBe(
      '3 membres partent (147,00 € menacés)',
    );
    expect(say({ kind: 'retry', payments: 1, revenue: 49 }, 'fr')).toBe(
      'relancez 1 paiement échoué (49,00 € menacés)',
    );
  });

  it('writes amounts as the dashboard does, a count without a currency', () => {
    expect(reportMoney('en', 1234.5, 'USD')).toBe('$1,234.50');
    expect(plain(reportMoney('fr', 1234.5, 'EUR'))).toBe('1 234,50 €');
    expect(reportMoney('en', 12.4, null)).toBe('12');
    expect(reportMoney('en', 5, 'ZZZ')).toMatch(/5\.00/);
  });
});
