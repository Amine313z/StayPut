import type {
  AccountPlatform,
  ActivityPlatform,
  IntegrationsStatus,
  PlatformActivityView,
  PlatformDashboard,
  PlatformDayView,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { Clock3, MessagesSquare, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApi, usePolling, useReloadOnReturn, type Loadable } from '../../../api';
import { AccountsCard } from '../../../components/AccountsCard';
import { PeopleCard } from '../../../components/PeopleCard';
import { ErrorPanel } from '../../../components/Status';
import { useI18n } from '../../../i18n';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Heatmap } from '../../../ui/charts/Heatmap';
import { MessagesChart } from '../../../ui/charts/MessagesChart';
import { MetricSkeleton, RowsSkeleton, Skeleton } from '../../../ui/Skeleton';
import { useCreatorData } from '../../CreatorView';
import { BotSettings } from './BotSettings';
import { PlaceBars } from './PlaceBars';
import { PlatformHero, WhopHero } from './PlatformHero';
import { PickedChip, Resolved } from './parts';
import { PlatformMembers, SlotMembers } from './PlatformMembers';
import { SignalsPanel } from './SignalsPanel';

/** While the page is open, what arrives is read this often (Discord's channels first). */
export const LIVE_REFRESH_MS = 10_000;
/** During the connection test, faster: the message shows within seconds. */
export const TEST_REFRESH_MS = 3_000;

/**
 * Integrations › Discord or › Telegram, a dashboard of its own (brief v4 §9.6, fix prompt v4.1
 * block 7): the connection and its three figures; the messages day by day (a day picked shows
 * its channels and members); when the community writes; each channel, group and topic; the most
 * active and the silent members; the signals and their preview; who is who; the bot's settings.
 * Live: a message that arrives shows without reloading. Every block shows its data, says there is
 * none, or says what went wrong with « Retry », within 5 seconds (useApi). Who wrote, where and
 * when; never what.
 */
export function PlatformDashboardView({
  platform,
  status,
}: {
  platform: AccountPlatform;
  status: IntegrationsStatus;
}) {
  const { t } = useI18n();
  const { api, integrations, members } = useCreatorData();
  const path = `${api}/platforms/${platform}`;
  const dashboard = useApi<PlatformDashboard>(path);
  const [testing, setTesting] = useState(false);
  // New messages may come from accounts to tie; tying one moves its messages. The people move
  // with both: a new writer, an account tied.
  const [accountsKey, setAccountsKey] = useState(0);
  const [peopleKey, setPeopleKey] = useState(0);
  const live = useLiveNews(api, platform, testing, () => {
    dashboard.reload();
    integrations.reload();
    setAccountsKey((key) => key + 1);
    setPeopleKey((key) => key + 1);
  });
  const view = dashboard.state.status === 'ready' ? dashboard.state.data : null;
  return (
    <div className="space-y-6" data-platform={platform}>
      <PlatformHero
        platform={platform}
        status={status}
        hero={view?.hero ?? (dashboard.state.status === 'loading' ? 'loading' : null)}
        lastMessageAt={live.lastAt}
      />
      <ActivityBlocks platform={platform} path={path} dashboard={dashboard}>
        {view ? (
          <SignalsPanel
            key={JSON.stringify(view.signals.settings[platform])}
            platform={platform}
            view={view.signals}
            onSaved={() => {
              dashboard.reload();
              members.reload();
            }}
          />
        ) : (
          <Card title={t('signals.title')}>
            <MetricSkeleton />
          </Card>
        )}
      </ActivityBlocks>
      <section aria-labelledby={`${platform}-who`} className="space-y-4">
        <h2 id={`${platform}-who`} className="title-section">
          {t('platform.linking.title')}
        </h2>
        <AccountsCard
          api={api}
          platform={platform}
          members={members.state.status === 'ready' ? members.state.data.members : []}
          refreshKey={accountsKey}
          onChange={() => {
            integrations.reload();
            members.reload();
            dashboard.reload();
            setPeopleKey((key) => key + 1);
          }}
        />
        <PeopleCard
          api={api}
          whopAppId={status.whopAppId}
          platform={platform}
          refreshKey={peopleKey}
        />
      </section>
      <BotSettings
        platform={platform}
        status={status}
        lastMessageAt={live.lastAt}
        onTesting={setTesting}
      />
    </div>
  );
}

/**
 * Integrations › Whop, the same dashboard (0049): what the members write in the community's
 * chats and forums, read by the synchronization. No signals (Whop's activity already makes the
 * score), no accounts to tie (whoever writes on Whop is known), no bot. A synchronization that
 * ends brings it up to date.
 */
