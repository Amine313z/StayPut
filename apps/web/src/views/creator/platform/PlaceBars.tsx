import type { AccountPlatform, PlatformPlace } from '@stayput/core';
import { Hash, MessagesSquare } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { ease, STAGGER } from '../../../motion';
import { Segmented } from '../../../ui/Segmented';

type Sort = 'messages' | 'members' | 'name';

/**
 * Where members write (brief v4 §9.6): a horizontal bar for each Discord channel, each Telegram
 * group and topic, its messages over the period, its members beside them; sorted by messages,
 * members or name. Pointing at a row or focusing it shows its three most active members (on a
 * touch screen, always). A followed channel nobody wrote in shows its empty track: a channel to
 * revive, or to stop reading.
 */
export function PlaceBars({
  platform,
  places,
}: {
  platform: AccountPlatform;
  places: readonly PlatformPlace[];
}) {
  const { t, plural, number, locale } = useI18n();
  const reduce = useReducedMotion();
  const [sort, setSort] = useState<Sort>('messages');
  if (places.length === 0) {
    return (
      <p className="text-sm text-muted">
        {t(
          platform === 'discord' ? 'platform.places.none.discord' : 'platform.places.none.telegram',
        )}
      </p>
    );
  }
  // A server's name, or a group's title before its topics, only when there are several.
  const groupOf = (place: PlatformPlace) =>
    place.kind === 'topic' ? place.parent : place.kind === 'channel' ? place.parent : place.name;
  const several = new Set(places.map((p) => groupOf(p) ?? '')).size > 1;
  const nameOf = (place: PlatformPlace) =>
    place.kind === 'channel'
      ? place.name
        ? `#${place.name}`
        : t('platform.places.unnamed.channel')
      : place.kind === 'general'
        ? t('platform.places.general')
        : place.kind === 'topic'
          ? (place.name ?? t('platform.places.unnamed.topic'))
          : (place.name ?? t('telegram.unnamed'));
  const parentOf = (place: PlatformPlace) =>
    several && place.kind !== 'group' ? groupOf(place) : null;
  const collator = new Intl.Collator(locale);
  const sorted = [...places].sort((a, b) =>
    sort === 'name'
      ? collator.compare(`${parentOf(a) ?? ''} ${nameOf(a)}`, `${parentOf(b) ?? ''} ${nameOf(b)}`)
      : sort === 'members'
        ? b.members - a.members || b.messages - a.messages
        : b.messages - a.messages || b.members - a.members,
  );
  const max = Math.max(1, ...places.map((p) => p.messages));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${platform}-sort`} className="text-xs text-subtle">
          {t('platform.places.sort')}
        </span>
        <Segmented
          labelledBy={`${platform}-sort`}
          value={sort}
          onChange={setSort}
          options={[
            { value: 'messages', label: t('platform.places.sort.messages') },
            { value: 'members', label: t('platform.places.sort.members') },
            { value: 'name', label: t('platform.places.sort.name') },
          ]}
        />
      </div>
      <ul className="space-y-1" data-places={sort}>
        {sorted.map((place, index) => {
          const parent = parentOf(place);
          const Icon = place.kind === 'channel' ? Hash : MessagesSquare;
          return (
            <li
              key={place.id}
              data-place={place.id}
              data-kind={place.kind}
              className="group relative rounded-lg px-2 py-2 transition-colors duration-150 ease-brand focus-within:bg-surface-2 hover:bg-surface-2"
            >
              <div
                tabIndex={0}
                aria-describedby={`${platform}-top-${index}`}
                className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Icon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 self-center text-subtle"
                    />
                    {parent ? (
                      <span className="max-w-[40%] shrink-0 truncate text-subtle">{parent} ›</span>
                    ) : null}
                    <span className="truncate text-fg">{nameOf(place)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    <span className="num text-sm text-fg">{number(place.messages)}</span>
                    <span className="ms-2">{plural('platform.members', place.members)}</span>
                  </span>
                </div>
                <div className="relative mt-1.5 h-1.5 rounded-full bg-surface-3">
                  {place.messages > 0 ? (
                    <motion.span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 origin-left rounded-full bg-turq-300/70 transition-colors duration-150 group-focus-within:bg-turq-300 group-hover:bg-turq-300"
                      style={{ width: `${(place.messages / max) * 100}%` }}
                      initial={{ scaleX: reduce ? 1 : 0 }}
                      animate={{ scaleX: 1 }}
                      transition={
                        reduce ? { duration: 0 } : ease('standard', 0.05 + index * STAGGER)
                      }
                    />
                  ) : null}
                </div>
              </div>
              <div
                id={`${platform}-top-${index}`}
                className="mt-2 hidden text-xs text-muted group-focus-within:block group-hover:block pointer-coarse:block"
              >
                {place.messages === 0 ? (
                  t('platform.places.empty')
                ) : place.top.length === 0 ? (
                  t('platform.places.noMember')
                ) : (
                  <>
                    <span className="text-subtle">{t('platform.places.top')} </span>
                    {place.top.map((m, i) => (
                      <span key={m.id} data-top-member={m.id}>
                        {i > 0 ? ' · ' : ''}
                        <span className="text-fg">{m.name ?? t('members.unnamed')}</span>{' '}
                        <span className="num">{number(m.messages)}</span>
                      </span>
                    ))}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
