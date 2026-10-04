import type { AlumniProblem, AlumniStep, AlumniView } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { CircleAlert, CircleCheck, Copy, GraduationCap, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError, postJson, useApi } from '../api';
import { useDemo } from '../demoMode';
import { useI18n } from '../i18n';
import { Badge, Notice } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';
import { FIELD } from './SettingsParts';
import { ErrorPanel, Loading } from './Status';

const STEPS: Readonly<Record<AlumniStep, MessageKey>> = {
  product: 'alumni.step.product',
  variant: 'alumni.step.variant',
  experience: 'alumni.step.experience',
  attach: 'alumni.step.attach',
};

const NAME_MAX = 80;

/**
 * The Alumni offer (SPEC 5.9): StayPut creates on Whop a free offer hidden from the store, with a
 * StayPut space, where former members stay in touch. Its link is how they enter: the departure
 * survey shows it, and Whop's automatic « User left » message carries it to everyone who leaves.
 */
export function AlumniCard({ api, whopAppId }: { api: string; whopAppId: string | null }) {
  const { t } = useI18n();
  const { state, retry } = useApi<AlumniView>(`${api}/alumni`);
  // The answer of the last creation, until the card is read again.
  const [answer, setAnswer] = useState<AlumniView | null>(null);
  const view = answer ?? (state.status === 'ready' ? state.data : null);
  return (
    <Card
      icon={<GraduationCap aria-hidden="true" className="size-4" />}
      title={t('alumni.title')}
      description={t('alumni.description')}
    >
      {view ? (
        <Alumni api={api} view={view} whopAppId={whopAppId} onAnswer={setAnswer} />
      ) : state.status === 'error' ? (
        <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
      ) : (
        <Loading />
      )}
    </Card>
  );
}

function Alumni({
  api,
  view,
  whopAppId,
  onAnswer,
}: {
  api: string;
  view: AlumniView;
  whopAppId: string | null;
  onAnswer: (view: AlumniView) => void;
}) {
  const { t, number } = useI18n();
  const demo = useDemo();
  const id = useId();
  const [name, setName] = useState(() => view.offer?.name ?? t('alumni.defaultName'));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);
  const offer = view.offer;
  const ready = Boolean(offer?.completedAt && offer.url);

  const create = async () => {
    setBusy(true);
    setFailed(null);
    try {
      onAnswer(await postJson<AlumniView>(`${api}/alumni`, { name: name.trim() }));
    } catch (error) {
      setFailed(error instanceof ApiError ? error : new ApiError('internal', String(error)));
    } finally {
      setBusy(false);
    }
  };

  if (ready && offer?.url) {
    return (
      <div className="space-y-5">
        <Notice tone="accent" icon={<CircleCheck aria-hidden="true" className="size-4" />}>
          {t('alumni.ready', { name: offer.name })}
        </Notice>
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-medium">
            {t('alumni.link')}
            {/* The demo's link is a made-up address (fix prompt v4.1, block 5). */}
            {demo ? <Badge>{t('alumni.example')}</Badge> : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm select-all">
              {offer.url}
            </code>
            <CopyButton text={offer.url} />
            <ExternalButton href={offer.url} whopAppId={whopAppId} variant="secondary" size="sm">
              {t('alumni.open')}
            </ExternalButton>
          </div>
          <p className="text-sm text-muted">{t('alumni.linkHint')}</p>
        </div>
        <UserLeft url={offer.url} />
        <p className="tabular text-sm text-muted">
          {t('alumni.stats', {
            entered: number(view.entered),
            returned: number(view.returned),
            left: number(view.left),
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('alumni.createHint')}</p>
      {view.problem ? <Problem problem={view.problem} /> : null}
      {offer ? null : (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-sm">
            {t('alumni.name')}
          </label>
          <input
            id={`${id}-name`}
            type="text"
            value={name}
            maxLength={NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            className={`${FIELD} w-full sm:w-80`}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          icon={<Sparkles aria-hidden="true" className="size-4" />}
          loading={busy}
          disabled={name.trim() === ''}
          onClick={() => void create()}
        >
          {t(offer ? 'alumni.finish' : 'alumni.create')}
        </Button>
        {failed ? (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            {t(failed.code === 'not_configured' ? 'alumni.notConfigured' : 'common.failed')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Where the creation stopped, and what to do about it. */
function Problem({ problem }: { problem: AlumniProblem }) {
  const { t } = useI18n();
  return (
    <Notice tone="warning" icon={<CircleAlert aria-hidden="true" className="size-4" />}>
      {problem.permission
        ? t('alumni.problem.permission', {
            step: t(STEPS[problem.step]),
            permission: problem.permission,
          })
        : t('alumni.problem.other', { step: t(STEPS[problem.step]) })}
    </Notice>
  );
}

/**
 * Whop's automatic « User left » message, sent to everyone who leaves the community (a DM, and an
 * e-mail when ticked): the text to paste, with the Alumni link, and where.
 */
export function UserLeft({ url }: { url: string }) {
  const { t } = useI18n();
  const id = useId();
  const text = t('alumni.userLeft.text', { url });
  return (
    <div className="space-y-2">
      <p id={`${id}-title`} className="text-sm font-medium">
        {t('alumni.userLeft.title')}
      </p>
      <p className="text-sm text-muted">{t('alumni.userLeft.how')}</p>
      <textarea
        readOnly
        rows={3}
        value={text}
        aria-labelledby={`${id}-title`}
        className={`${FIELD} w-full`}
      />
      <CopyButton text={text} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<Copy aria-hidden="true" className="size-4" />}
      onClick={() => void copy(text).then(setCopied)}
    >
      {t(copied ? 'alumni.copied' : 'alumni.copy')}
    </Button>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
