import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { Avatar } from '../ui/Avatar';
import { RiskRing } from '../ui/RiskRing';
import { UrgentDot } from '../ui/UrgentDot';

/**
 * A member in a list of the dashboard (brief v3 §10, its « MemberRow », named so beside the
 * MemberRow data it shows): avatar, name and reason; the risk ring; when they leave or renew and
 * what they pay; the actions. Two lines at most, one when the list has room. The whole row opens
 * the member (`href`). At rest a « › » says so; hovered or focused, the actions take its place
 * (fix prompt v4.1, block 3; on a touch screen, which hovers nothing, they always show). Hovered,
 * the row lifts 2 px and a surface brightens behind it: transform and opacity only (MOTION.md).
 */
export function MemberListRow({
  name,
  href,
  reason,
  reasonUrgent = false,
  risk,
  when,
  whenUrgent = false,
  paid,
  actions,
  delay = 0,
  rowTour,
  ringTour,
}: {
  name: string;
  /** Where the row leads: the member's drawer. */
  href?: string;
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
  /** Where the guide may light up the row, and its ring (`data-tour`, guide.ts). */
  rowTour?: string;
  ringTour?: string;
}) {
  const single = when === null && paid === null;
  return (
    <div
      data-tour={rowTour}
      className="group relative -mx-3 rounded-xl px-3 py-3 transition-transform duration-150 ease-brand hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-xl bg-surface-3/50 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
      />
      <div className="relative flex flex-col gap-2 @2xl/list:flex-row @2xl/list:items-center @2xl/list:gap-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar name={name} />
          <div className="min-w-0 flex-1">
            {href ? (
              // The name's link covers the whole row (its ::after), under the actions.
              <Link
                to={href}
                className="block truncate rounded-sm text-sm font-medium text-fg outline-none after:absolute after:-inset-3 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
              >
                {name}
              </Link>
            ) : (
              <p className="truncate text-sm font-medium text-fg">{name}</p>
            )}
            {reason ? (
              <p className="flex items-center gap-1.5 text-[0.8125rem] text-subtle">
                {reasonUrgent ? <Urgent /> : null}
                {/* Alone on its row beside the actions, it may take two lines on a phone. */}
                <span className={single ? 'line-clamp-2' : 'truncate'}>{reason}</span>
              </p>
            ) : null}
          </div>
          {risk ? (
            <RiskRing
              score={risk.score}
              label={risk.label}
              size={36}
              delay={delay}
              tour={ringTour}
            />
          ) : null}
          {/* Nothing to say on a second line: the actions stay on the first. */}
          {single ? href ? <RowActions>{actions}</RowActions> : actions : null}
        </div>
        <div
          hidden={single}
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ps-12 @2xl/list:flex-nowrap @2xl/list:ps-0"
        >
          <div className="text-[0.8125rem] @2xl/list:w-40">
            {when ? (
              <p className="tabular flex items-center gap-1.5 text-muted">
                {whenUrgent ? <Urgent /> : null}
                {when}
              </p>
            ) : null}
            {/* A list's amount: Satoshi 500, 14 px, white (brief v4 §7). */}
            {paid ? <p className="metric text-sm text-fg">{paid}</p> : null}
          </div>
          {single ? null : href ? <RowActions>{actions}</RowActions> : actions}
        </div>
      </div>
    </div>
  );
}

/**
 * A row's actions over its « › » (fix prompt v4.1, block 3): the chevron at rest, the actions in
 * its place while the row is hovered or holds the focus (120 ms fades). Their room is kept, so
 * nothing moves. Hidden, they let a click through to the row; on a touch screen they always show.
 */
function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none relative z-10 flex h-8 w-[6.75rem] shrink-0 items-center justify-end pointer-coarse:pointer-events-auto">
      <ChevronRight
        aria-hidden="true"
        data-row-chevron=""
        className="size-4 text-subtle transition-opacity duration-[120ms] ease-brand group-focus-within:opacity-0 group-hover:opacity-0 pointer-coarse:hidden"
      />
      <div
        data-row-actions=""
        className="absolute inset-y-0 end-0 flex items-center opacity-0 transition-opacity duration-[120ms] ease-brand group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 pointer-coarse:opacity-100"
      >
        {children}
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
