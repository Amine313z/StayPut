import type { PlatformDayView } from '@stayput/core';
import { CalendarDays } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Loadable } from '../../../api';
import { ErrorPanel } from '../../../components/Status';
import { useI18n } from '../../../i18n';
import { RowsSkeleton } from '../../../ui/Skeleton';

/** « Showing Oct 3 · Show 30 days »: the day the blocks below show. */
export function PickedChip({
  day,
  onClear,
}: {
  day: Loadable<PlatformDayView>;
  onClear: () => void;
}) {
  const { t, locale } = useI18n();
  if (day.status !== 'ready') return null;
  const label = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.parse(`${day.data.day}T12:00:00Z`)));
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        data-picked-day={day.data.day}
        className="inline-flex items-center gap-1.5 rounded-full bg-turq-300/10 px-2.5 py-0.5 text-xs font-medium text-turq-300"
      >
        <CalendarDays aria-hidden="true" className="size-3.5" />
        {t('platform.day.chip', { day: label })}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="rounded-sm text-xs text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t('platform.day.clear')}
      </button>
    </span>
  );
}

/** A block's data once read; meanwhile its skeleton, or what went wrong with « Retry ». */
export function Resolved<T>({
  state,
  retry,
  children,
}: {
  state: Loadable<T>;
  retry: () => void;
  children: (data: T) => ReactNode;
}) {
  if (state.status === 'loading') return <RowsSkeleton rows={3} />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <>{children(state.data)}</>;
}
