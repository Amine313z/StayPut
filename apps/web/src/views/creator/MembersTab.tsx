import type { MemberRow } from '@stayput/core';
import { Search, Users } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { MemberList } from '../../components/MemberRows';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { useCreatorData } from '../CreatorView';

/** By risk level (SPEC Phase 3), the new members who did not start, and those who left. */
const FILTERS = ['all', 'leaving', 'high', 'medium', 'low', 'newcomers', 'left'] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS = {
  all: 'members.filter.all',
  leaving: 'members.filter.leaving',
  high: 'members.filter.high',
  medium: 'members.filter.medium',
  low: 'members.filter.low',
  newcomers: 'members.filter.newcomers',
  left: 'members.filter.left',
} as const;

function keep(filter: Filter, member: MemberRow): boolean {
  switch (filter) {
    case 'leaving':
      return member.risk?.level === 'scheduled_departure';
    case 'high':
    case 'medium':
    case 'low':
      return member.risk?.level === filter;
    case 'newcomers':
      return member.risk?.inactiveNewcomer === true;
    case 'left':
      return member.status === 'left';
    case 'all':
      return true;
  }
}

/** Search a name, accents and case aside: « Élodie » matches « elodie ». */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Every member StayPut collected, the most at risk first, to search and filter (the address
 * keeps the choice).
 */
export function MembersTab() {
  const { t, number } = useI18n();
  const { members } = useCreatorData();
  const [params, setParams] = useSearchParams();
  const filter = FILTERS.find((f) => f === params.get('filter')) ?? 'all';
  const query = params.get('q') ?? '';

  if (members.state.status === 'loading') return <Loading />;
  if (members.state.status === 'error') {
    return (
      <ErrorPanel
        error={members.state.error}
        forbiddenKey="error.forbidden.creator"
        onRetry={members.retry}
      />
    );
  }
  const page = members.state.data;
  const update = (next: { filter?: Filter; q?: string }) => {
    const search = new URLSearchParams(params);
    const f = next.filter ?? filter;
    const q = next.q ?? query;
    if (f === 'all') search.delete('filter');
    else search.set('filter', f);
    if (q) search.set('q', q);
    else search.delete('q');
    setParams(search, { replace: true });
  };
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f, page.members.filter((m) => keep(f, m)).length]),
  ) as Record<Filter, number>;
  const shown = page.members.filter(
    (m) => keep(filter, m) && (!query || fold(m.name ?? '').includes(fold(query))),
  );

  return (
    <Card
      icon={<Users aria-hidden="true" className="size-4" />}
      title={t('members.title')}
      description={t('members.description')}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="group"
          aria-label={t('members.filter.label')}
          className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1"
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => update({ filter: f })}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                filter === f ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg'
              }`}
            >
              {t(FILTER_LABELS[f])}
              <span className="tabular ms-1.5 text-xs text-muted">{number(counts[f])}</span>
            </button>
          ))}
        </div>
        <label className="relative block sm:w-64">
          <span className="sr-only">{t('members.search')}</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => update({ q: event.target.value })}
            placeholder={t('members.search')}
            className="w-full rounded-lg border border-line bg-surface py-2 ps-9 pe-3 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
        </label>
      </div>
      <div className="mt-2">
        {page.members.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={<Users aria-hidden="true" className="size-5" />}
              body={t('members.empty')}
            />
          </div>
        ) : shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t('members.noMatch')}</p>
        ) : (
          <MemberList members={shown} />
        )}
      </div>
      {page.truncated ? (
        <p className="mt-2 text-sm text-muted">
          {t('members.truncated', { count: number(page.members.length) })}
        </p>
      ) : null}
    </Card>
  );
}
