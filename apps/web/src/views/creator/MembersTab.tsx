import type { MemberRow, MembersPage } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { BellOff, Search, Users } from 'lucide-react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useEffect, useEffectEvent, useId, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { postJson, type Loadable } from '../../api';
import { MemberDrawer } from '../../components/MemberDrawer';
import { MemberTable } from '../../components/MemberTable';
import { ErrorPanel } from '../../components/Status';
import { useI18n } from '../../i18n';
import {
  FIRST_DIRECTION,
  MEMBER_FILTERS,
  MEMBER_SORTS,
  SEARCH_DELAY_MS,
  keepMember,
  matchesSearch,
  sortMembers,
  type MemberFilter,
  type MemberSort,
  type SortDirection,
} from '../../members';
import { ease } from '../../motion';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { RowsSkeleton } from '../../ui/Skeleton';
import { useCreatorData } from '../CreatorView';

const FILTER_LABELS: Readonly<Record<MemberFilter, MessageKey>> = {
  all: 'members.filter.all',
  leaving: 'members.filter.leaving',
  high: 'members.filter.high',
  medium: 'members.filter.medium',
  low: 'members.filter.low',
  newcomers: 'members.filter.newcomers',
  left: 'members.filter.left',
};

/** The order a table first shows: the most at risk first. */
const DEFAULT_SORT: MemberSort = 'risk';

/**
 * Every member StayPut read (brief v4 §9.3): the filter chips and the search stay on top while
 * the table scrolls, every column sorts, a row opens the member's drawer. The address keeps it
 * all (`filter`, `q`, `sort`, `dir`, `member`), so a link opens the same view.
 */
export function MembersTab() {
  const { t, number } = useI18n();
  const { members, api, testMode } = useCreatorData();
  useMemberCounts();
  useReviewed(api);
  const table = useTableAddress();
  const filter = MEMBER_FILTERS.find((f) => f === table.params.get('filter')) ?? 'all';
  const search = useSearchField(table);
  const isNew = useNewcomers(members.state);
  const compare = useCompareNames();
  // The moment the page opened: who is « inactive » does not change while the creator reads.
  const [now] = useState(() => Date.now());
  const page = members.state.status === 'ready' ? members.state.data : null;
  const counts = useMemo(
    () =>
      Object.fromEntries(
        MEMBER_FILTERS.map((f) => [f, page?.members.filter((m) => keepMember(f, m)).length ?? 0]),
      ) as Record<MemberFilter, number>,
    [page],
  );
  // Filtered on what the field holds, at once: the address follows on its own time.
  const shown = useMemo(() => {
    const kept = (page?.members ?? []).filter(
      (m) => keepMember(filter, m) && matchesSearch(m, search.text),
    );
    return sortMembers(kept, table.sort, table.direction, now, compare);
  }, [page, filter, search.text, table.sort, table.direction, now, compare]);
  const clear = () => {
    search.set('');
    table.change((address) => {
      address.delete('q');
      address.delete('filter');
    });
  };

  if (members.state.status === 'error') {
    return (
      <ErrorPanel
        error={members.state.error}
        forbiddenKey="error.forbidden.creator"
        onRetry={members.retry}
      />
    );
  }
  const open = page?.members.find((m) => m.id === table.openId) ?? null;
  return (
    <div>
      <div className="sticky top-16 z-10 -mx-4 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <FilterChips
            value={filter}
            counts={page ? counts : null}
            onChange={(next) =>
              table.change((search) => {
                if (next === 'all') search.delete('filter');
                else search.set('filter', next);
              })
            }
          />
          <label className="relative block shrink-0 lg:w-64">
            <span className="sr-only">{t('members.search')}</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
            />
            <input
              type="search"
              value={search.text}
              onChange={(event) => search.set(event.target.value)}
              onFocus={() => search.focus(true)}
              onBlur={() => search.focus(false)}
              placeholder={t('members.search')}
              className="h-9 w-full rounded-lg border border-line bg-surface ps-9 pe-3 text-[0.8125rem] text-fg transition-colors duration-150 placeholder:text-subtle hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          </label>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1">
        {page === null ? (
          <div className="px-3 py-4" role="status" aria-label={t('common.loading')}>
            <RowsSkeleton rows={8} />
          </div>
        ) : (
          <AnimatePresence initial={false}>
            <FilterView key={filter}>
              {page.members.length === 0 ? (
                <EmptyState
                  icon={<Users aria-hidden="true" className="size-5" />}
                  body={t('members.empty')}
                />
              ) : shown.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <p className="text-sm text-muted">
                    {search.text.trim()
                      ? t('members.noMatch.search', { query: search.text.trim() })
                      : t('members.noMatch')}
                  </p>
                  <Button variant="ghost" size="sm" onClick={clear}>
                    {t('members.clearSearch')}
                  </Button>
                </div>
              ) : (
                <MemberTable
                  members={shown}
                  label={t('tab.allMembers')}
                  sort={table.sort}
                  direction={table.direction}
                  onSort={table.onSort}
                  onOpen={table.open}
                  now={now}
                  isNew={isNew}
                />
              )}
            </FilterView>
          </AnimatePresence>
        )}
      </div>
      {page?.truncated ? (
        <p className="mt-3 text-sm text-muted">
          {t('members.truncated', { count: number(page.members.length) })}
        </p>
      ) : null}
      {open ? (
        <MemberDrawer
          key={open.id}
          member={open}
          api={api}
          testMode={testMode.on}
          now={now}
          onClose={table.close}
          onChanged={members.reload}
        />
      ) : null}
    </div>
  );
}

