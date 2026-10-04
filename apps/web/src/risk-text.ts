import type { RiskLevel, RiskReason } from '@stayput/core';
import type { MessageKey, Translator } from '@stayput/i18n';

/**
 * The words of the risk score, without React: the screens (components/Risk.tsx) and the sandbox
 * report (scripts/seed-sandbox.ts) say a level and a reason the same way.
 */

/** The name of each level; the screens add its icon and color. */
export const LEVEL_LABELS: Readonly<Record<RiskLevel, MessageKey>> = {
  scheduled_departure: 'risk.level.scheduled_departure',
  high: 'risk.level.high',
  medium: 'risk.level.medium',
  low: 'risk.level.low',
};

/** Discord's and Telegram's names, in the reasons that come from them. */
const PLATFORM_NAMES: Readonly<Record<'discord' | 'telegram', MessageKey>> = {
  discord: 'sources.discord.name',
  telegram: 'sources.telegram.name',
};

/** A reason in the creator's language: « No activity for 12 days ». Null for a code unknown here. */
export function reasonText(reason: RiskReason, i18n: Translator): string | null {
  const { t, plural, percent, date } = i18n;
  switch (reason.code) {
    case 'inactive':
      return plural('risk.reason.inactive', reason.days);
    case 'never_active':
      return plural('risk.reason.never_active', reason.days);
    case 'activity_drop':
      // « Down 100 % » reads as a riddle: nothing at all this week.
      return reason.percent >= 100
        ? t('risk.reason.no_activity_week')
        : t('risk.reason.activity_drop', { percent: percent(reason.percent / 100) });
    case 'no_progress':
      return reason.lesson
        ? plural('risk.reason.stalled', reason.days, { lesson: reason.lesson })
        : plural('risk.reason.no_progress', reason.days);
    case 'payment_failed':
      return t('risk.reason.payment_failed');
    case 'payment_action_required':
      return t('risk.reason.payment_action_required');
    case 'cancel_scheduled':
      return reason.date
        ? t('risk.reason.cancel_scheduled', { date: date(new Date(reason.date)) })
        : t('risk.reason.cancel_scheduled_undated');
    case 'ticket_open':
      return plural('risk.reason.ticket_open', reason.days);
    case 'reactions_drop':
      return reason.percent >= 100
        ? t('risk.reason.no_reactions')
        : t('risk.reason.reactions_drop', { percent: percent(reason.percent / 100) });
    case 'platform_silent':
      return plural('risk.reason.platform_silent', reason.days, {
        platform: t(PLATFORM_NAMES[reason.platform]),
      });
    case 'platform_drop':
      return t('risk.reason.platform_drop', {
        percent: percent(reason.percent / 100),
        platform: t(PLATFORM_NAMES[reason.platform]),
      });
    case 'platform_left':
      return t(
        reason.platform === 'discord'
          ? 'risk.reason.platform_left.discord'
          : 'risk.reason.platform_left.telegram',
      );
    default:
      // A newer Worker may know more reasons than this page: say nothing rather than a code.
      return null;
  }
}
