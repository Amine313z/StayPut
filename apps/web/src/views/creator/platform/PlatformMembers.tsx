import type {
  ActivityPlatform,
  ActivityWindow,
  MemberRow,
  PlatformDashboard,
  PlatformDayView,
  PlatformMember,
  PlatformSlotView,
} from '@stayput/core';
import { UsersRound, X } from 'lucide-react';
import { useState } from 'react';
import { useApi, type Loadable } from '../../../api';
import { LEVELS } from '../../../components/Risk';
import { MemberActions } from '../../../components/MemberActions';
import { MemberListRow } from '../../../components/MemberListRow';
import { useI18n } from '../../../i18n';
import { Card } from '../../../ui/Card';
import { RiskRing } from '../../../ui/RiskRing';
import { Segmented } from '../../../ui/Segmented';
import { useCreatorData } from '../../CreatorView';
import { PickedChip, Resolved } from './parts';

const WINDOWS: readonly ActivityWindow[] = ['d7', 'd14', 'd30'];

/**
 * The most active members there and the members gone silent (brief v4 §9.6), over 7, 14 or 30
 * days: each with their risk ring, their messages or their last one, and, pointed at, what the
 * creator can do (write to them, offer a pause or a discount) as everywhere else. A day picked on
 * the chart shows who wrote that day.
 */
export function PlatformMembers({
  view,
  day,
  retryDay,
  onClearDay,
  members,
}: {
  view: PlatformDashboard;
  day: Loadable<PlatformDayView> | null;
  retryDay: () => void;
  onClearDay: () => void;
  /** The members as the Members page has them: their actions need their membership. */
  members: readonly MemberRow[];
}) {
  const { t, plural, number } = useI18n();
  const [window, setWindow] = useState<ActivityWindow>('d7');
  const silent = view.silent[window];
  return (
    <Card
      icon={<UsersRound aria-hidden="true" className="size-4" />}
      title={t('platform.members.title')}
      actions={
        <Segmented
          label={t('platform.window')}
          value={window}
          onChange={setWindow}
          options={WINDOWS.map((w) => ({ value: w, label: t(`platform.window.${w}`) }))}
        />
      }
    >
      <div className="grid min-w-0 gap-8 lg:grid-cols-2">
        <section aria-labelledby="platform-active" className="min-w-0" data-list="active">
          <h3 id="platform-active" className="text-sm font-semibold text-fg">
            {t('platform.active.title')}
          </h3>
          {day ? (
            <>
              <div className="mt-1">
                <PickedChip day={day} onClear={onClearDay} />
              </div>
              <Resolved state={day} retry={retryDay}>
                {(data) => (
                  <MemberList
                    people={data.active}
                    members={members}
                    line={(m) => plural('activity.messages', m.messages)}
                    empty={t('platform.active.emptyDay')}
                  />
                )}
              </Resolved>
            </>
          ) : (
            <MemberList
              people={view.active[window]}
              members={members}
              line={(m) => plural('activity.messages', m.messages)}
              empty={t('platform.active.empty')}
            />
          )}
        </section>
        <section aria-labelledby="platform-silent" className="min-w-0" data-list="silent">
          <h3
            id="platform-silent"
            className="flex items-baseline gap-2 text-sm font-semibold text-fg"
          >
            {t('platform.silent.title')}
            <span className="num text-xs font-normal text-subtle">{number(silent.total)}</span>
          </h3>
          <MemberList
            people={silent.members}
            members={members}
            line={(m) => t('platform.silent.since', { when: relativeDay(m.lastAt) })}
            empty={t('platform.silent.empty')}
          />
          {silent.total > silent.members.length ? (
            <p className="mt-2 text-xs text-subtle">
              {plural('platform.silent.more', silent.total - silent.members.length)}
            </p>
          ) : null}
        </section>
      </div>
    </Card>
  );

  /** « 12 days ago », by the community's days. */
  function relativeDay(iso: string): string {
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
    return plural('platform.daysAgo', days);
  }
}

/** A list of members: each row opens their drawer; their actions show when pointed at. */
function MemberList({
  people,
  members,
  line,
  empty,
}: {
  people: readonly PlatformMember[];
  members: readonly MemberRow[];
  line: (member: PlatformMember) => string;
  empty: string;
}) {
  const { t, number } = useI18n();
  const { api, root, testMode, members: list } = useCreatorData();
  if (people.length === 0) return <p className="mt-3 text-sm text-muted">{empty}</p>;
  return (
    <div className="@container/list mt-2 min-w-0 divide-y divide-line">
      {people.map((person, index) => {
        const row = members.find((m) => m.id === person.id) ?? null;
        const level = person.level;
        return (
          <div key={person.id} data-member={person.id}>
            <MemberListRow
              name={person.name ?? t('members.unnamed')}
              href={`${root}/members?member=${encodeURIComponent(person.id)}`}
              reason={line(person)}
              risk={
                person.score !== null && level
                  ? {
                      score: person.score,
                      label:
                        level === 'scheduled_departure'
                          ? t(LEVELS[level].label)
                          : t('risk.badge', {
                              level: t(LEVELS[level].label),
                              score: number(person.score),
                            }),
                    }
                  : null
              }
              when={null}
              paid={null}
              actions={
                row ? (
                  <MemberActions
                    member={row}
                    api={api}
                    testMode={testMode.on}
                    compact
                    onDone={list.reload}
                  />
                ) : null
              }
              delay={index * 0.04}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Who wrote in a cell of the heatmap: the members, the most first, and the others' messages. */
export function SlotMembers({
  platform,
  path,
  title,
  onClose,
}: {
  platform: ActivityPlatform;
  path: string;
  title: string;
  onClose: () => void;
}) {
  const { t, plural, number } = useI18n();
  const { state, retry } = useApi<PlatformSlotView>(path);
  return (
    <div className="rounded-xl bg-surface-2 p-4" data-slot={path.split('/slots/')[1]}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-fg">{title}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('platform.slot.close')}
          className="-m-1 rounded-md p-1 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="mt-3">
        <Resolved state={state} retry={retry}>
          {(slot) =>
            slot.members.length === 0 ? (
              <p className="text-sm text-muted">
                {t(platform === 'whop' ? 'platform.slot.empty.whop' : 'platform.slot.empty')}
              </p>
            ) : (
              <>
                <ul className="flex flex-wrap gap-x-5 gap-y-3">
                  {slot.members.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 text-sm">
                      {m.score !== null && m.level ? (
                        <RiskRing score={m.score} label={t(LEVELS[m.level].label)} size={28} />
                      ) : null}
                      <span className="text-fg">{m.name ?? t('members.unnamed')}</span>
                      <span className="num text-xs text-subtle">{number(m.messages)}</span>
                    </li>
                  ))}
                </ul>
                {slot.others > 0 ? (
                  <p className="mt-3 text-xs text-subtle">
                    {plural(
                      platform === 'whop' ? 'platform.slot.others.whop' : 'platform.slot.others',
                      slot.others,
                    )}
                  </p>
                ) : null}
              </>
            )
          }
        </Resolved>
      </div>
    </div>
  );
}
