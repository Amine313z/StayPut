import type { MemberRisk, RiskLevel, RiskReason } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import {
  BookOpen,
  CalendarClock,
  CircleAlert,
  Clock,
  CreditCard,
  LifeBuoy,
  LogOut,
  ShieldCheck,
  Sprout,
  TrendingDown,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { LEVEL_LABELS, reasonText } from '../risk-text';
import { Badge, type Tone } from '../ui/Badge';

/**
 * The risk score of a member (SPEC Phase 3) as the team sees it: a level that always has an icon
 * and a name besides its color, the score, and the two main reasons in plain words.
 */

interface LevelLook {
  tone: Tone;
  label: MessageKey;
  Icon: LucideIcon;
  /** The icon and the bar of the level (static class names: Tailwind reads them here). */
  text: string;
  fill: string;
}

export const LEVELS: Readonly<Record<RiskLevel, LevelLook>> = {
  scheduled_departure: {
    tone: 'danger',
    label: LEVEL_LABELS.scheduled_departure,
    Icon: LogOut,
    text: 'text-danger',
    fill: 'bg-risk-departure',
  },
  high: {
    tone: 'serious',
    label: LEVEL_LABELS.high,
    Icon: TriangleAlert,
    text: 'text-serious',
    fill: 'bg-risk-high',
  },
  medium: {
    tone: 'warning',
    label: LEVEL_LABELS.medium,
    Icon: CircleAlert,
    text: 'text-warning',
    fill: 'bg-risk-medium',
  },
  low: {
    tone: 'accent',
    label: LEVEL_LABELS.low,
    Icon: ShieldCheck,
    text: 'text-accent',
    fill: 'bg-risk-low',
  },
};

/** The most urgent first. */
export const LEVEL_ORDER: readonly RiskLevel[] = ['scheduled_departure', 'high', 'medium', 'low'];

/** « High risk · 82 »; a departure is said without its score, 100 by rule. */
export function RiskBadge({ risk }: { risk: MemberRisk }) {
  const { t, number } = useI18n();
  const { tone, label, Icon } = LEVELS[risk.level];
  return (
    <Badge tone={tone} icon={<Icon aria-hidden="true" className="size-3" />}>
      {risk.level === 'scheduled_departure'
        ? t(label)
        : t('risk.badge', { level: t(label), score: number(risk.score) })}
    </Badge>
  );
}

const REASON_ICONS: Readonly<Record<RiskReason['code'], LucideIcon>> = {
  inactive: Clock,
  never_active: Sprout,
  activity_drop: TrendingDown,
  no_progress: BookOpen,
  payment_failed: CreditCard,
  payment_action_required: CreditCard,
  cancel_scheduled: CalendarClock,
  ticket_open: LifeBuoy,
  reactions_drop: TrendingDown,
};

/** The reasons of a score, one line each, the one weighing most first. */
export function RiskReasons({ reasons }: { reasons: readonly RiskReason[] }) {
  const i18n = useI18n();
  const lines = reasons.flatMap((reason) => {
    const text = reasonText(reason, i18n);
    return text ? [{ code: reason.code, text }] : [];
  });
  if (lines.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1 text-sm">
      {lines.map(({ code, text }) => {
        const Icon = REASON_ICONS[code];
        return (
          <li key={code} className="flex items-start gap-1.5">
            <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted" />
            <span className="min-w-0">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Where each level's row of the distribution leads in the members section. */
export const LEVEL_FILTERS: Readonly<Record<RiskLevel, string>> = {
  scheduled_departure: 'leaving',
  high: 'high',
  medium: 'medium',
  low: 'low',
};
