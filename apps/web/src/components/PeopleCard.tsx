import type { AccountPlatform, PeoplePlace, PeopleView, PlatformPerson } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { Info, Search, TriangleAlert, UsersRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApi, usePolling } from '../api';
import { useI18n } from '../i18n';
import { fold } from '../text';
import { Avatar } from '../ui/Avatar';
import { Badge, Notice, type Tone } from '../ui/Badge';
import { DiscordIcon, TelegramIcon } from '../ui/BrandIcons';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';
import { ErrorPanel, Loading } from './Status';

/** While the platform's tab is open, the list is read again this often. */
export const PEOPLE_REFRESH_MS = 30_000;
/** People shown at first, then this many more at each « Show more »: one block among many. */
const PAGE = 8;

const DISCORD_PORTAL = 'https://discord.com/developers/applications';

const STATUS: Readonly<
  Record<Exclude<PlatformPerson['status'], 'member'>, { label: MessageKey; tone: Tone }>
> = {
  team: { label: 'people.status.team', tone: 'neutral' },
  guest: { label: 'people.status.guest', tone: 'neutral' },
  unlinked: { label: 'people.status.unlinked', tone: 'warning' },
};

/**
 * Everyone on the creator's Discord server, or in their Telegram group, not only who writes (the
 * founder, 2026-10-01: « je veux qu'on puisse voir les membres »), in the platform's tab: who each
 * person is for the community, their messages over 30 days, when they joined or left. Discord
 * gives the whole list once the bot's application has the Server Members Intent on; Telegram gives
 * none, so StayPut knows who writes, who joins since the bot is there, and the administrators.
 */
export function PeopleCard({
  api,
  whopAppId,
  refreshKey = 0,
  platform,
}: {
  api: string;
  whopAppId: string | null;
  /** Read again at once when it changes: new messages, or an account tied. */
  refreshKey?: number;
  platform: AccountPlatform;
}) {
  const { t } = useI18n();
  const { state, retry, reload } = useApi<PeopleView>(`${api}/people`);
  usePolling(reload, PEOPLE_REFRESH_MS);
  const latestReload = useRef(reload);
  useEffect(() => {
    latestReload.current = reload;
  });
  useEffect(() => {
    if (refreshKey > 0) latestReload.current();
  }, [refreshKey]);
  return (
    <Card
      icon={<UsersRound aria-hidden="true" className="size-4" />}
      title={t(platform === 'discord' ? 'people.title.discord' : 'people.title.telegram')}
      description={t(
        platform === 'discord' ? 'people.description.discord' : 'people.description.telegram',
      )}
    >
      {state.status === 'loading' ? (
        <Loading />
      ) : state.status === 'error' ? (
        <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
      ) : (
        <People
          places={state.data.places.filter((p) => p.platform === platform)}
          people={state.data.people.filter((p) => p.platform === platform)}
          total={state.data.totals[platform]}
          whopAppId={whopAppId}
        />
      )}
    </Card>
  );
}