export function WhopDashboardView() {
  const { api, sync } = useCreatorData();
  const path = `${api}/platforms/whop`;
  const dashboard = useApi<PlatformDashboard>(path);
  const lastSyncAt = sync.status?.lastSyncAt ?? null;
  const seen = useRef(lastSyncAt);
  const reload = useRef(dashboard.reload);
  useEffect(() => {
    reload.current = dashboard.reload;
  });
  useEffect(() => {
    // The status's first reading is no news: the dashboard was read with it.
    if (seen.current !== null && lastSyncAt !== null && seen.current !== lastSyncAt) {
      reload.current();
    }
    seen.current = lastSyncAt;
  }, [lastSyncAt]);
  const view = dashboard.state.status === 'ready' ? dashboard.state.data : null;
  return (
    <div className="space-y-6" data-platform="whop">
      <WhopHero
        sync={sync}
        hero={view?.hero ?? (dashboard.state.status === 'loading' ? 'loading' : null)}
      />
      <ActivityBlocks platform="whop" path={path} dashboard={dashboard} />
    </div>
  );
}

const CHART_PICK = {
  discord: 'platform.chart.pick.discord',
  telegram: 'platform.chart.pick.telegram',
  whop: 'platform.chart.pick.whop',
} as const satisfies Record<ActivityPlatform, MessageKey>;

const PLACES_TITLE = {
  discord: 'platform.places.title.discord',
  telegram: 'platform.places.title.telegram',
  whop: 'platform.places.title.whop',
} as const satisfies Record<ActivityPlatform, MessageKey>;

/**
 * What every platform's dashboard shows of its activity: the messages day by day (a day picked
 * shows its places and members), when the community writes, each place, the most active and the
 * silent members; then `children`. One error and one « Retry » when the reading failed.
 */
function ActivityBlocks({
  platform,
  path,
  dashboard,
  children,
}: {
  platform: ActivityPlatform;
  path: string;
  dashboard: { state: Loadable<PlatformDashboard>; retry: () => void };
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { members } = useCreatorData();
  const [picked, setPicked] = useState<string | null>(null);
  const view = dashboard.state.status === 'ready' ? dashboard.state.data : null;
  if (dashboard.state.status === 'error') {
    // The blocks share one reading: one error, one « Retry », no empty cards.
    return (
      <ErrorPanel
        error={dashboard.state.error}
        forbiddenKey="error.forbidden.creator"
        onRetry={dashboard.retry}
      />
    );
  }
  return (
    <>
      <Card
        icon={<MessagesSquare aria-hidden="true" className="size-4" />}
        title={t('platform.chart.title')}
        description={t(CHART_PICK[platform])}
        actions={
          picked ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<X aria-hidden="true" className="size-4" />}
              onClick={() => setPicked(null)}
            >
              {t('platform.day.clear')}
            </Button>
          ) : null
        }
      >
        {view ? (
          <DailyChart view={view} picked={picked} onPick={setPicked} />
        ) : (
          <Skeleton className="h-[200px] w-full" />
        )}
      </Card>
      <DayData path={path} day={picked}>
        {(day, retryDay) => (
          <>
            <div className="grid min-w-0 gap-6 xl:grid-cols-2">
              <Card
                icon={<Clock3 aria-hidden="true" className="size-4" />}
                title={t('platform.heat.title')}
                description={t('platform.heat.description')}
              >
                {view ? (
                  <HeatBlock platform={platform} path={path} view={view} />
                ) : (
                  <Skeleton className="h-48 w-full" />
                )}
              </Card>
              <Card
                title={t(PLACES_TITLE[platform])}
                description={
                  day ? <PickedChip day={day} onClear={() => setPicked(null)} /> : undefined
                }
              >
                {day ? (
                  <Resolved state={day} retry={retryDay}>
                    {(data) => <PlaceBars platform={platform} places={data.places} />}
                  </Resolved>
                ) : view ? (
                  <PlaceBars platform={platform} places={view.places} />
                ) : (
                  <RowsSkeleton rows={4} />
                )}
              </Card>
            </div>
            {view ? (
              <PlatformMembers
                view={view}
                day={day}
                retryDay={retryDay}
                onClearDay={() => setPicked(null)}
                members={members.state.status === 'ready' ? members.state.data.members : []}
              />
            ) : (
              <Card title={t('platform.members.title')}>
                <RowsSkeleton rows={5} />
              </Card>
            )}
          </>
        )}
      </DayData>
      {children}
    </>
  );
}

/**
 * What arrives, read every 10 seconds while the page is open (every 3 during the connection
 * test), and at once when the creator comes back to it: the server reads Discord's channels
 * first (2.5 seconds at most); Telegram sends its messages itself. A new message there brings
 * the dashboard up to date.
 */
