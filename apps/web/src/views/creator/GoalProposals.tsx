import {
  GOAL_CATEGORIES,
  GOAL_TITLE_MAX,
  GOAL_UNIT_MAX,
  MAX_GOAL_PROPOSALS,
  type GoalCategory,
  type GoalEntry,
  type GoalProposal,
  type GoalProposalsUpdate,
  type GoalProposalsView,
  type Niche,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import {
  CircleAlert,
  CircleCheck,
  Flag,
  PenLine,
  Plus,
  RotateCcw,
  Save,
  Target,
  Trash2,
} from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { putJson, useApi } from '../../api';
import { FIELD } from '../../components/SettingsParts';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useCreatorData } from '../CreatorView';

const NICHE_LABELS: Readonly<Record<Niche, MessageKey>> = {
  trading: 'niche.trading',
  sports_betting: 'niche.sports_betting',
  fitness: 'niche.fitness',
  online_business: 'niche.online_business',
  coaching: 'niche.coaching',
  ecommerce: 'niche.ecommerce',
  personal_development: 'niche.personal_development',
  other: 'niche.other',
};

const CATEGORY_LABELS: Readonly<Record<GoalCategory, MessageKey>> = {
  income: 'space.category.income',
  clients: 'space.category.clients',
  sales: 'space.category.sales',
  body: 'space.category.body',
  practice: 'space.category.practice',
  learning: 'space.category.learning',
  performance: 'space.category.performance',
  other: 'space.category.other',
};

/**
 * The goals proposed to members (SPEC Phase 5, point 1): StayPut's for the creator's niche, in
 * each member's language, until the creator writes their own (up to six, in their words).
 * `niche` is in the address: a niche changed above reads the list again.
 */
export function GoalProposals({ niche }: { niche: Niche }) {
  const { api } = useCreatorData();
  const { locale } = useI18n();
  const { state, retry } = useApi<GoalProposalsView>(`${api}/goals?lang=${locale}&niche=${niche}`);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <GoalProposalsForm key={`${niche}:${locale}`} initial={state.data} />;
}

function GoalProposalsForm({ initial }: { initial: GoalProposalsView }) {
  const { api } = useCreatorData();
  const { t, locale } = useI18n();
  const ids = useId();
  const [view, setView] = useState(initial);
  // The list being written; null: StayPut's are shown.
  const [draft, setDraft] = useState<GoalProposal[] | null>(initial.custom);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'invalid'>('idle');

  const save = async (proposals: GoalProposal[] | null) => {
    setStatus('saving');
    try {
      const body: GoalProposalsUpdate = { proposals };
      const next = await putJson<GoalProposalsView>(`${api}/goals?lang=${locale}`, body);
      setView(next);
      setDraft(next.custom);
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const cleaned = draft.map((goal) => ({
      ...goal,
      title: goal.title.trim(),
      unit: goal.unit.trim(),
    }));
    if (cleaned.some((goal) => !goal.title || !goal.unit)) {
      setStatus('invalid');
      return;
    }
    void save(cleaned);
  };

  const edit = (index: number, change: Partial<GoalProposal>) =>
    setDraft((current) =>
      current ? current.map((goal, i) => (i === index ? { ...goal, ...change } : goal)) : current,
    );

  return (
    <Card
      icon={<Target aria-hidden="true" className="size-4" />}
      title={t('goals.title')}
      description={t('goals.body')}
    >
      {draft === null ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {t('goals.niche', { niche: t(NICHE_LABELS[view.niche]) })}
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {view.defaults.map((goal) => (
              <li
                key={goal.title}
                className="flex items-start gap-3 rounded-xl border border-line p-3"
              >
                <Flag aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
                <span className="min-w-0 text-sm">
                  <span className="block font-medium">{goal.title}</span>
                  <span className="block text-muted">
                    {goal.unit} ·{' '}
                    {t(goal.entry === 'add' ? 'goals.entry.add' : 'goals.entry.total')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(view.defaults);
                setStatus('idle');
              }}
              icon={<PenLine aria-hidden="true" className="size-4" />}
            >
              {t('goals.edit')}
            </Button>
            <Saved status={status} />
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="text-sm text-muted">{draft.length ? t('goals.custom') : t('goals.none')}</p>
          <ol className="space-y-3">
            {draft.map((goal, i) => (
              <li
                key={i}
                className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[minmax(0,1fr)_7rem] lg:grid-cols-[minmax(0,1fr)_7rem_10rem_10rem_auto] lg:items-end"
              >
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('goals.titleLabel')}</span>
                  <input
                    value={goal.title}
                    maxLength={GOAL_TITLE_MAX}
                    aria-invalid={status === 'invalid' && !goal.title.trim()}
                    onChange={(event) => edit(i, { title: event.target.value })}
                    className={`${FIELD} w-full`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('goals.unitLabel')}</span>
                  <input
                    value={goal.unit}
                    maxLength={GOAL_UNIT_MAX}
                    aria-invalid={status === 'invalid' && !goal.unit.trim()}
                    onChange={(event) => edit(i, { unit: event.target.value })}
                    className={`${FIELD} w-full`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('goals.categoryLabel')}</span>
                  <select
                    value={goal.category}
                    onChange={(event) => edit(i, { category: event.target.value as GoalCategory })}
                    className={`${FIELD} w-full`}
                  >
                    {GOAL_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {t(CATEGORY_LABELS[category])}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('goals.entryLabel')}</span>
                  <select
                    value={goal.entry}
                    onChange={(event) => edit(i, { entry: event.target.value as GoalEntry })}
                    className={`${FIELD} w-full`}
                  >
                    <option value="total">{t('goals.entry.total')}</option>
                    <option value="add">{t('goals.entry.add')}</option>
                  </select>
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('goals.remove', { title: goal.title || String(i + 1) })}
                  onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                  icon={<Trash2 aria-hidden="true" className="size-4" />}
                />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={draft.length >= MAX_GOAL_PROPOSALS}
              aria-describedby={`${ids}-max`}
              onClick={() =>
                setDraft([...draft, { title: '', unit: '', category: 'other', entry: 'total' }])
              }
              icon={<Plus aria-hidden="true" className="size-4" />}
            >
              {t('goals.add')}
            </Button>
            <span id={`${ids}-max`} className="text-sm text-muted">
              {t('goals.max', { count: MAX_GOAL_PROPOSALS })}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button
              type="submit"
              loading={status === 'saving'}
              icon={<Save aria-hidden="true" className="size-4" />}
            >
              {t('goals.save')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void save(null)}
              icon={<RotateCcw aria-hidden="true" className="size-4" />}
            >
              {t('goals.reset')}
            </Button>
            <Saved status={status} />
          </div>
        </form>
      )}
    </Card>
  );
}

function Saved({ status }: { status: string }) {
  const { t } = useI18n();
  return (
    <p role="status" className="text-sm">
      {status === 'saved' ? (
        <span className="flex items-center gap-1.5 text-accent">
          <CircleCheck aria-hidden="true" className="size-4" />
          {t('goals.saved')}
        </span>
      ) : status === 'failed' || status === 'invalid' ? (
        <span className="flex items-center gap-1.5 text-danger">
          <CircleAlert aria-hidden="true" className="size-4" />
          {t(status === 'invalid' ? 'goals.invalid' : 'common.failed')}
        </span>
      ) : null}
    </p>
  );
}
