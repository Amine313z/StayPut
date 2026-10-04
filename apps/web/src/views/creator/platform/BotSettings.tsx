import type { AccountPlatform, IntegrationsStatus, PeopleView } from '@stayput/core';
import type { MessageKey, PluralKey } from '@stayput/i18n';
import { CircleCheck, CircleDashed, CircleX, PlugZap, Radio } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../../api';
import { DiscordCard } from '../../../components/DiscordCard';
import { TelegramCard } from '../../../components/TelegramCard';
import { useDemo } from '../../../demoMode';
import { useI18n } from '../../../i18n';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { useCreatorData } from '../../CreatorView';

/** A connection test waits this long for a message. */
export const TEST_WAIT_MS = 120_000;
/** In the demo, nothing is written: the message is simulated after this long. */
export const DEMO_TEST_MS = 2_500;

interface Check {
  id: string;
  state: 'ok' | 'pending' | 'problem';
  text: { key: MessageKey; params?: Record<string, string> } | { plural: PluralKey; count: number };
}

/**
 * The bot's settings (brief v4 §9.6): what it is allowed to see, checked (each line says what to
 * do when it is not); a test that shows a message arriving, written by the creator in a channel
 * or group StayPut reads (its author and time, never its text); then the servers or groups, their
 * channels, adding another and disconnecting (DiscordCard, TelegramCard).
 */
export function BotSettings({
  platform,
  status,
  lastMessageAt,
  onTesting,
}: {
  platform: AccountPlatform;
  status: IntegrationsStatus;
  lastMessageAt: string | null;
  /** The test is listening: the page reads what arrives every 3 seconds meanwhile. */
  onTesting: (testing: boolean) => void;
}) {
  const { t, plural } = useI18n();
  const { api, integrations } = useCreatorData();
  const people = useApi<PeopleView>(`${api}/people`);
  const checks =
    platform === 'discord' ? discordChecks(status, people.state) : telegramChecks(status);
  return (
    <section aria-labelledby={`${platform}-bot`} className="space-y-4">
      <h2 id={`${platform}-bot`} className="title-section">
        {t('bot.title')}
      </h2>
      <Card
        icon={<PlugZap aria-hidden="true" className="size-4" />}
        title={t('bot.checks')}
        description={t(platform === 'discord' ? 'bot.checks.discord' : 'bot.checks.telegram')}
      >
        <ul className="space-y-2.5" data-checks={platform}>
          {checks.map((check) => {
            const Icon =
              check.state === 'ok'
                ? CircleCheck
                : check.state === 'pending'
                  ? CircleDashed
                  : CircleX;
            return (
              <li
                key={check.id}
                data-check={check.id}
                data-state={check.state}
                className="flex gap-2.5 text-sm"
              >
                <Icon
                  aria-hidden="true"
                  className={`mt-0.5 size-4 shrink-0 ${
                    check.state === 'ok' ? 'text-turq-300' : 'text-subtle'
                  }`}
                />
                <span className={check.state === 'problem' ? 'text-fg' : 'text-muted'}>
                  <span className="sr-only">{t(`bot.check.state.${check.state}`)} </span>
                  {'plural' in check.text
                    ? plural(check.text.plural, check.text.count)
                    : t(check.text.key, check.text.params)}
                </span>
              </li>
            );
          })}
        </ul>
        <ConnectionTest platform={platform} lastMessageAt={lastMessageAt} onTesting={onTesting} />
      </Card>
      {platform === 'discord' ? (
        <DiscordCard
          status={status.discord}
          whopAppId={status.whopAppId}
          api={api}
          onChange={integrations.reload}
          tour={null}
        />
      ) : (
        <TelegramCard
          status={status.telegram}
          whopAppId={status.whopAppId}
          api={api}
          onChange={integrations.reload}
        />
      )}
    </section>
  );
}

function discordChecks(
  status: IntegrationsStatus,
  people: ReturnType<typeof useApi<PeopleView>>['state'],
): Check[] {
  const channels = status.discord.servers.flatMap((s) => s.channels);
  const refused = channels.filter((c) => /^403\b/.test(c.error ?? '')).length;
  const reading = channels.filter((c) => !c.error).length;
  const checks: Check[] = [
    status.discord.available
      ? { id: 'bot', state: 'ok', text: { key: 'bot.check.bot' } }
      : { id: 'bot', state: 'problem', text: { key: 'discord.unavailable' } },
    channels.length === 0
      ? { id: 'channels', state: 'problem', text: { key: 'platform.problem.noChannel' } }
      : { id: 'channels', state: 'ok', text: { plural: 'bot.check.channels', count: reading } },
  ];
  if (refused > 0) {
    checks.push({
      id: 'refused',
      state: 'problem',
      text: { plural: 'platform.problem.refused', count: refused },
    });
  }
  const lists =
    people.status === 'ready'
      ? people.data.places.filter((p) => p.platform === 'discord').map((p) => p.list)
      : [];
  checks.push(
    lists.includes('blocked')
      ? { id: 'members', state: 'problem', text: { key: 'bot.check.members.blocked' } }
      : lists.length > 0 && lists.every((l) => l === 'listed')
        ? { id: 'members', state: 'ok', text: { key: 'bot.check.members.listed' } }
        : { id: 'members', state: 'pending', text: { key: 'bot.check.members.pending' } },
  );
  return checks;
}