function People({
  places,
  people,
  total,
  whopAppId,
}: {
  places: readonly PeoplePlace[];
  /** The latest to write first, 500 at most. */
  people: readonly PlatformPerson[];
  /** How many people StayPut knows there in all. */
  total: number;
  whopAppId: string | null;
}) {
  const { t, number } = useI18n();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const wanted = fold(query.trim());
  const matching = people.filter(
    (p) =>
      !wanted ||
      fold([p.name, p.username, p.member?.name].filter(Boolean).join(' ')).includes(wanted),
  );
  return (
    <div className="space-y-5">
      {places.length > 0 ? (
        <ul className="space-y-3">
          {places.map((place) => (
            <Place key={`${place.platform}:${place.id}`} place={place} whopAppId={whopAppId} />
          ))}
        </ul>
      ) : null}
      {people.length === 0 ? (
        <p className="text-sm text-muted">{t('people.empty')}</p>
      ) : (
        <>
          <div>
            <label className="relative block sm:w-64">
              <span className="sr-only">{t('people.search')}</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setShown(PAGE);
                }}
                placeholder={t('people.search')}
                className="w-full rounded-lg border border-line bg-surface py-2 ps-9 pe-3 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
            </label>
          </div>
          {matching.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t('people.noMatch')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {matching.slice(0, shown).map((person) => (
                <Person key={`${person.platform}:${person.accountId}`} person={person} />
              ))}
            </ul>
          )}
          {matching.length > shown ? (
            <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              {t('people.more', { count: number(matching.length - shown) })}
            </Button>
          ) : null}
          {total > people.length ? (
            <p className="text-sm text-muted">
              {t('people.truncated', { shown: number(people.length), total: number(total) })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A server or a group: how many people it has, and how StayPut knows them. */
function Place({ place, whopAppId }: { place: PeoplePlace; whopAppId: string | null }) {
  const { t, number } = useI18n();
  const discord = place.platform === 'discord';
  const Icon = discord ? DiscordIcon : TelegramIcon;
  const name = place.name ?? t(discord ? 'discord.unnamed' : 'telegram.unnamed');
  // Discord: the list read, else Discord's own count; Telegram: its count, and who StayPut knows.
  const discordCount = place.list === 'listed' ? place.known : place.total;
  const count = discord
    ? discordCount !== null
      ? t('people.discordMembers', { count: number(discordCount) })
      : null
    : place.total !== null
      ? t('people.telegramMembers', { count: number(place.total), known: number(place.known) })
      : t('people.telegramKnown', { known: number(place.known) });
  return (
    <li className="space-y-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Icon
          role="img"
          aria-label={t(discord ? 'sources.discord.name' : 'sources.telegram.name')}
          className={`size-4 shrink-0 ${discord ? 'text-discord' : 'text-telegram'}`}
        />
        <span className="font-medium">{name}</span>
        {count ? <span className="tabular text-muted">· {count}</span> : null}
        {discord && place.list === 'pending' ? (
          <span className="text-muted">· {t('people.discordPending')}</span>
        ) : null}
      </p>
      {discord && place.list === 'blocked' ? (
        <Notice tone="warning" icon={<TriangleAlert aria-hidden="true" className="size-4" />}>
          <p>{t('people.discordBlocked')}</p>
          <div className="mt-2">
            <ExternalButton
              href={DISCORD_PORTAL}
              whopAppId={whopAppId}
              variant="secondary"
              size="sm"
            >
              {t('people.discordPortal')}
            </ExternalButton>
          </div>
        </Notice>
      ) : null}
      {!discord ? (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t('people.telegramHint')}
        </p>
      ) : null}
    </li>
  );
}

/** One person: their name on the platform, who they are for the community, their activity. */
function Person({ person }: { person: PlatformPerson }) {
  const { t, plural, relative, date } = useI18n();
  const discord = person.platform === 'discord';
  const Icon = discord ? DiscordIcon : TelegramIcon;
  const status =
    person.status === 'member'
      ? {
          label: t('people.status.member', {
            name: person.member?.name ?? t('members.unnamed'),
          }),
          tone: 'accent' as Tone,
        }
      : { label: t(STATUS[person.status].label), tone: STATUS[person.status].tone };
  const facts = [
    person.messages > 0 ? plural('people.messages', person.messages) : t('people.noMessages'),
    person.lastMessageAt
      ? t('people.lastMessage', { when: relative(new Date(person.lastMessageAt)) })
      : null,
    person.here === false && person.leftAt
      ? t('people.left', { date: date(new Date(person.leftAt)) })
      : person.joinedAt
        ? t('people.joined', { date: date(new Date(person.joinedAt)) })
        : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <li className={`flex items-start gap-3 py-3 ${person.here === false ? 'opacity-60' : ''}`}>
      <Avatar name={person.name} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon
            role="img"
            aria-label={t(discord ? 'sources.discord.name' : 'sources.telegram.name')}
            className={`size-4 shrink-0 ${discord ? 'text-discord' : 'text-telegram'}`}
          />
          <span className="truncate font-medium">{person.name ?? t('accounts.unnamed')}</span>
          {person.username ? (
            <span className="truncate text-sm text-muted">@{person.username}</span>
          ) : null}
          <Badge tone={status.tone}>{status.label}</Badge>
        </p>
        <p className="mt-0.5 text-sm text-muted">{facts.join(' · ')}</p>
      </div>
    </li>
  );
}
