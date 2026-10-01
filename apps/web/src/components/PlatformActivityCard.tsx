import type { AccountPlatform, PlatformActivity, PlatformActivityView } from '@stayput/core';
import { Activity, MapPin, Trophy } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../api';
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

/**
 * What StayPut sees on Discord and Telegram over the last 30 days (the founder, 2026-10-01): the
 * messages per platform and per day, who wrote them (members, the team, guests, accounts not tied
 * yet), each server and group, and the most active members. The team's messages show here, never
 * in the scores.
 */
export function PlatformActivityCard({
  api,
  platforms,
}: {
  api: string;
  /** The connected platforms: a platform not connected is left out. */
  platforms: readonly AccountPlatform[];
}) {
  const { t } = useI18n();
  const { state, retry } = useApi<PlatformActivityView>(`${api}/platform-activity`);
  return (
    <Card
      icon={<Activity aria-hidden="true" className="size-4" />}
      title={t('activity.title')}
      description={t('activity.description')}
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

/** One platform: its messages, who wrote them, and a bar per day. */
function PlatformTile({ activity, from }: { activity: PlatformActivity; from: string }) {
  const { t, plural, relative } = useI18n();
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
