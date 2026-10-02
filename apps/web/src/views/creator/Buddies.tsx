import type { BuddiesUpdate, BuddiesView } from '@stayput/core';
import { CircleAlert, CircleCheck, HeartHandshake, Save } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { putJson, useApi } from '../../api';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Notice } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useCreatorData } from '../CreatorView';

/**
 * The buddies (SPEC Phase 5, point 8): each newcomer paired with a veteran who helps them start,
 * off until the creator turns them on, and where they stand.
 */
export function Buddies() {
  const { api } = useCreatorData();
  const { state, retry } = useApi<BuddiesView>(`${api}/buddies`);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <BuddiesForm initial={state.data} />;
}

function BuddiesForm({ initial }: { initial: BuddiesView }) {
  const { api } = useCreatorData();
  const { t, plural } = useI18n();
  const ids = useId();
  const [view, setView] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const changed = enabled !== view.enabled;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setStatus('saving');
    try {
      const body: BuddiesUpdate = { enabled };
      const next = await putJson<BuddiesView>(`${api}/buddies`, body);
      setView(next);
      setEnabled(next.enabled);
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <Card
      icon={<HeartHandshake aria-hidden="true" className="size-4" />}
      title={t('buddies.title')}
      description={t('buddies.body')}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <div className="flex items-start gap-3">
          <input
            id={`${ids}-on`}
            type="checkbox"
            checked={enabled}
            aria-describedby={`${ids}-hint`}
            onChange={(event) => {
              setEnabled(event.target.checked);
              if (status !== 'saving') setStatus('idle');
            }}
            className="mt-1 size-4 shrink-0 accent-accent"
          />
          <div>
            <label htmlFor={`${ids}-on`} className="text-sm font-medium">
              {t('buddies.enable')}
            </label>
            <p id={`${ids}-hint`} className="text-sm text-muted">
              {t('buddies.hint')}
            </p>
          </div>
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
          <li>{plural('buddies.active', view.activePairs)}</li>
          <li>{plural('buddies.waiting', view.waitingNewcomers)}</li>
          <li>{plural('buddies.veterans', view.veterans)}</li>
          <li>{plural('buddies.mentors', view.mentors)}</li>
        </ul>
        {enabled && view.veterans === 0 ? (
          <Notice tone="info">{t('buddies.noVeteran')}</Notice>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={status === 'saving'}
            disabled={!changed}
            icon={<Save aria-hidden="true" className="size-4" />}
          >
            {t('buddies.save')}
          </Button>
          <p role="status" className="text-sm">
            {status === 'saved' ? (
              <span className="flex items-center gap-1.5 text-accent">
                <CircleCheck aria-hidden="true" className="size-4" />
                {t('buddies.saved')}
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
