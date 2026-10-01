import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button } from '../ui/Button';

/**
 * A button for what cannot be undone in one click: the first click asks, the second does it.
 * `run` rejects to say it failed; the button is then offered again.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  icon,
  run,
}: {
  label: string;
  confirmLabel: string;
  icon?: ReactNode;
  run: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<'idle' | 'asking' | 'running' | 'failed'>('idle');
  if (step === 'asking' || step === 'running') {
    return (
      <span className="inline-flex items-center gap-2">
        <Button
          variant="danger"
          size="sm"
          loading={step === 'running'}
          onClick={() => {
            setStep('running');
            run().then(
              () => setStep('idle'),
              () => setStep('failed'),
            );
          }}
        >
          {confirmLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={step === 'running'}
          onClick={() => setStep('idle')}
        >
          {t('common.cancel')}
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="ghost" size="sm" icon={icon} onClick={() => setStep('asking')}>
        {label}
      </Button>
      {step === 'failed' ? (
        <span role="alert" className="text-xs text-danger">
          {t('common.failed')}
        </span>
      ) : null}
    </span>
  );
}
