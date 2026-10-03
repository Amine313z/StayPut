import type { AccountPlatform, PlatformActivity, PlatformActivityView } from '@stayput/core';
import { Activity, MapPin, Trophy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApi, usePolling, useReloadOnReturn, type Loadable } from '../api';
import { useI18n } from '../i18n';
import { Badge } from '../ui/Badge';
import { DiscordIcon, TelegramIcon } from '../ui/BrandIcons';
import { Card } from '../ui/Card';
import { ErrorPanel, Loading } from './Status';

const DAY_MS = 86_400_000;

/** The platform's color: one per chart, never two side by side (both are blues). */
const BAR: Readonly<Record<AccountPlatform, string>> = {
  discord: 'bg-discord',
  telegram: 'bg-telegram',
};

/** While the page shows the activity, it is read again this often. */
export const LIVE_REFRESH_MS = 10_000;

/**
 * What StayPut sees on Discord and Telegram over the last 30 days (the founder, 2026-10-01): the
 * messages per platform and per day, who wrote them (members, the team, guests, accounts not tied
 * yet), each server and group, and the most active members. The team's messages show here, never
 * in the scores. Live: no need to reload the page to see a new message.
 */
export function PlatformActivityCard({
  api,
  platforms,
  refreshKey = 0,
  onNews,
}: {
  api: string;
  /** The connected platforms: a platform not connected is left out. */
  platforms: readonly AccountPlatform[];
  /** Read again at once when it changes (an account was tied: its messages moved). */
  refreshKey?: number;
  /** New messages arrived: the accounts to tie and the counts of the sources may have moved. */
  onNews?: () => void;
}) {
  const { t } = useI18n();
  const { state, retry } = useLiveActivity(api, refreshKey, onNews);
  return (
    <Card
      icon={<Activity aria-hidden="true" className="size-4" />}
      title={t('activity.title')}
      description={t('activity.description')}
      actions={
        <Badge
          tone="accent"
          icon={
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse"
            />
          }
        >
          {t('activity.live')}
        </Badge>
      }
    >
      {state.status === 'loading' ? (
        <Loading />
      ) : state.status === 'error' ? (
        <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
      ) : (
        <ActivityBody view={state.data} platforms={platforms} />
      )}
    </Card>
  );
}

/**
 * The activity kept current while the page is open: read at once (the server reads Discord's
 * channels first, for 2.5 seconds at most; Telegram sends its messages itself), then every
 * 10 seconds while the tab is visible, at once when the creator comes back to it, and when
 * `refreshKey` changes. One reading at a time, as every block reads (useApi): a reading never
 * cancels the one under way, so the answers come in order, and the block shows its data, or
 * says it is taking long with « Retry », within 5 seconds. What is shown stays when a reading
 * fails: the next one tries again.
 */
function useLiveActivity(
  api: string,
  refreshKey: number,
  onNews: (() => void) | undefined,
): { state: Loadable<PlatformActivityView>; retry: () => void } {
  const { state, retry, reload } = useApi<PlatformActivityView>(
    `${api}/platform-activity/refresh`,
    { method: 'POST' },
  );
  usePolling(reload, LIVE_REFRESH_MS);
  useReloadOnReturn(reload);
  const latestReload = useRef(reload);
  useEffect(() => {
    latestReload.current = reload;
  });
  useEffect(() => {
    if (refreshKey > 0) latestReload.current();
  }, [refreshKey]);
  // New messages since the last answer: the accounts to tie and the people may have moved.
  const news = useRef(onNews);
  useEffect(() => {
    news.current = onNews;
  });
  const seen = useRef<string | null>(null);
  const view = state.status === 'ready' ? state.data : null;
  useEffect(() => {
    if (!view) return;
    const mark = signature(view);
    if (seen.current !== null && seen.current !== mark) news.current?.();
    seen.current = mark;
  }, [view]);
  return { state, retry };
}

/** What changes when a message arrives. */
function signature(view: PlatformActivityView): string {
  return view.platforms.map((p) => `${p.platform}:${p.messages}:${p.lastAt ?? ''}`).join('|');
}

