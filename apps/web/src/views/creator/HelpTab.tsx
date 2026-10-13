import { SUPPORT_MESSAGE_LIMITS, type SupportReceived } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { CircleCheck, Compass, Plus, Send } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { ApiError, postJson } from '../../api';
import { useGuide } from '../../components/guide/context';
import { useI18n } from '../../i18n';
import { Button, buttonClass } from '../../ui/Button';
import { IconTip } from '../../ui/IconTip';
import { useCreatorData } from '../CreatorView';

/**
 * Help & support (decision of 2026-10-13, after Sendoo's page): the questions creators ask, each
 * opened in place, with the tour one click away; and a direct line to StayPut's founder, whose
 * answer comes in the creator's Whop chats.
 */

/** The questions, in the order a creator asks them: what, how, is it safe, what does it cost. */
const FAQ: readonly { q: MessageKey; a: MessageKey }[] = [
  { q: 'help.faq.what.q', a: 'help.faq.what.a' },
  { q: 'help.faq.score.q', a: 'help.faq.score.a' },
  { q: 'help.faq.approval.q', a: 'help.faq.approval.a' },
  { q: 'help.faq.limits.q', a: 'help.faq.limits.a' },
  { q: 'help.faq.where.q', a: 'help.faq.where.a' },
  { q: 'help.faq.bots.q', a: 'help.faq.bots.a' },
  { q: 'help.faq.saved.q', a: 'help.faq.saved.a' },
  { q: 'help.faq.data.q', a: 'help.faq.data.a' },
  { q: 'help.faq.team.q', a: 'help.faq.team.a' },
  { q: 'help.faq.trial.q', a: 'help.faq.trial.a' },
  { q: 'help.faq.change.q', a: 'help.faq.change.a' },
  { q: 'help.faq.contact.q', a: 'help.faq.contact.a' },
];

export function FaqTab() {
  const { t } = useI18n();
  const { startTour } = useGuide();
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('help.faq.title')}</h2>
        <Button
          variant="secondary"
          size="sm"
          icon={<Compass aria-hidden="true" className="size-4" />}
          onClick={startTour}
        >
          {t('help.tour')}
        </Button>
      </header>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface/60">
        {FAQ.map((item) => (
          <details key={item.q} className="group" data-faq={item.q}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-medium hover:bg-surface-3/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
              {t(item.q)}
              <Plus
                aria-hidden="true"
                className="size-4 shrink-0 text-subtle transition-transform duration-150 group-open:rotate-45"
              />
            </summary>
            <p className="px-5 pb-5 text-sm leading-relaxed text-muted">{t(item.a)}</p>
          </details>
        ))}
      </div>
    </div>
  );
}

export function SupportTab() {
  const { t } = useI18n();
  const { api, demo } = useCreatorData();
  const fieldId = useId();
  const tipId = useId();
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const length = message.trim().length;
  const ready = length >= SUPPORT_MESSAGE_LIMITS.min && length <= SUPPORT_MESSAGE_LIMITS.max;
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (demo || !ready || state === 'sending') return;
    setState('sending');
    setProblem(null);
    try {
      await postJson<SupportReceived>(`${api}/support`, { message: message.trim() });
      setState('sent');
      setMessage('');
    } catch (error) {
      setState('idle');
      setProblem(
        error instanceof ApiError && error.code === 'conflict'
          ? 'help.support.tooMany'
          : 'help.support.failed',
      );
    }
  };
  if (state === 'sent') {
    return (
      <section
        role="status"
        className="mx-auto max-w-2xl rounded-xl border border-line-strong bg-surface p-6"
      >
        <CircleCheck aria-hidden="true" className="size-6 text-accent" />
        <h2 className="mt-3 text-lg font-semibold">{t('help.support.sent.title')}</h2>
        <p className="mt-1 text-sm text-muted">{t('help.support.sent.body')}</p>
        <Button variant="secondary" size="sm" className="mt-5" onClick={() => setState('idle')}>
          {t('help.support.another')}
        </Button>
      </section>
    );
  }
  return (
    <form
      onSubmit={(event) => void send(event)}
      className="mx-auto max-w-2xl space-y-4 rounded-xl border border-line bg-surface/60 p-6"
    >
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{t('help.support.title')}</h2>
        <p className="text-sm text-muted">{t('help.support.body')}</p>
      </header>
      <div className="space-y-2">
        <label htmlFor={fieldId} className="text-sm font-medium">
          {t('help.support.label')}
        </label>
        <textarea
          id={fieldId}
          rows={7}
          value={message}
          maxLength={SUPPORT_MESSAGE_LIMITS.max}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={t('help.support.placeholder')}
          className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-accent"
        />
        <p className="flex justify-between gap-3 text-xs text-subtle">
          <span>
            {length > 0 && length < SUPPORT_MESSAGE_LIMITS.min ? t('help.support.tooShort') : ''}
          </span>
          <span className="tabular-nums">
            {length} / {SUPPORT_MESSAGE_LIMITS.max}
          </span>
        </p>
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-fg">
          {t(problem)}
        </p>
      ) : null}
      {demo ? (
        <IconTip label={t('demo.disabled')} id={tipId}>
          <button
            type="button"
            aria-disabled="true"
            aria-describedby={tipId}
            data-demo-disabled=""
            className={buttonClass('primary', 'md')}
            onClick={(event) => event.currentTarget.focus()}
          >
            <Send aria-hidden="true" className="size-4" />
            {t('help.support.send')}
          </button>
        </IconTip>
      ) : (
        <Button
          type="submit"
          disabled={!ready}
          loading={state === 'sending'}
          icon={<Send aria-hidden="true" className="size-4" />}
        >
          {t('help.support.send')}
        </Button>
      )}
    </form>
  );
}
