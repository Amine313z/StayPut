import type {
  AnnounceDestination,
  AnnouncePlatform,
  AnnouncementsUpdate,
  AnnouncementsView,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { CircleAlert, CircleCheck, Megaphone, Save } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { putJson, useApi } from '../../api';
import { FIELD } from '../../components/SettingsParts';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Notice } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useCreatorData } from '../CreatorView';

const GROUPS: readonly { platform: AnnouncePlatform; label: MessageKey }[] = [
  { platform: 'whop', label: 'announce.group.whop' },
  { platform: 'discord', label: 'announce.group.discord' },
  { platform: 'telegram', label: 'announce.group.telegram' },
];

const keyOf = (destination: AnnounceDestination | null) =>
  destination ? `${destination.platform}:${destination.id}` : '';

/** A place as the creator reads it: the channel, then where it is when it says more. */
function labelOf(destination: AnnounceDestination): string {
  const name = destination.name ?? destination.id;
  return destination.place && destination.platform === 'discord'
    ? `${name} · ${destination.place}`
    : name;
}

/**
 * Where the members' milestones are announced (SPEC Phase 5, point 4): one place among those
 * StayPut can post in now, or nowhere.
 */
export function Announcements() {
  const { api } = useCreatorData();
  const { state, retry } = useApi<AnnouncementsView>(`${api}/announcements`);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <AnnouncementsForm initial={state.data} />;
}

function AnnouncementsForm({ initial }: { initial: AnnouncementsView }) {
  const { api } = useCreatorData();
  const { t } = useI18n();
  const id = useId();
  const [view, setView] = useState(initial);
  const [choice, setChoice] = useState(keyOf(initial.destination));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  // The place chosen before stays offered, even when StayPut no longer sees it.
  const places =
    view.destination && !view.choices.some((d) => keyOf(d) === keyOf(view.destination))
      ? [view.destination, ...view.choices]
      : view.choices;
  const picked = places.find((d) => keyOf(d) === choice) ?? null;
  const changed = choice !== keyOf(view.destination);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setStatus('saving');
    try {
      const body: AnnouncementsUpdate = {
        destination: picked ? { platform: picked.platform, id: picked.id } : null,
      };
      const next = await putJson<AnnouncementsView>(`${api}/announcements`, body);
      setView(next);
      setChoice(keyOf(next.destination));
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <Card
      icon={<Megaphone aria-hidden="true" className="size-4" />}
      title={t('announce.title')}
      description={t('announce.body')}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-where`} className="text-sm font-medium">
            {t('announce.where')}
          </label>
          <select
            id={`${id}-where`}
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value);
              if (status !== 'saving') setStatus('idle');
            }}
            className={`${FIELD} w-full sm:w-96`}
          >
            <option value="">{t('announce.none')}</option>
            {GROUPS.map(({ platform, label }) => {
              const options = places.filter((d) => d.platform === platform);
              return options.length > 0 ? (
                <optgroup key={platform} label={t(label)}>
                  {options.map((destination) => (
                    <option key={keyOf(destination)} value={keyOf(destination)}>
                      {labelOf(destination)}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </div>
        {places.length === 0 ? <p className="text-sm text-muted">{t('announce.empty')}</p> : null}
        {view.whopUnavailable ? (
          <Notice tone="info">{t('announce.whopUnavailable')}</Notice>
        ) : picked?.platform === 'whop' ? (
          <Notice tone="info">{t('announce.whopPermission')}</Notice>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={status === 'saving'}
            disabled={!changed}
            icon={<Save aria-hidden="true" className="size-4" />}
          >
            {t('announce.save')}
          </Button>
          <p role="status" className="text-sm">
            {status === 'saved' ? (
              <span className="flex items-center gap-1.5 text-accent">
                <CircleCheck aria-hidden="true" className="size-4" />
                {t('announce.saved')}
              </span>
            ) : status === 'failed' ? (
              <span className="flex items-center gap-1.5 text-danger">
                <CircleAlert aria-hidden="true" className="size-4" />
                {t('common.failed')}
              </span>
            ) : null}
          </p>
        </div>
      </form>
    </Card>
  );
}