function ActivityBody({
  view,
  platforms,
}: {
  view: PlatformActivityView;
  platforms: readonly AccountPlatform[];
}) {
  const { t, plural, relative } = useI18n();
  const shown = view.platforms.filter((p) => platforms.includes(p.platform));
  const places = view.places.filter((p) => platforms.includes(p.platform));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {shown.map((activity) => (
          <PlatformTile key={activity.platform} activity={activity} from={view.from} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section aria-labelledby="activity-members">
          <h3 id="activity-members" className="flex items-center gap-2 text-sm font-semibold">
            <Trophy aria-hidden="true" className="size-4 text-muted" />
            {t('activity.topMembers')}
          </h3>
          {view.topMembers.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t('activity.noMembers')}</p>
          ) : (
            <ol className="mt-2 divide-y divide-line">
              {view.topMembers.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="truncate font-medium">{m.name ?? t('members.unnamed')}</span>
                  <span className="tabular shrink-0 text-muted">
                    {[
                      m.discord > 0 ? t('activity.onDiscord', { count: m.discord }) : null,
                      m.telegram > 0 ? t('activity.onTelegram', { count: m.telegram }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section aria-labelledby="activity-places">
          <h3 id="activity-places" className="flex items-center gap-2 text-sm font-semibold">
            <MapPin aria-hidden="true" className="size-4 text-muted" />
            {t('activity.places')}
          </h3>
          {places.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t('activity.noMessages')}</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {places.map((place) => (
                <li
                  key={`${place.platform}:${place.id ?? ''}`}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <PlatformIcon platform={place.platform} />
                    <span className="truncate font-medium">
                      {place.name ??
                        t(place.platform === 'discord' ? 'discord.unnamed' : 'telegram.unnamed')}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-muted">
                    {plural('activity.messages', place.messages)} ·{' '}
                    {relative(new Date(place.lastAt))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function PlatformIcon({ platform }: { platform: AccountPlatform }) {
  const { t } = useI18n();
  const Icon = platform === 'discord' ? DiscordIcon : TelegramIcon;
  return (
    <Icon
      role="img"
      aria-label={t(platform === 'discord' ? 'sources.discord.name' : 'sources.telegram.name')}
      className={`size-4 shrink-0 ${platform === 'discord' ? 'text-discord' : 'text-telegram'}`}
    />
  );
}

/** One platform: its messages and the members' part of them, who wrote them, a bar per day. */
function PlatformTile({ activity, from }: { activity: PlatformActivity; from: string }) {
  const { t, plural, relative, number } = useI18n();
  const name = t(
    activity.platform === 'discord' ? 'sources.discord.name' : 'sources.telegram.name',
  );
  const kinds = [
    { count: activity.members, key: 'activity.kind.members', tone: 'accent' },
    { count: activity.team, key: 'activity.kind.team', tone: 'neutral' },
    { count: activity.unlinked, key: 'activity.kind.unlinked', tone: 'warning' },
    { count: activity.guests, key: 'activity.kind.guests', tone: 'neutral' },
  ] as const;
  return (
    <div className="rounded-2xl border border-line p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium">
            <PlatformIcon platform={activity.platform} />
            {name}
          </p>
          <p className="tabular mt-2 text-2xl font-semibold tracking-tight">
            {plural('activity.messages', activity.messages)}
          </p>
          {/* The members' part: what their own 30 days add up to there (fix prompt v4.1,
              block 4); the rest is the team's, guests' and accounts' not tied yet. */}
          {activity.messagesBy ? (
            <p data-by-members="" className="tabular text-sm text-muted">
              {t('activity.byMembers', { count: number(activity.messagesBy.members) })}
            </p>
          ) : null}
          <p className="mt-0.5 text-xs text-muted">
            {activity.lastAt
              ? t('activity.lastMessage', { when: relative(new Date(activity.lastAt)) })
              : t('activity.noMessages')}
          </p>
        </div>
      </div>
      {activity.authors > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label={t('activity.whoWrote')}>
          {kinds
            .filter((k) => k.count > 0)
            .map((k) => (
              <Badge key={k.key} tone={k.tone}>
                {plural(k.key, k.count)}
              </Badge>
            ))}
        </div>
      ) : null}
      <DailyBars
        daily={activity.daily}
        from={from}
        color={BAR[activity.platform]}
        label={t('activity.chart', { platform: name })}
      />
    </div>
  );
}

/**
 * A bar per day over 30 days, one color, anchored to a baseline. Pointing at a day reads it out
 * below (the last day otherwise); the same figures are in a table for screen readers.
 */
function DailyBars({
  daily,
  from,
  color,
  label,
}: {
  daily: readonly number[];
  /** The first day (yyyy-mm-dd), a calendar day of the creator's zone. */
  from: string;
  color: string;
  label: string;
}) {
  const { plural, locale } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  // A calendar day: read at noon in UTC, it is the same day everywhere.
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const start = Date.parse(`${from}T12:00:00Z`);
  const dayLabel = (index: number) => day.format(new Date(start + index * DAY_MS));
  const max = Math.max(1, ...daily);
  const shown = active ?? daily.length - 1;
  return (
    <figure className="mt-4">
      <div
        aria-hidden="true"
        onMouseLeave={() => setActive(null)}
        className="flex h-20 items-end gap-0.5 border-b border-line"
      >
        {daily.map((count, index) => (
          <div
            key={index}
            onMouseEnter={() => setActive(index)}
            className="flex h-full flex-1 items-end"
          >
            <div
              className={`w-full rounded-t-[4px] ${color} ${
                active !== null && active !== index ? 'opacity-50' : ''
              }`}
              style={{ height: count > 0 ? `${Math.max(6, (count / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <figcaption className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted">
        <span className="tabular" aria-hidden="true">
          {dayLabel(shown)} · {plural('activity.messages', daily[shown] ?? 0)}
        </span>
        <span className="tabular">
          {dayLabel(0)} – {dayLabel(daily.length - 1)}
        </span>
      </figcaption>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {daily.map((count, index) => (
            <tr key={index}>
              <th scope="row">{dayLabel(index)}</th>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
