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

/** While the Sources tab is open, the list is read again this often. */
export const PEOPLE_REFRESH_MS = 30_000;
/** People shown at first, then this many more at each « Show more ». */
const PAGE = 50;

const DISCORD_PORTAL = 'https://discord.com/developers/applications';

type Filter = 'all' | AccountPlatform;

const STATUS: Readonly<
  Record<Exclude<PlatformPerson['status'], 'member'>, { label: MessageKey; tone: Tone }>
> = {
  team: { label: 'people.status.team', tone: 'neutral' },
  guest: { label: 'people.status.guest', tone: 'neutral' },
  unlinked: { label: 'people.status.unlinked', tone: 'warning' },
};

/**
 * Everyone on the creator's Discord server and in their Telegram group, not only who writes (the
 * founder, 2026-10-01: « je veux qu'on puisse voir les membres »): who each person is for the
 * community, their messages over 30 days, when they joined or left. Discord gives the whole list
 * once the bot's application has the Server Members Intent on; Telegram gives none, so StayPut
 * knows who writes, who joins since the bot is there, and the administrators.
 */
export function PeopleCard({
  api,
  whopAppId,
  refreshKey = 0,
}: {
  api: string;
  whopAppId: string | null;
  /** Read again at once when it changes: new messages, or an account tied. */
  refreshKey?: number;
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
      title={t('people.title')}
      description={t('people.description')}
    >
      {state.status === 'loading' ? (
        <Loading />
      ) : state.status === 'error' ? (
        <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
      ) : (
        <People view={state.data} whopAppId={whopAppId} />
      )}
    </Card>
  );
}

function People({ view, whopAppId }: { view: PeopleView; whopAppId: string | null }) {
  const { t, number } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const counts: Record<Filter, number> = {
    all: view.people.length,
    discord: view.people.filter((p) => p.platform === 'discord').length,
    telegram: view.people.filter((p) => p.platform === 'telegram').length,
  };
  const wanted = fold(query.trim());
  const matching = view.people.filter(
    (p) =>
      (filter === 'all' || p.platform === filter) &&
      (!wanted ||
        fold([p.name, p.username, p.member?.name].filter(Boolean).join(' ')).includes(wanted)),
  );
  const filters: readonly { value: Filter; label: MessageKey }[] = [
    { value: 'all', label: 'people.all' },
    { value: 'discord', label: 'sources.discord.name' },
    { value: 'telegram', label: 'sources.telegram.name' },
  ];
  return (
    <div className="space-y-5">
      {view.places.length > 0 ? (
        <ul className="space-y-3">
          {view.places.map((place) => (
            <Place key={`${place.platform}:${place.id}`} place={place} whopAppId={whopAppId} />
          ))}
        </ul>
      ) : null}
      {view.people.length === 0 ? (
        <p className="text-sm text-muted">{t('people.empty')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              role="group"
              aria-label={t('people.filter')}
              className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1"
            >
              {filters.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => {
                    setFilter(f.value);
                    setShown(PAGE);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    filter === f.value
                      ? 'bg-surface text-fg shadow-card'
                      : 'text-muted hover:text-fg'
                  }`}
                >
                  {t(f.label)}
                  <span className="tabular ms-1.5 text-xs text-muted">
                    {number(counts[f.value])}
                  </span>
                </button>
              ))}
            </div>
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
          {view.total > view.people.length ? (
            <p className="text-sm text-muted">
              {t('people.truncated', {
                shown: number(view.people.length),
                total: number(view.total),
              })}
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
