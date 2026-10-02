import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Avatar } from '../ui/Avatar';
import { RiskRing } from '../ui/RiskRing';
import { UrgentDot } from '../ui/UrgentDot';

/**
 * A member in a list of the dashboard (brief v3 §10, its « MemberRow », named so beside the
 * MemberRow data it shows): avatar, name and reason; the risk ring; when they leave or renew and
 * what they pay; the ghost actions. Two lines at most, one when the list has room. Hovered, the
 * row lifts 2 px and a surface brightens behind it: transform and opacity only (MOTION.md).
 */
export function MemberListRow({
  name,
  reason,
  reasonUrgent = false,
  risk,
  when,
  whenUrgent = false,
  paid,
  actions,
  delay = 0,
}: {
  name: string;
  /** Why they need attention, in a few words. */
  reason: string | null;
  /** The reason is urgent (a payment failed): the red dot. */
  reasonUrgent?: boolean;
  risk: { score: number; label: string } | null;
  /** « Leaves Oct 4 », « Renews Nov 2 ». */
  when: string | null;
  /** They leave within 48 hours: the red dot. */
  whenUrgent?: boolean;
  /** « $49 / month ». */
  paid: string | null;
  actions: ReactNode;
  /** Seconds before the ring draws: the rows one after the other. */
  delay?: number;
}) {
  return (
    <div className="group relative -mx-3 rounded-xl px-3 py-3 transition-transform duration-150 ease-brand hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-xl bg-surface-3/50 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
      />
      <div className="relative flex flex-col gap-2 @2xl/list:flex-row @2xl/list:items-center @2xl/list:gap-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar name={name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-fg">{name}</p>
            {reason ? (
              <p className="flex items-center gap-1.5 text-[0.8125rem] text-subtle">
                {reasonUrgent ? <Urgent /> : null}
                <span className="truncate">{reason}</span>
              </p>
            ) : null}
          </div>
          {risk ? <RiskRing score={risk.score} label={risk.label} size={36} delay={delay} /> : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ps-12 @2xl/list:flex-nowrap @2xl/list:ps-0">
          <div className="tabular text-[0.8125rem] @2xl/list:w-40">
            {when ? (
              <p className="flex items-center gap-1.5 text-muted">
                {whenUrgent ? <Urgent /> : null}
                {when}
              </p>
            ) : null}
            {paid ? <p className="text-subtle">{paid}</p> : null}
          </div>
          {actions}
        </div>
      </div>
    </div>
  );
}

/** The red dot of what is urgent, said to screen readers too. */
function Urgent() {
  const { t } = useI18n();
  return (
    <>
      <UrgentDot />
      <span className="sr-only">{t('dash.row.urgent')}</span>
    </>
  );
}