export function useLiveNews(
  api: string,
  platform: AccountPlatform,
  testing: boolean,
  onNews: () => void,
): { lastAt: string | null } {
  const { state, reload } = useApi<PlatformActivityView>(`${api}/platform-activity/refresh`, {
    method: 'POST',
  });
  usePolling(reload, testing ? TEST_REFRESH_MS : LIVE_REFRESH_MS);
  useReloadOnReturn(reload);
  const tile =
    state.status === 'ready' ? state.data.platforms.find((p) => p.platform === platform) : null;
  const mark = tile ? `${tile.messages}:${tile.lastAt ?? ''}` : null;
  const news = useRef(onNews);
  useEffect(() => {
    news.current = onNews;
  });
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (mark === null) return;
    if (seen.current !== null && seen.current !== mark) news.current();
    seen.current = mark;
  }, [mark]);
  return { lastAt: tile?.lastAt ?? null };
}

/** The 30 days' chart: a click on a day picks it. */
function DailyChart({
  view,
  picked,
  onPick,
}: {
  view: PlatformDashboard;
  picked: string | null;
  onPick: (day: string | null) => void;
}) {
  const { t, locale, number } = useI18n();
  // A calendar day of the community's zone: read at noon in UTC, it is the same day everywhere.
  const long = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const short = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const at = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`));
  const days = view.daily.map((d) => ({
    label: long.format(at(d.day)),
    tick: short.format(at(d.day)),
    messages: d.messages,
    members: d.members,
    atRisk: d.atRisk,
  }));
  const index = picked === null ? -1 : view.daily.findIndex((d) => d.day === picked);
  return (
    <MessagesChart
      label={t('platform.chart.title')}
      summary={t('platform.chart.summary', {
        total: number(view.hero.messages30d),
        atRisk: number(view.daily.reduce((n, d) => n + d.atRisk, 0)),
      })}
      days={days}
      picked={index >= 0 ? index : null}
      onPick={(i) => onPick(i === null ? null : (view.daily[i]?.day ?? null))}
      labels={{
        all: t('platform.chart.all'),
        members: t('platform.chart.members'),
        atRisk: t('platform.chart.atRisk'),
      }}
    />
  );
}

/** When the community writes; a cell picked lists who wrote then. */
function HeatBlock({
  platform,
  path,
  view,
}: {
  platform: ActivityPlatform;
  path: string;
  view: PlatformDashboard;
}) {
  const { t, locale, number, plural } = useI18n();
  const [slot, setSlot] = useState<{ dow: number; hour: number } | null>(null);
  // 5 January 2026 was a Monday: its week names the days.
  const day = (dow: number, style: 'short' | 'long') =>
    new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 4 + dow, 12)),
    );
  const days = Array.from({ length: 7 }, (_, i) => ({
    short: day(i + 1, 'short'),
    full: day(i + 1, 'long'),
  }));
  const hour = (h: number) =>
    new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 5, h)),
    );
  const busiest = [...view.heatmap].sort((a, b) => b.messages - a.messages)[0];
  return (
    <div className="space-y-4">
      {view.heatmap.length === 0 ? (
        <p className="text-sm text-muted">{t('platform.heat.empty')}</p>
      ) : null}
      <Heatmap
        label={t('platform.heat.title')}
        summary={
          busiest
            ? t('platform.heat.summary', {
                day: days[busiest.dow - 1]?.full ?? '',
                hour: hour(busiest.hour),
                count: number(busiest.messages),
              })
            : t('platform.heat.empty')
        }
        slots={view.heatmap}
        days={days}
        hours={hour}
        picked={slot}
        onPick={setSlot}
        describe={(cell) =>
          `${plural('activity.messages', cell.messages)} · ${plural('platform.members', cell.members)}`
        }
        legend={{ fewer: t('platform.heat.fewer'), more: t('platform.heat.more') }}
      />
      {slot ? (
        <SlotMembers
          key={`${slot.dow}:${slot.hour}`}
          platform={platform}
          path={`${path}/slots/${slot.dow}/${slot.hour}`}
          title={t('platform.slot.title', {
            day: days[slot.dow - 1]?.full ?? '',
            from: hour(slot.hour),
            to: hour((slot.hour + 1) % 24),
          })}
          onClose={() => setSlot(null)}
        />
      ) : (
        <p className="text-xs text-subtle">{t('platform.heat.pick')}</p>
      )}
    </div>
  );
}

/** A day picked on the chart: its figures, read once; none picked, nothing read. */
function DayData({
  path,
  day,
  children,
}: {
  path: string;
  day: string | null;
  children: (day: Loadable<PlatformDayView> | null, retry: () => void) => ReactNode;
}) {
  if (day === null) return <>{children(null, () => {})}</>;
  return <PickedDay key={day} path={`${path}/days/${day}`} render={children} />;
}

function PickedDay({
  path,
  render,
}: {
  path: string;
  render: (day: Loadable<PlatformDayView>, retry: () => void) => ReactNode;
}) {
  const { state, retry } = useApi<PlatformDayView>(path);
  return <>{render(state, retry)}</>;
}
