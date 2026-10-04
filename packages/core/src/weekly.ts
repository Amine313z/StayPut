import type { PriorityAction, WeeklyReport } from './api';
import { addDays, zonedClock, zonedMoment } from './calendar';
import type { ExitReason } from './offers';

/**
 * The Monday report (SPEC Phase 6.9): every Monday from 8:00 in the community's time zone, a Whop
 * notification to its team with the week before (members saved and lost, money saved, why
 * members left) and the week's priority. Pure: the Worker reads the figures and sends.
 */

/** The hour the report goes on Mondays, in the community's time zone. */
export const WEEKLY_REPORT_HOUR = 8;

/** Whop is asked this many times (one per hourly run) before the report stays unsent. */
export const WEEKLY_REPORT_ATTEMPTS = 3;

/**
 * The week a report made at `time` covers: from the Monday before the last one to the last
 * Monday, both at 00:00 in `timezone` (`end` excluded). On a Monday, the week that just ended.
 */
export function reportedWeek(time: number, timezone: string): { start: string; end: string } {
  const clock = zonedClock(time, timezone);
  const monday = addDays(clock.day, 1 - clock.dow);
  return { start: addDays(monday, -7), end: monday };
}

/** When the next report goes after `time`: this Monday 8:00 there if still to come, else next. */
export function nextReportAt(time: number, timezone: string): number {
  const clock = zonedClock(time, timezone);
  const monday = addDays(clock.day, 1 - clock.dow);
  const thisOne = zonedMoment(monday, WEEKLY_REPORT_HOUR, 0, timezone);
  return thisOne > time
    ? thisOne
    : zonedMoment(addDays(monday, 7), WEEKLY_REPORT_HOUR, 0, timezone);
}

export type ReportLocale = 'en' | 'fr';

const REASONS: Record<ReportLocale, Record<ExitReason, string>> = {
  en: {
    too_expensive: 'too expensive',
    no_time: 'no time',
    no_results: 'not the results expected',
    goal_reached: 'goal reached',
    other: 'another reason',
  },
  fr: {
    too_expensive: 'trop cher',
    no_time: 'pas le temps',
    no_results: 'pas les résultats attendus',
    goal_reached: 'objectif atteint',
    other: 'une autre raison',
  },
};

/** `count` and its noun: singular for 1 (and 0 in French, « 0 membre perdu »), else plural. */
function counted(locale: ReportLocale, count: number, one: string, other: string): string {
  const singular = count === 1 || (locale === 'fr' && count === 0);
  return `${new Intl.NumberFormat(locale).format(count)} ${singular ? one : other}`;
}

/** An amount as the dashboard writes it (packages/i18n): the narrow symbol, two decimals. */
export function reportMoney(locale: ReportLocale, value: number, currency: string | null): string {
  if (!currency) return new Intl.NumberFormat(locale).format(Math.round(value));
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(value)} ${currency}`;
  }
}

/** The week's priority in one clause, as the dashboard says it (« Retry 2 failed payments… »). */
export function prioritySentence(
  locale: ReportLocale,
  priority: PriorityAction | null,
  currency: string | null,
): string {
  const fr = locale === 'fr';
  if (!priority) return fr ? 'rien d’urgent' : 'nothing urgent';
  const amount = reportMoney(locale, priority.revenue, currency);
  const atRisk = fr ? `${amount} menacés` : `${amount} at risk`;
  switch (priority.kind) {
    case 'approve':
      return fr
        ? `validez ${priority.actions === 1 ? 'l’action préparée' : `les ${priority.actions} actions préparées`} par StayPut (${atRisk})`
        : `approve ${priority.actions === 1 ? 'the action' : `the ${priority.actions} actions`} StayPut prepared (${atRisk})`;
    case 'retry':
      return fr
        ? `relancez ${counted(locale, priority.payments, 'paiement échoué', 'paiements échoués')} (${atRisk})`
        : `retry ${counted(locale, priority.payments, 'failed payment', 'failed payments')} (${atRisk})`;
    case 'pause':
      return fr
        ? `proposez une pause à ${counted(locale, priority.memberIds.length, 'membre qui part', 'membres qui partent')} (${atRisk})`
        : `offer a pause to ${counted(locale, priority.memberIds.length, 'member leaving', 'members leaving')} (${atRisk})`;
    case 'message':
      return fr
        ? `écrivez à ${counted(locale, priority.memberIds.length, 'membre à risque élevé', 'membres à risque élevé')} (${atRisk})`
        : `message ${counted(locale, priority.memberIds.length, 'member at high risk', 'members at high risk')} (${atRisk})`;
    case 'review':
      return priority.filter === 'failed'
        ? fr
          ? `${counted(locale, priority.members, 'membre a', 'membres ont')} encore un paiement échoué (${atRisk})`
          : `${counted(locale, priority.members, 'member still has', 'members still have')} a failed payment (${atRisk})`
        : fr
          ? `${counted(locale, priority.members, 'membre part', 'membres partent')} (${atRisk})`
          : `${counted(locale, priority.members, 'member is', 'members are')} leaving (${atRisk})`;
  }
}

/**
 * The notification the team gets: a title, then the week in one paragraph. The figures only,
 * never a member's name (the notification shows on a phone's lock screen).
 */
export function weeklyNotification(
  report: WeeklyReport,
  locale: ReportLocale,
): { title: string; content: string } {
  const fr = locale === 'fr';
  const money = (value: number) => reportMoney(locale, value, report.currency);
  const saved = report.saved;
  const week = fr
    ? `La semaine dernière : ${counted(locale, saved.members, 'membre sauvé', 'membres sauvés')}, ${money(saved.direct)} sauvés${
        saved.influenced > 0 ? ` (+ ${money(saved.influenced)} influencés)` : ''
      }, ${counted(locale, report.lost, 'membre perdu', 'membres perdus')}.`
    : `Last week: ${counted(locale, saved.members, 'member saved', 'members saved')}, ${money(saved.direct)} saved${
        saved.influenced > 0 ? ` (+ ${money(saved.influenced)} influenced)` : ''
      }, ${counted(locale, report.lost, 'member lost', 'members lost')}.`;
  const top = report.reasons[0];
  const reason = top
    ? fr
      ? ` Première raison de départ : ${REASONS.fr[top.reason]} (${top.count}).`
      : ` Top reason for leaving: ${REASONS.en[top.reason]} (${top.count}).`
    : '';
  const priority = prioritySentence(locale, report.priority, report.currency);
  const next = fr ? ` Cette semaine : ${priority}.` : ` This week: ${priority}.`;
  return {
    title: fr ? 'Votre rapport du lundi' : 'Your Monday report',
    content: week + reason + next,
  };
}