/**
 * Members › Do not contact: the members StayPut takes no action of any kind for, in the same
 * table. Taking one off the list is in their drawer; they then fold away from this one.
 */
export function NeverContactTab() {
  const { t } = useI18n();
  const { members, api, testMode } = useCreatorData();
  useMemberCounts();
  const table = useTableAddress();
  const isNew = useNewcomers(members.state);
  const compare = useCompareNames();
  const [now] = useState(() => Date.now());
  const page = members.state.status === 'ready' ? members.state.data : null;
  const listed = useMemo(
    () =>
      sortMembers(
        (page?.members ?? []).filter((m) => m.doNotContact),
        table.sort,
        table.direction,
        now,
        compare,
      ),
    [page, table.sort, table.direction, now, compare],
  );
  if (members.state.status === 'error') {
    return (
      <ErrorPanel
        error={members.state.error}
        forbiddenKey="error.forbidden.creator"
        onRetry={members.retry}
      />
    );
  }
  if (page === null) {
    return (
      <div className="px-3 py-4" role="status" aria-label={t('common.loading')}>
        <RowsSkeleton rows={4} />
      </div>
    );
  }
  // The drawer stays open on a member just taken off the list.
  const open = page.members.find((m) => m.id === table.openId) ?? null;
  return (
    <div>
      {listed.length === 0 ? (
        <EmptyState
          icon={<BellOff aria-hidden="true" className="size-5" />}
          body={t('neverContact.none')}
        />
      ) : (
        <MemberTable
          members={listed}
          label={t('tab.neverContact')}
          sort={table.sort}
          direction={table.direction}
          onSort={table.onSort}
          onOpen={table.open}
          now={now}
          isNew={isNew}
        />
      )}
      {open ? (
        <MemberDrawer
          key={open.id}
          member={open}
          api={api}
          testMode={testMode.on}
          now={now}
          onClose={table.close}
          onChanged={members.reload}
        />
      ) : null}
    </div>
  );
}

/**
 * What one filter shows, cross-fading with the next (200 ms): both share the grid's one cell
 * while they fade, so nothing has to be pinned by an injected style (the CSP allows none). The
 * one leaving is out of reach meanwhile.
 */
function FilterView({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={ease('hover')}
      inert={!present}
      className="col-start-1 row-start-1 min-w-0"
    >
      {children}
    </motion.div>
  );
}

/**
 * The filter chips (brief v4 §9.3), each with how many it keeps: the chosen one's pill slides
 * to it (300 ms). On a phone they scroll sideways rather than wrap.
 */
