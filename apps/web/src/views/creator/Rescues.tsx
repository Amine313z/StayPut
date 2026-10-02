import type { RescuesUpdate, RescuesView } from '@stayput/core';
import { CircleAlert, CircleCheck, LifeBuoy, Save } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { putJson, useApi } from '../../api';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useCreatorData } from '../CreatorView';

/**
 * The rescue challenges (SPEC Phase 5, point 9): members inactive for 14 days shown, without
 * their name, to the community's members; off until the creator turns them on.
 */
export function Rescues() {
  const { api } = useCreatorData();
  const { state, retry } = useApi<RescuesView>(`${api}/rescues`);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <RescuesForm initial={state.data} />;
}

function RescuesForm({ initial }: { initial: RescuesView }) {
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
      const body: RescuesUpdate = { enabled };
      const next = await putJson<RescuesView>(`${api}/rescues`, body);
      setView(next);
      setEnabled(next.enabled);
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <Card
      icon={<LifeBuoy aria-hidden="true" className="size-4" />}
      title={t('rescues.title')}
      description={t('rescues.body')}
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
              {t('rescues.enable')}
            </label>
            <p id={`${ids}-hint`} className="text-sm text-muted">
              {t('rescues.hint')}
            </p>
          </div>
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
          <li>{plural('rescues.open', view.open)}</li>
          <li>{plural('rescues.rescued', view.rescuedLast30)}</li>
          <li>{plural('rescues.rescuers', view.rescuers)}</li>
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={status === 'saving'}
            disabled={!changed}
            icon={<Save aria-hidden="true" className="size-4" />}
          >
            {t('rescues.save')}
          </Button>
          <p role="status" className="text-sm">
            {status === 'saved' ? (
              <span className="flex items-center gap-1.5 text-accent">
                <CircleCheck aria-hidden="true" className="size-4" />
                {t('rescues.saved')}
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
