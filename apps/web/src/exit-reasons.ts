import type { ExitReason } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';

/** The departure survey's answers, as the member says them (the creator reads them quoted). */
export const REASON_LABELS: Readonly<Record<ExitReason, MessageKey>> = {
  too_expensive: 'member.reason.too_expensive',
  no_time: 'member.reason.no_time',
  no_results: 'member.reason.no_results',
  goal_reached: 'member.reason.goal_reached',
  other: 'member.reason.other',
};
