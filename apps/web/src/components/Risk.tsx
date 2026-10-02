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
import { Badge } from '../ui/Badge';

/**
 * The risk score of a member (SPEC Phase 3) as the team sees it: a level that always has an icon
 * and a name besides its color, the score, and the two main reasons in plain words.
 */

interface LevelLook {
  label: MessageKey;
  Icon: LucideIcon;
}

/** Each level's name and icon. Risk is never said by a color: the ring and the words say it. */
export const LEVELS: Readonly<Record<RiskLevel, LevelLook>> = {
  scheduled_departure: { label: LEVEL_LABELS.scheduled_departure, Icon: LogOut },
  high: { label: LEVEL_LABELS.high, Icon: TriangleAlert },
  medium: { label: LEVEL_LABELS.medium, Icon: CircleAlert },
  low: { label: LEVEL_LABELS.low, Icon: ShieldCheck },
};

/** The small red dot of what is urgent (the brief: red as a dot or a small badge only). */
export function UrgentDot() {
  return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-danger/70" />;
}

/**
 * « High risk · 82 »; a departure is said without its score, 100 by rule. A silver outline:
 * `urgent` (a departure within 48 hours) adds the red dot.
 */
export function RiskBadge({ risk, urgent = false }: { risk: MemberRisk; urgent?: boolean }) {
  const { t, number } = useI18n();
  const { label, Icon } = LEVELS[risk.level];
  return (
    <Badge icon={urgent ? <UrgentDot /> : <Icon aria-hidden="true" className="size-3" />}>
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
