import type { EarnedDaysSettings } from '@stayput/core';
import { CircleAlert, CircleCheck, Gift, Save } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { putJson, useApi } from '../../api';
import { NumberField } from '../../components/SettingsParts';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useCreatorData } from '../CreatorView';

/**
 * The earned days (SPEC Phase 5, point 5): free days on a member's membership the first time
 * they reach 50 % and 100 % of a goal, off until the creator turns them on.
 */
export function EarnedDays() {
  const { api } = useCreatorData();
  const { state, retry } = useApi<EarnedDaysSettings>(`${api}/earned-days`);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <EarnedDaysForm initial={state.data} />;
}

const days = (text: string) => {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= 14 ? value : null;
};

function EarnedDaysForm({ initial }: { initial: EarnedDaysSettings }) {
  const { api } = useCreatorData();
  const { t } = useI18n();
  const ids = useId();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [at50, setAt50] = useState(String(initial.at50));
  const [at100, setAt100] = useState(String(initial.at100));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const view =
    days(at50) !== null && days(at100) !== null
      ? { enabled, at50: days(at50)!, at100: days(at100)! }
      : null;
  const changed =
    view !== null &&
    (view.enabled !== saved.enabled || view.at50 !== saved.at50 || view.at100 !== saved.at100);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!view || !changed) return;
    setStatus('saving');
    try {
      const next = await putJson<EarnedDaysSettings>(`${api}/earned-days`, view);
      setSaved(next);
      setEnabled(next.enabled);
      setAt50(String(next.at50));
      setAt100(String(next.at100));
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };
  const edit = (change: () => void) => {
    change();
    if (status !== 'saving') setStatus('idle');
  };

  return (
    <Card
      icon={<Gift aria-hidden="true" className="size-4" />}
      title={t('earnedDays.title')}
      description={t('earnedDays.body')}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <div className="flex items-start gap-3">
          <input
            id={`${ids}-on`}
            type="checkbox"
            checked={enabled}
            aria-describedby={`${ids}-hint`}
            onChange={(event) => edit(() => setEnabled(event.target.checked))}
            className="mt-1 size-4 shrink-0 accent-accent"
          />
          <div>
            <label htmlFor={`${ids}-on`} className="text-sm font-medium">
              {t('earnedDays.enable')}
            </label>
            <p id={`${ids}-hint`} className="text-sm text-muted">
              {t('earnedDays.hint')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <NumberField
            id={`${ids}-50`}
            label={t('earnedDays.at50')}
            value={at50}
            invalid={days(at50) === null}
            min={0}
            max={14}
            onChange={(value) => edit(() => setAt50(value))}
          />
          <NumberField
            id={`${ids}-100`}
            label={t('earnedDays.at100')}
            value={at100}
            invalid={days(at100) === null}
            min={0}
            max={14}
            onChange={(value) => edit(() => setAt100(value))}
          />
        </div>
        {view === null ? <p className="text-sm text-danger">{t('earnedDays.invalid')}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={status === 'saving'}
            disabled={!changed}
            icon={<Save aria-hidden="true" className="size-4" />}
          >
            {t('earnedDays.save')}
          </Button>
          <p role="status" className="text-sm">
            {status === 'saved' ? (
              <span className="flex items-center gap-1.5 text-accent">
                <CircleCheck aria-hidden="true" className="size-4" />
                {t('earnedDays.saved')}
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
