import type { MemberRow } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { ArrowDown, ArrowUp, BellOff, ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useI18n } from '../i18n';
import {
  isLeaving,
  isUrgent,
  lastActive,
  memberState,
  monthlyOf,
  periodEnd,
  type MemberSort,
  type MemberState,
  type SortDirection,
} from '../members';
import { ease } from '../motion';
import { Avatar } from '../ui/Avatar';
import { RiskRing } from '../ui/RiskRing';
import { UrgentDot } from '../ui/UrgentDot';
import { LEVELS } from './Risk';

export const STATE_LABELS: Readonly<Record<MemberState, MessageKey>> = {
  leaving: 'members.state.leaving',
  paymentFailed: 'members.state.paymentFailed',
  inactive: 'members.state.inactive',
  active: 'members.state.active',
  team: 'members.team',
  gone: 'members.state.gone',
};

/**
 * The sortable columns. `whole`: a name that may spill into the gaps beside its narrow column
 * (« Risque » over the rings) rather than lose its end.
 */
const COLUMNS: readonly {
  sort: MemberSort;
  label: MessageKey;
  className: string;
  whole?: boolean;
}[] = [
  { sort: 'member', label: 'members.col.member', className: '' },
  { sort: 'risk', label: 'members.col.risk', className: 'justify-center', whole: true },
  { sort: 'status', label: 'members.col.status', className: 'hidden @xl/table:flex' },
  { sort: 'mrr', label: 'members.col.mrr', className: 'hidden @xl/table:flex justify-end' },
  { sort: 'lastActivity', label: 'members.col.lastActivity', className: 'hidden @3xl/table:flex' },
  { sort: 'renewal', label: 'members.col.renewal', className: 'hidden @3xl/table:flex' },
];

/**
 * One grid for the header and every row: the member and their ring, the bell when on the « do
 * not contact » list; then, as room allows, the status and what they pay and the chevron (@xl),
 * their last activity and next renewal (@3xl). On a phone the status and the amount sit under
 * the name, which keeps the room the chevron would take.
 */
const GRID =
  'grid items-center gap-x-3 grid-cols-[minmax(0,1fr)_3rem_1rem] ' +
  '@xl/table:gap-x-4 @xl/table:grid-cols-[minmax(0,1.6fr)_3rem_minmax(0,1fr)_minmax(0,0.8fr)_1rem_0.75rem] ' +
  '@3xl/table:grid-cols-[minmax(0,1.6fr)_3rem_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_1rem_0.75rem]';

/** Rows that come in one after the other: the first ten, 30 ms apart (brief v4 §14). */
const ANIMATED_ROWS = 10;

/**
 * The members as a compact table (brief v4 §9.3): one line each (two on a phone), every column
 * sorts, a row opens the member's drawer. Hovered, a row lifts 2 px on black-700. The status is
 * white words, the red dot only for what is urgent (a payment failed, leaving within 48 hours).
 * A member who shows up later comes in with a turquoise edge (600 ms); one who goes folds away
 * (250 ms) and the rows below close up.
 */