function FilterChips({
  value,
  counts,
  onChange,
}: {
  value: MemberFilter;
  /** Null while the members load. */
  counts: Record<MemberFilter, number> | null;
  onChange: (filter: MemberFilter) => void;
}) {
  const { t, number } = useI18n();
  const pill = useId();
  return (
    <div
      role="group"
      aria-label={t('members.filter.label')}
      className="-mx-1 -my-1 flex gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:none]"
    >
      {MEMBER_FILTERS.map((f) => {
        const on = f === value;
        return (
          <button
            key={f}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(f)}
            className={`relative shrink-0 rounded-full px-3 py-1.5 text-[0.8125rem] font-medium whitespace-nowrap transition-colors duration-200 ease-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              on ? 'text-turq-300' : 'text-subtle hover:text-fg'
            }`}
          >
            {on ? (
              <motion.span
                layoutId={pill}
                transition={ease('standard')}
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-surface-3"
              />
            ) : null}
            <span className="relative">
              {t(FILTER_LABELS[f])}
              {counts ? (
                <span className="tabular ms-1.5 text-xs text-subtle">{number(counts[f])}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * What the address keeps of a table of members: its order (`sort`, `dir`) and the member whose
 * drawer is open (`member`). Each change replaces the address, so Back leaves the page.
 */
function useTableAddress() {
  const [params, setParams] = useSearchParams();
  const sort = MEMBER_SORTS.find((s) => s === params.get('sort')) ?? DEFAULT_SORT;
  const dir = params.get('dir');
  const direction: SortDirection = dir === 'asc' || dir === 'desc' ? dir : FIRST_DIRECTION[sort];
  const change = (edit: (search: URLSearchParams) => void) => {
    const search = new URLSearchParams(params);
    edit(search);
    setParams(search, { replace: true });
  };
  return {
    params,
    sort,
    direction,
    openId: params.get('member'),
    change,
    /** The open column again: the other way; another column: its most telling way first. */
    onSort: (column: MemberSort) =>
      change((search) => {
        const next =
          column === sort ? (direction === 'asc' ? 'desc' : 'asc') : FIRST_DIRECTION[column];
        if (column === DEFAULT_SORT) search.delete('sort');
        else search.set('sort', column);
        if (next === FIRST_DIRECTION[column]) search.delete('dir');
        else search.set('dir', next);
      }),
    open: (member: MemberRow) => change((search) => search.set('member', member.id)),
    close: () => change((search) => search.delete('member')),
  };
}

/**
 * The search field (fix prompt v4.1, block 3). It keeps what is typed itself, so no key is ever
 * lost to the address catching up, and the address follows 250 ms after the last key (`q`,
 * replaced, never pushed). When the address changes otherwise (Back, a link, « Clear search and
 * filters »), the field follows it, unless the creator is typing in it.
 */
function useSearchField(table: ReturnType<typeof useTableAddress>) {
  const fromAddress = table.params.get('q') ?? '';
  const [text, setText] = useState(fromAddress);
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(fromAddress);
  if (fromAddress !== seen) {
    setSeen(fromAddress);
    if (!focused) setText(fromAddress);
  }
  const write = useEffectEvent((words: string) =>
    table.change((address) => {
      if (words) address.set('q', words);
      else address.delete('q');
    }),
  );
  useEffect(() => {
    if (text === fromAddress) return;
    const later = window.setTimeout(() => write(text), SEARCH_DELAY_MS);
    return () => window.clearTimeout(later);
  }, [text, fromAddress]);
  return { text, set: setText, focus: setFocused };
}

/** Names in the creator's language's order, accents and case aside. */
function useCompareNames(): (a: string, b: string) => number {
  const { locale } = useI18n();
  return useMemo(
    () => new Intl.Collator(locale, { sensitivity: 'base', numeric: true }).compare,
    [locale],
  );
}

/** Who was there when the members first showed: anyone else is new (their row flashes). */
function useNewcomers(state: Loadable<MembersPage>): (id: string) => boolean {
  const [known, setKnown] = useState<ReadonlySet<string> | null>(null);
  if (known === null && state.status === 'ready') {
    setKnown(new Set(state.data.members.map((m) => m.id)));
  }
  return (id) => known !== null && !known.has(id);
}

/** The communities whose members were opened since the page loaded. */
const reviewed = new Set<string>();

/** « Getting started »: opening the members ticks « Review your at-risk members » (once). */
function useReviewed(api: string) {
  useEffect(() => {
    if (reviewed.has(api)) return;
    reviewed.add(api);
    postJson(`${api}/getting-started/reviewed`).catch(() => {
      // A convenience: the next visit ticks it.
      reviewed.delete(api);
    });
  }, [api]);
}

/** Members › how many in all, and on the « do not contact » list: the section's tabs say it. */
function useMemberCounts() {
  const { members, tabCounts } = useCreatorData();
  const page = members.state.status === 'ready' ? members.state.data : null;
  const all = page?.members.length;
  const never = page?.members.filter((m) => m.doNotContact).length;
  useEffect(() => {
    if (all !== undefined && never !== undefined) {
      tabCounts?.({ '': all, 'never-contact': never });
    }
  }, [tabCounts, all, never]);
}
