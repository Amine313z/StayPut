import type { AccountPlatform, IntegrationsStatus, PlatformDashboard } from '@stayput/core';
import type { MessageKey, PluralKey } from '@stayput/i18n';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useDemo } from '../../../demoMode';
import { useI18n } from '../../../i18n';
import { ExternalButton } from '../../../ui/ExternalLink';
import { MetricHero, SecondaryMetric } from '../../../ui/Metric';
import { MetricSkeleton } from '../../../ui/Skeleton';

export interface Connection {
  state: 'live' | 'reading' | 'problem' | 'off';
  /** What to do about a problem, in a sentence; null when there is none. */
  problem: { key: MessageKey } | { plural: PluralKey; count: number } | null;
  /** The last moment StayPut read the platform: Discord's channels, Telegram's last message. */
  lastAt: string | null;
}

/**
 * Where a platform's connection stands, from the integrations' status: live while the bot reads
 * (a turquoise pulse), reading Discord's history at first, or a problem to fix (a channel the bot
 * cannot read, none followed, the bot removed from the group, Telegram's privacy mode on).
 */
export function connectionOf(
  platform: AccountPlatform,
  status: IntegrationsStatus,
  lastMessageAt: string | null,
): Connection {
  const latest = (dates: readonly (string | null)[]) =>
    dates
      .filter((d): d is string => d !== null)
      .sort()
      .at(-1) ?? null;
  if (platform === 'discord') {
    const channels = status.discord.servers.flatMap((s) => s.channels);
    const refused = channels.filter((c) => /^403\b/.test(c.error ?? '')).length;
    const lastAt = latest(channels.map((c) => c.lastReadAt));
    if (!status.discord.available) {
      return { state: 'off', problem: { key: 'discord.unavailable' }, lastAt };
    }
    if (channels.length === 0) {
      return { state: 'problem', problem: { key: 'platform.problem.noChannel' }, lastAt };
    }
    if (refused > 0) {
      return {
        state: 'problem',
        problem: { plural: 'platform.problem.refused', count: refused },
        lastAt,
      };
    }
    const reading = channels.some((c) => !c.backfillDone && !c.error);
    return { state: reading ? 'reading' : 'live', problem: null, lastAt };
  }
  const groups = status.telegram.groups;
  const lastAt = latest([lastMessageAt, ...groups.map((g) => g.lastMessageAt)]);
  if (!status.telegram.available) {
    return { state: 'off', problem: { key: 'telegram.unavailable' }, lastAt };
  }
  if (!groups.some((g) => g.active)) {
    return { state: 'problem', problem: { key: 'platform.problem.removed' }, lastAt };
  }
  if (status.telegram.addToGroup && !status.telegram.readsAllMessages) {
    return { state: 'problem', problem: { key: 'telegram.privacyMode' }, lastAt };
  }
  return { state: 'live', problem: null, lastAt };
}

const STATE_LABELS: Readonly<Record<Connection['state'], MessageKey>> = {
  live: 'platform.status.live',
  reading: 'platform.status.reading',
  problem: 'platform.status.problem',
  off: 'platform.status.off',
};

/**
 * The top of Integrations › Discord or › Telegram (brief v4 §9.6): the connection (a turquoise
 * pulse while live, when StayPut last read the platform, « Reconnect ») and three figures:
 * members active these 7 days, members gone silent, messages over 30 days.
 */
export function PlatformHero({
  platform,
  status,
  hero,
  lastMessageAt,
}: {
  platform: AccountPlatform;
  status: IntegrationsStatus;
  /** The three figures; being read; or none (the reading failed: the page says so below). */
  hero: PlatformDashboard['hero'] | 'loading' | null;
  lastMessageAt: string | null;
}) {
  const { t, plural, number, relative } = useI18n();
  const demo = useDemo();
  const discord = platform === 'discord';
  const name = t(discord ? 'sources.discord.name' : 'sources.telegram.name');
  const connection = connectionOf(platform, status, lastMessageAt);
  const link = discord ? status.discord.install : status.telegram.addToGroup;
  const when = connection.lastAt
    ? t(discord ? 'platform.since.discord' : 'platform.since.telegram', {
        when: relative(new Date(connection.lastAt)),
      })
    : t('platform.since.never');
  return (
    <section
      aria-label={name}
      data-hero="platform"
      data-connection={connection.state}
      className="relative isolate overflow-hidden rounded-xl border border-line bg-surface/60 p-5 shadow-card"
    >
      <span aria-hidden="true" className="hero-glow -z-10" style={{ left: -300, top: -420 }} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Pulse state={connection.state} />
          <span className="font-medium text-fg">{t(STATE_LABELS[connection.state])}</span>
          <span aria-hidden="true" className="text-subtle">
            ·
          </span>
          <span className="text-subtle">{when}</span>
        </p>
        {demo || link ? (
          <ExternalButton
            href={link?.url ?? null}
            whopAppId={status.whopAppId}
            variant={connection.state === 'problem' ? 'primary' : 'secondary'}
            size="sm"
            icon={<RefreshCw aria-hidden="true" className="size-4" />}
            tour={discord ? 'connect-discord' : undefined}
          >
            {t('platform.reconnect')}
          </ExternalButton>
        ) : null}
      </div>
      {connection.problem ? (
        <p role="status" className="mt-2 max-w-prose text-sm text-muted">
          {'plural' in connection.problem
            ? plural(connection.problem.plural, connection.problem.count)
            : t(connection.problem.key)}
        </p>
      ) : null}
      {hero === null ? null : (
        <div className="mt-6 grid gap-6 sm:grid-cols-3">
          {hero !== 'loading' ? (
            <>
              <MetricHero
                label={t('platform.hero.active')}
                tip={t('platform.hero.active.tip', { platform: name })}
                value={hero.activeMembers7d}
                format={(n) => number(n)}
                better="up"
              />
              <SecondaryMetric
                label={t('platform.hero.silent')}
                tip={t('platform.hero.silent.tip', { platform: name })}
                value={hero.silentMembers7d}
                format={(n) => number(n)}
                better="down"
                className="sm:self-end"
              />
              <SecondaryMetric
                label={t('platform.hero.messages')}
                tip={t('platform.hero.messages.tip', {
                  members: number(hero.memberMessages30d),
                })}
                value={hero.messages30d}
                format={(n) => number(n)}
                better="up"
                className="sm:self-end"
              />
            </>
          ) : (
            <>
              <MetricSkeleton hero />
              <MetricSkeleton />
              <MetricSkeleton />
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Live: a turquoise dot that pulses; reading: a turning circle; else a still white dot. */
function Pulse({ state }: { state: Connection['state'] }) {
  if (state === 'reading') {
    return <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-turq-300" />;
  }
  return (
    <span aria-hidden="true" data-pulse={state} className="relative flex size-2.5">
      {state === 'live' ? (
        <span className="absolute inset-0 rounded-full bg-turq-300 opacity-60 motion-safe:animate-ping" />
      ) : null}
      <span
        className={`relative size-2.5 rounded-full ${state === 'live' ? 'bg-turq-300' : 'bg-white-500'}`}
      />
    </span>
  );
}