export function MemberTable({
  members,
  label,
  sort,
  direction,
  onSort,
  onOpen,
  now,
  isNew = () => false,
}: {
  members: readonly MemberRow[];
  /** The table's name for screen readers. */
  label: string;
  sort: MemberSort;
  direction: SortDirection;
  onSort: (sort: MemberSort) => void;
  onOpen: (member: MemberRow) => void;
  now: number;
  /** A member who was not there when the page opened. */
  isNew?: (id: string) => boolean;
}) {
  const { t } = useI18n();
  return (
    <div role="table" aria-label={label} className="@container/table">
      <div role="rowgroup">
        <div role="row" className={`${GRID} border-b border-line px-3 pb-2`}>
          {COLUMNS.map((column) => {
            const active = column.sort === sort;
            const Arrow = direction === 'asc' ? ArrowUp : ArrowDown;
            return (
              <div
                key={column.sort}
                role="columnheader"
                aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={`flex min-w-0 ${column.className}`}
              >
                <button
                  type="button"
                  onClick={() => onSort(column.sort)}
                  className={`label-text inline-flex items-center gap-1 rounded transition-colors duration-200 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    column.whole ? 'shrink-0' : 'min-w-0'
                  } ${active ? 'text-fg' : ''}`}
                >
                  <span className={column.whole ? 'whitespace-nowrap' : 'truncate'}>
                    {t(column.label)}
                  </span>
                  {active ? <Arrow aria-hidden="true" className="size-3 shrink-0" /> : null}
                </button>
              </div>
            );
          })}
          <div role="columnheader">
            <span className="sr-only">{t('members.contact.never')}</span>
          </div>
          <div role="columnheader" aria-hidden="true" className="hidden @xl/table:block" />
        </div>
      </div>
      <div role="rowgroup">
        <AnimatePresence>
          {members.map((member, index) => (
            <Row
              key={member.id}
              member={member}
              index={index}
              now={now}
              fresh={isNew(member.id)}
              onOpen={onOpen}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Row({
  member,
  index,
  now,
  fresh,
  onOpen,
}: {
  member: MemberRow;
  index: number;
  now: number;
  fresh: boolean;
  onOpen: (member: MemberRow) => void;
}) {
  const { t, number, currency, relative, day } = useI18n();
  const name = member.name ?? t('members.unnamed');
  const state = memberState(member, now);
  const urgent = isUrgent(member, now);
  const monthly = monthlyOf(member.membership);
  const paid =
    monthly !== null && member.membership?.currency
      ? t('dash.row.perMonth', {
          amount: currency(monthly, member.membership.currency.toUpperCase()),
        })
      : null;
  const last = lastActive(member);
  const end = member.status === 'left' ? null : periodEnd(member);
  const risk = member.risk;
  const animated = index < ANIMATED_ROWS;
  const status = (
    <span className="flex min-w-0 items-center gap-1.5">
      {urgent ? (
        <>
          <UrgentDot />
          <span className="sr-only">{t('dash.row.urgent')}</span>
        </>
      ) : null}
      <span className="truncate">{t(STATE_LABELS[state])}</span>
    </span>
  );
  return (
    <motion.div
      role="row"
      initial={animated || fresh ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, transition: ease('collapse') }}
      transition={ease('standard', animated ? index * 0.03 : 0)}
      onClick={() => onOpen(member)}
      className="group relative cursor-pointer overflow-hidden border-b border-line text-[0.8125rem]"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-lg bg-surface-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
      />
      {fresh ? (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1 start-0 w-0.5 rounded-full bg-turq-300"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={ease('flash')}
        />
      ) : null}
      <div
        className={`${GRID} relative px-3 py-2.5 transition-transform duration-200 ease-brand group-hover:-translate-y-0.5 motion-reduce:group-hover:translate-y-0`}
      >
        <div role="cell" className="flex min-w-0 items-center gap-3">
          <Avatar name={member.name} size={32} />
          <div className="min-w-0">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={t('members.open', { name })}
              className="block max-w-full truncate rounded text-start text-sm font-medium text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {name}
            </button>
            {/* On a phone, the status and what they pay on a second line. */}
            <p className="flex min-w-0 items-center gap-2 text-subtle @xl/table:hidden">
              {status}
              {paid ? <span className="metric shrink-0 text-fg">{paid}</span> : null}
            </p>
          </div>
        </div>
        <div role="cell" className="flex justify-center">
          {risk ? (
            <RiskRing
              score={risk.score}
              size={32}
              // 40 ms apart, the first ten; the others draw together.
              delay={0.1 + Math.min(index, ANIMATED_ROWS) * 0.04}
              label={
                risk.level === 'scheduled_departure'
                  ? t(LEVELS[risk.level].label)
                  : t('risk.badge', {
                      level: t(LEVELS[risk.level].label),
                      score: number(risk.score),
                    })
              }
            />
          ) : (
            <span className="text-subtle">–</span>
          )}
        </div>
        <div role="cell" className="hidden min-w-0 text-fg @xl/table:flex">
          {status}
        </div>
        <div role="cell" className="hidden justify-end @xl/table:flex">
          {paid ? (
            <span className="metric text-sm text-fg">{paid}</span>
          ) : (
            <span className="text-subtle">{t('members.free')}</span>
          )}
        </div>
        <div role="cell" className="hidden truncate text-subtle @3xl/table:block">
          {last === null ? t('members.never') : relative(new Date(last), new Date(now))}
        </div>
        <div role="cell" className="hidden truncate text-subtle @3xl/table:block">
          {end === null
            ? '–'
            : isLeaving(member)
              ? t('members.endsOn', { date: day(new Date(end)) })
              : day(new Date(end))}
        </div>
        <div role="cell">
          {member.doNotContact ? (
            <>
              <BellOff aria-hidden="true" className="size-4 text-subtle" />
              <span className="sr-only">{t('members.contact.never')}</span>
            </>
          ) : null}
        </div>
        <div role="cell" aria-hidden="true" className="hidden text-subtle @xl/table:block">
          <ChevronRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180" />
        </div>
      </div>
    </motion.div>
  );
}