function telegramChecks(status: IntegrationsStatus): Check[] {
  const groups = status.telegram.groups;
  const active = groups.filter((g) => g.active);
  const removed = groups.filter((g) => !g.active);
  const checks: Check[] = [
    status.telegram.available
      ? { id: 'bot', state: 'ok', text: { key: 'bot.check.bot' } }
      : { id: 'bot', state: 'problem', text: { key: 'telegram.unavailable' } },
    status.telegram.readsAllMessages
      ? { id: 'privacy', state: 'ok', text: { key: 'bot.check.privacy' } }
      : { id: 'privacy', state: 'problem', text: { key: 'telegram.privacyMode' } },
    { id: 'groups', state: 'ok', text: { plural: 'bot.check.groups', count: active.length } },
    { id: 'joins', state: 'ok', text: { key: 'bot.check.joins' } },
  ];
  for (const group of removed) {
    checks.push({
      id: `removed-${group.chatId}`,
      state: 'problem',
      text: {
        key: 'bot.check.removed',
        params: { group: group.title ?? '' },
      },
    });
  }
  return checks;
}

/**
 * « Test the connection »: the creator writes a message in a channel or group StayPut reads, and
 * sees it arrive within seconds (the page reads what arrives every 3 seconds meanwhile), or is
 * told after 2 minutes what to check. Only its time is shown, never its text. In the demo nothing
 * is written: the message is simulated, and said so.
 */
function ConnectionTest({
  platform,
  lastMessageAt,
  onTesting,
}: {
  platform: AccountPlatform;
  lastMessageAt: string | null;
  onTesting: (testing: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const demo = useDemo();
  const [since, setSince] = useState<number | null>(null);
  const [timedOutAt, setTimedOutAt] = useState<number | null>(null);
  // A message after the test began (Discord's clock may be a few seconds off).
  const received =
    since !== null && lastMessageAt !== null && Date.parse(lastMessageAt) >= since - 5_000
      ? lastMessageAt
      : null;
  const outcome: { at: string; simulated: boolean } | 'none' | null = received
    ? { at: received, simulated: false }
    : timedOutAt === null
      ? null
      : demo
        ? { at: new Date(timedOutAt).toISOString(), simulated: true }
        : 'none';
  const listening = since !== null && outcome === null;
  const notify = useRef(onTesting);
  useEffect(() => {
    notify.current = onTesting;
  });
  useEffect(() => {
    notify.current(listening);
  }, [listening]);
  useEffect(() => () => notify.current(false), []);
  useEffect(() => {
    if (!listening) return;
    const timer = window.setTimeout(
      () => setTimedOutAt(Date.now()),
      demo ? DEMO_TEST_MS : TEST_WAIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [listening, demo]);
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  return (
    <div
      className="mt-6 border-t border-line pt-5"
      data-test={
        listening
          ? 'listening'
          : outcome === null
            ? 'idle'
            : outcome === 'none'
              ? 'none'
              : 'received'
      }
    >
      <p className="text-sm font-medium text-fg">{t('bot.test.title')}</p>
      <p className="mt-1 max-w-prose text-sm text-muted">
        {t(
          platform === 'discord' ? 'bot.test.description.discord' : 'bot.test.description.telegram',
        )}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          icon={<Radio aria-hidden="true" className="size-4" />}
          disabled={listening}
          onClick={() => {
            setTimedOutAt(null);
            setSince(Date.now());
          }}
        >
          {t(since === null ? 'bot.test.start' : 'bot.test.again')}
        </Button>
        <p role="status" className="flex items-center gap-2 text-sm">
          {listening ? (
            <>
              <span aria-hidden="true" className="relative flex size-2.5">
                <span className="absolute inset-0 rounded-full bg-turq-300 opacity-60 motion-safe:animate-ping" />
                <span className="relative size-2.5 rounded-full bg-turq-300" />
              </span>
              <span className="text-muted">{t('bot.test.waiting')}</span>
            </>
          ) : outcome === 'none' ? (
            <span className="text-muted">{t('bot.test.none')}</span>
          ) : outcome ? (
            <span className="text-fg">
              {t(outcome.simulated ? 'bot.test.simulated' : 'bot.test.received', {
                time: clock.format(new Date(outcome.at)),
              })}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
