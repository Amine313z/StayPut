import {
  GOAL_CATEGORIES,
  GOAL_MAX_YEARS,
  GOAL_TITLE_MAX,
  GOAL_UNIT_MAX,
  MILESTONES,
  announcementText,
  parseLocaleNumber,
  proofJustifies,
  type BadgeCode,
  type EarnedBadge,
  type GoalCategory,
  type GoalEntry,
  type GoalInput,
  type GoalProposal,
  type MemberBuddies,
  type MemberGoal,
  type MemberSpaceView,
  type Milestone,
  type ProofInput,
  type ResultAnswer,
  type ResultEntry,
  type AffiliateLinkView,
  type ShareAnswer,
  type ShareRequest,
  type TestimonialCard,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import {
  Check,
  ChevronLeft,
  CircleAlert,
  Eye,
  Flag,
  Flame,
  Gift,
  HeartHandshake,
  Hourglass,
  ImagePlus,
  LifeBuoy,
  LoaderCircle,
  Lock,
  Megaphone,
  Mountain,
  PartyPopper,
  PenLine,
  Plus,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { deleteJson, getJson, postJson, useApi } from '../api';
import { useI18n } from '../i18n';
import { readScreenshot, type ReadingStage } from '../ocr';
import { trialCard, trialGoal, trialResult, trialStart } from '../trial';
import { Badge, Notice } from '../ui/Badge';
import { Button, buttonClass } from '../ui/Button';
import { Card } from '../ui/Card';
import { useWithUnit } from '../units';
import { BuddyCard } from './BuddyCard';
import { FIELD } from './SettingsParts';
import { TestimonialCards, type CardBackend } from './Testimonial';

/** What an answer brought, to celebrate it once. */
interface Celebration {
  milestones: Milestone[];
  badges: BadgeCode[];
  achieved: boolean;
  /** A result recorded: thanks, even without a milestone. */
  recorded: boolean;
  /** What its screenshot came to (ResultAnswer). */
  proof: ResultAnswer['proof'];
  /** Free days the milestones just added to the member's access. */
  earnedDays: number;
}

/**
 * Where the space's answers come from: StayPut for a member, the browser for the team's trial
 * (`current` is the space as shown, which the trial builds on).
 */
interface SpaceBackend extends CardBackend {
  setGoal: (goal: GoalInput, current: MemberSpaceView) => Promise<MemberSpaceView>;
  recordResult: (entry: ResultEntry, current: MemberSpaceView) => Promise<ResultAnswer>;
  share: (request: ShareRequest) => Promise<ShareAnswer>;
  setBuddyOptOut: (optOut: boolean) => Promise<MemberBuddies>;
}

/**
 * The member space (SPEC Phase 5): the member chooses a goal among the creator's (or writes
 * their own), records results in one gesture, and sees the way they have come: the milestones,
 * the badges. Progress only, never a score (SPEC 5.3). The team tries it in their browser, where
 * nothing is recorded.
 */
export function MemberSpace({ api }: { api: string }) {
  const { t, locale } = useI18n();
  const { state, retry } = useApi<MemberSpaceView>(`${api}/space?lang=${locale}`);
  const backend = useMemo<SpaceBackend>(
    () => ({
      setGoal: (goal) => postJson<MemberSpaceView>(`${api}/space/goal?lang=${locale}`, goal),
      recordResult: (entry) => postJson<ResultAnswer>(`${api}/space/result?lang=${locale}`, entry),
      share: (request) => postJson<ShareAnswer>(`${api}/space/share`, request),
      makeCard: (request) => postJson<TestimonialCard>(`${api}/space/card`, request),
      removeCard: async (proofId) => {
        await deleteJson(`${api}/space/card/${encodeURIComponent(proofId)}`);
      },
      affiliateLink: async () => (await getJson<AffiliateLinkView>(`${api}/space/affiliate`)).url,
      setBuddyOptOut: (optOut) => postJson<MemberBuddies>(`${api}/space/buddies`, { optOut }),
    }),
    [api, locale],
  );
  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <Card icon={<Target aria-hidden="true" className="size-4" />} title={t('space.title')}>
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            {t('common.failed')}
          </p>
          <Button variant="secondary" size="sm" onClick={retry}>
            {t('common.retry')}
          </Button>
        </div>
      </Card>
    );
  }
  if (state.data.preview) return <TrialSpace preview={state.data} />;
  if (!state.data.known) {
    return (
      <Card
        icon={<Hourglass aria-hidden="true" className="size-4" />}
        title={t('space.unknown.title')}
        description={t('space.unknown.body')}
      />
    );
  }
  return <Space view={state.data} backend={backend} />;
}

/** For the team: the member space to try, computed in the browser, nothing recorded. */
function TrialSpace({ preview }: { preview: MemberSpaceView }) {
  const { t, locale } = useI18n();
  const [start, setStart] = useState(() => trialStart(preview));
  // The screenshots that backed a result in this trial: each backs one only, as in StayPut.
  const used = useRef(new Set<string>());
  const backend = useMemo<SpaceBackend>(
    () => ({
      setGoal: (goal, current) => Promise.resolve(trialGoal(current, goal, new Date())),
      recordResult: (entry, current) => {
        const answer = trialResult(current, entry, new Date(), used.current);
        return answer ? Promise.resolve(answer) : Promise.reject(new Error('no goal under way'));
      },
      // The trial posts nothing, and publishes no page.
      share: () => Promise.resolve({ status: 'simulated' }),
      makeCard: (request, current) => {
        const card = trialCard(current, request, {
          now: new Date(),
          origin: window.location.origin,
          proofId: crypto.randomUUID(),
          locale,
          name: t('card.trialName'),
        });
        return card ? Promise.resolve(card) : Promise.reject(new Error('no such result'));
      },
      removeCard: () => Promise.resolve(),
      affiliateLink: () => Promise.resolve(null),
      // The trial has no buddy: pairs are made among the community's members.
      setBuddyOptOut: (optOut) => Promise.resolve({ optedOut: optOut, partners: [] }),
    }),
    [t, locale],
  );
  return (
    <Space
      view={start}
      backend={backend}
      trial={
        <Notice tone="info" icon={<Eye aria-hidden="true" className="size-4" />}>
          <p>{t('space.trial.body')}</p>
          <p className="mt-1 text-muted">{t('space.preview.body')}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => {
              used.current = new Set();
              setStart(trialStart(preview));
            }}
            icon={<RotateCcw aria-hidden="true" className="size-4" />}
          >
            {t('space.trial.reset')}
          </Button>
        </Notice>
      }
    />
  );
}

/** The goal card and the badges card, answering through `backend`. */
function Space({
  view,
  backend,
  trial,
}: {
  view: MemberSpaceView;
  backend: SpaceBackend;
  /** The team's trial: what it is, shown above the goal. */
  trial?: ReactNode;
}) {
  const { t } = useI18n();
  // What an answer returned, until `view` changes; `n` tells answers apart.
  const [answer, setAnswer] = useState<{
    base: MemberSpaceView;
    view: MemberSpaceView;
    celebration: Celebration | null;
    n: number;
  } | null>(null);
  // The celebration the member closed.
  const [closed, setClosed] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const current = answer && answer.base === view ? answer : null;
  const shown = current?.view ?? view;
  // What the last answer brought, or the badges this opening brought (seven days in a row).
  const celebration: Celebration | null = current
    ? current.celebration
    : view.fresh.length > 0
      ? {
          milestones: [],
          badges: view.fresh,
          achieved: false,
          recorded: false,
          proof: null,
          earnedDays: 0,
        }
      : null;
  const celebrationKey = current ? `answer:${current.n}` : `opening:${view.fresh.join()}`;

  const answered = (next: MemberSpaceView, brought: Celebration | null) => {
    setAnswer({ base: view, view: next, celebration: brought, n: (answer?.n ?? 0) + 1 });
    setChoosing(false);
  };

  const goal = shown.goal;
  return (
    <>
      <Card
        icon={<Target aria-hidden="true" className="size-4 text-accent" />}
        title={goal && !choosing ? goal.title : t('space.title')}
        description={goal && !choosing ? undefined : t('space.choose.body')}
        actions={
          <>
            {trial ? <Badge tone="info">{t('member.preview.badge')}</Badge> : null}
            {goal && !choosing && goal.status === 'active' ? (
              <Button variant="ghost" size="sm" onClick={() => setChoosing(true)}>
                {t('space.goal.change')}
              </Button>
            ) : null}
          </>
        }
      >
        <div className="space-y-5">
          {trial}
          {celebration && closed !== celebrationKey ? (
            <CelebrationNotice
              celebration={celebration}
              onClose={() => setClosed(celebrationKey)}
              share={
                shown.announce &&
                goal &&
                (celebration.achieved || celebration.milestones.length > 0)
                  ? {
                      announce: shown.announce,
                      goal,
                      percent: celebration.achieved ? 100 : celebration.milestones.at(-1)!,
                      trial: Boolean(trial),
                      send: backend.share,
                    }
                  : null
              }
            />
          ) : null}
          {!goal || choosing ? (
            <GoalChooser
              proposals={shown.proposals}
              onCancel={goal ? () => setChoosing(false) : null}
              onSet={async (input) => answered(await backend.setGoal(input, shown), null)}
            />
          ) : goal.status === 'achieved' ? (
            <GoalReached goal={goal} rewards={shown.rewards} onNext={() => setChoosing(true)} />
          ) : (
            <GoalProgress
              goal={goal}
              results={shown.results}
              rewards={shown.rewards}
              onResult={async (entry) => {
                const result = await backend.recordResult(entry, shown);
                answered(result.space, {
                  milestones: result.milestones,
                  badges: result.badges,
                  achieved: result.achieved,
                  recorded: true,
                  proof: result.proof,
                  earnedDays: result.earnedDays,
                });
              }}
            />
          )}
        </div>
      </Card>
      {shown.buddies ? (
        <BuddyCard
          buddies={shown.buddies}
          categories={CATEGORY_LABELS}
          onOptOut={backend.setBuddyOptOut}
        />
      ) : null}
      {(goal && shown.results.length > 0) || shown.cards.length > 0 ? (
        <TestimonialCards view={shown} backend={backend} trial={Boolean(trial)} />
      ) : null}
      <BadgesCard
        badges={shown.badges}
        // A veteran welcoming a newcomer can earn the Mentor badge: it shows among those ahead.
        ahead={shown.buddies?.partners.some((p) => p.role === 'newcomer') ? ['mentor'] : []}
      />
    </>
  );
}

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

/** The goals the creator proposes, then the form of the one chosen (or of their own). */
function GoalChooser({
  proposals,
  onCancel,
  onSet,
}: {
  proposals: GoalProposal[];
  onCancel: (() => void) | null;
  onSet: (goal: GoalInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<GoalProposal | 'custom' | null>(null);
  if (picked) {
    return (
      <GoalForm
        proposal={picked === 'custom' ? null : picked}
        onBack={() => setPicked(null)}
        onSet={onSet}
      />
    );
  }
  return (
    <div className="space-y-3">
      <ul className="grid gap-2 sm:grid-cols-2">
        {proposals.map((proposal, i) => (
          <li key={`${i}-${proposal.title}`}>
            <button
              type="button"
              onClick={() => setPicked(proposal)}
              className="flex h-full w-full items-start gap-3 rounded-xl border border-line bg-surface p-3 text-start shadow-card transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Flag aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="block font-medium">{proposal.title}</span>
                <span className="mt-0.5 block text-sm text-muted">{proposal.unit}</span>
              </span>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={() => setPicked('custom')}
            className="flex h-full w-full items-start gap-3 rounded-xl border border-dashed border-line p-3 text-start transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <PenLine aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="block font-medium">{t('space.choose.custom')}</span>
              <span className="mt-0.5 block text-sm text-muted">
                {t('space.choose.customHint')}
              </span>
            </span>
          </button>
        </li>
      </ul>
      {onCancel ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('space.choose.cancel')}
        </Button>
      ) : null}
    </div>
  );
}

/** A calendar day, YYYY-MM-DD, of the browser's time zone. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function inMonths(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return localDay(date);
}

/** The goal's numbers and date: a proposal's title and unit to keep or change, or their own. */
function GoalForm({
  proposal,
  onBack,
  onSet,
}: {
  proposal: GoalProposal | null;
  onBack: () => void;
  onSet: (goal: GoalInput) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const ids = useId();
  const [title, setTitle] = useState(proposal?.title ?? '');
  const [unit, setUnit] = useState(proposal?.unit ?? '');
  const [category, setCategory] = useState<GoalCategory>(proposal?.category ?? 'other');
  const [entry, setEntry] = useState<GoalEntry>(proposal?.entry ?? 'total');
  const [start, setStart] = useState(proposal?.entry === 'add' ? '0' : '');
  const [target, setTarget] = useState('');
  const [date, setDate] = useState(() => inMonths(3));
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const today = localDay(new Date());
  const latest = inMonths(GOAL_MAX_YEARS * 12);
  const startValue = parseLocaleNumber(start, locale);
  const targetValue = parseLocaleNumber(target, locale);
  const errors = {
    title: title.trim() ? null : t('space.form.required'),
    unit: unit.trim() ? null : t('space.form.required'),
    start: startValue === null ? t('space.form.number') : null,
    target:
      targetValue === null
        ? t('space.form.number')
        : targetValue === startValue
          ? t('space.form.same')
          : null,
    date:
      /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today && date <= latest
        ? null
        : t('space.form.dateInvalid'),
  };
  const valid = Object.values(errors).every((error) => error === null);
  const shown = (error: string | null) => (checked ? error : null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid || startValue === null || targetValue === null) return;
    setSaving(true);
    setFailed(false);
    const goal: GoalInput = {
      title: title.trim(),
      unit: unit.trim(),
      category,
      entry,
      start: startValue,
      target: targetValue,
      targetDate: date,
    };
    try {
      await onSet(goal);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        icon={<ChevronLeft aria-hidden="true" className="size-4" />}
      >
        {t('space.form.back')}
      </Button>
      <Field id={`${ids}-title`} label={t('space.form.title')} error={shown(errors.title)}>
        <input
          id={`${ids}-title`}
          value={title}
          maxLength={GOAL_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={Boolean(shown(errors.title))}
          aria-describedby={shown(errors.title) ? `${ids}-title-error` : undefined}
          className={`${FIELD} w-full`}
        />
      </Field>
      {proposal ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${ids}-category`} label={t('space.form.category')} error={null}>
            <select
              id={`${ids}-category`}
              value={category}
              onChange={(event) => setCategory(event.target.value as GoalCategory)}
              className={`${FIELD} w-full`}
            >
              {GOAL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(CATEGORY_LABELS[c])}
                </option>
              ))}
            </select>
          </Field>
          <fieldset>
            <legend className="text-sm font-medium">{t('space.form.entry')}</legend>
            <div className="mt-1.5 space-y-1.5">
              {(['total', 'add'] as const).map((value) => (
                <label key={value} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${ids}-entry`}
                    value={value}
                    checked={entry === value}
                    onChange={() => {
                      setEntry(value);
                      if (value === 'add' && !start) setStart('0');
                    }}
                    className="mt-0.5 accent-accent"
                  />
                  {t(value === 'total' ? 'space.form.entry.total' : 'space.form.entry.add')}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id={`${ids}-unit`} label={t('space.form.unit')} error={shown(errors.unit)}>
          <input
            id={`${ids}-unit`}
            value={unit}
            maxLength={GOAL_UNIT_MAX}
            placeholder={t('space.form.unitHint')}
            onChange={(event) => setUnit(event.target.value)}
            aria-invalid={Boolean(shown(errors.unit))}
            aria-describedby={shown(errors.unit) ? `${ids}-unit-error` : undefined}
            className={`${FIELD} w-full`}
          />
        </Field>
        <Field
          id={`${ids}-start`}
          label={t(entry === 'add' ? 'space.form.startAdd' : 'space.form.start')}
          error={shown(errors.start)}
        >
          <input
            id={`${ids}-start`}
            value={start}
            inputMode="decimal"
            autoComplete="off"
            onChange={(event) => setStart(event.target.value)}
            aria-invalid={Boolean(shown(errors.start))}
            aria-describedby={shown(errors.start) ? `${ids}-start-error` : undefined}
            className={`${FIELD} tabular w-full`}
          />
        </Field>
        <Field id={`${ids}-target`} label={t('space.form.target')} error={shown(errors.target)}>
          <input
            id={`${ids}-target`}
            value={target}
            inputMode="decimal"
            autoComplete="off"
            onChange={(event) => setTarget(event.target.value)}
            aria-invalid={Boolean(shown(errors.target))}
            aria-describedby={shown(errors.target) ? `${ids}-target-error` : undefined}
            className={`${FIELD} tabular w-full`}
          />
        </Field>
      </div>
      <Field id={`${ids}-date`} label={t('space.form.date')} error={shown(errors.date)}>
        <input
          id={`${ids}-date`}
          type="date"
          value={date}
          min={today}
          max={latest}
          onChange={(event) => setDate(event.target.value)}
          aria-invalid={Boolean(shown(errors.date))}
          aria-describedby={shown(errors.date) ? `${ids}-date-error` : undefined}
          className={`${FIELD} w-full sm:w-auto`}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={saving}
          icon={<Flag aria-hidden="true" className="size-4" />}
        >
          {t('space.form.save')}
        </Button>
        {failed ? (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            {t('common.failed')}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** A labelled field, with what is wrong with it under it. */
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The way from the start to the target: the bar, its milestones, and the next result. */
function GoalProgress({
  goal,
  results,
  rewards,
  onResult,
}: {
  goal: MemberGoal;
  results: MemberSpaceView['results'];
  rewards: MemberSpaceView['rewards'];
  onResult: (entry: ResultEntry) => Promise<void>;
}) {
  const { t, percent, date, relative } = useI18n();
  const withUnit = useWithUnit();
  const reached = new Set(goal.milestones.map((m) => m.percent));
  return (
    <div className="space-y-5">
      <div>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="tabular text-3xl font-semibold tracking-tight">
            {withUnit(goal.current, goal.unit)}
          </span>
          <span className="text-muted">→ {withUnit(goal.target, goal.unit)}</span>
        </p>
        <ProgressBar progress={goal.progress} reached={reached} />
        <Rewards rewards={rewards} />
        <p className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-muted">
          <span>{t('space.goal.progress', { percent: percent(goal.progress / 100) })}</span>
          <span>
            {t('space.goal.fromTo', {
              start: withUnit(goal.start, goal.unit),
              target: withUnit(goal.target, goal.unit),
            })}
            {goal.targetDate
              ? ` · ${t('space.goal.byDate', { date: date(new Date(`${goal.targetDate}T12:00:00`)) })}`
              : ''}
          </span>
        </p>
      </div>
      <ResultForm goal={goal} onResult={onResult} />
      <div>
        <h3 className="text-sm font-semibold">{t('space.result.recent')}</h3>
        {results.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">{t('space.result.none')}</p>
        ) : (
          <ul className="mt-1.5 divide-y divide-line text-sm">
            {results.slice(0, 5).map((result) => (
              <li
                key={result.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5"
              >
                <span className="text-muted">{relative(new Date(result.recordedAt))}</span>
                <span className="flex items-center gap-2">
                  {result.proof ? (
                    <Badge
                      tone="accent"
                      icon={<ShieldCheck aria-hidden="true" className="size-3" />}
                    >
                      {t('space.proof.label')}
                    </Badge>
                  ) : null}
                  <span className="tabular font-medium">{withUnit(result.value, goal.unit)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The bar from the start to the target, with its milestones at a quarter, half, three quarters. */
function ProgressBar({ progress, reached }: { progress: number; reached: Set<number> }) {
  const { t, percent } = useI18n();
  return (
    <div className="mt-3">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={t('space.goal.progress', { percent: percent(progress / 100) })}
        className="relative h-3 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
        {MILESTONES.filter((m) => m < 100).map((m) => (
          <span
            key={m}
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 bg-surface"
            style={{ left: `${m}%` }}
          />
        ))}
      </div>
      <ul aria-label={t('space.goal.milestones')} className="mt-2 flex flex-wrap gap-1.5">
        {MILESTONES.map((m) => {
          const done = reached.has(m);
          const label = percent(m / 100);
          return (
            <li key={m}>
              <Badge
                tone={done ? 'accent' : 'neutral'}
                icon={done ? <Check aria-hidden="true" className="size-3" /> : undefined}
              >
                <span className="sr-only">
                  {t(done ? 'space.goal.milestoneReached' : 'space.goal.milestoneAhead', {
                    percent: label,
                  })}
                </span>
                <span aria-hidden="true">{label}</span>
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The member's screenshot: being read, read (its fingerprint and numbers), or unreadable. */
type Screenshot =
  | { state: 'reading'; stage: ReadingStage; ratio: number }
  | { state: 'read'; proof: ProofInput }
  | { state: 'failed' };

/**
 * One gesture: where the member stands now, or what they add (with « +1 » for counting). A
 * screenshot can back the number (SPEC Phase 5, point 3): read in the browser, it proposes the
 * numbers it shows; the image never leaves the device.
 */
function ResultForm({
  goal,
  onResult,
}: {
  goal: MemberGoal;
  onResult: (entry: ResultEntry) => Promise<void>;
}) {
  const { t, locale, number, percent } = useI18n();
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'form' | 'one' | null>(null);
  const [failed, setFailed] = useState(false);
  const [shot, setShot] = useState<Screenshot | null>(null);
  // The screenshot being read: a newer choice wins over an older one still being read.
  const reading = useRef(0);
  const adding = goal.entry === 'add';
  const value = parseLocaleNumber(text, locale);
  const usable = value !== null && !(adding && value === 0);
  const proof = shot?.state === 'read' ? shot.proof : null;

  const pick = async (file: File) => {
    const n = ++reading.current;
    setShot({ state: 'reading', stage: 'loading', ratio: 0 });
    try {
      const read = await readScreenshot(file, (stage, ratio) => {
        if (reading.current === n) setShot({ state: 'reading', stage, ratio });
      });
      if (reading.current !== n) return;
      setShot({ state: 'read', proof: read });
      // Where the member stands: the number of the screenshot closest to their last one.
      if (!adding && !text.trim() && read.numbers.length > 0) {
        const closest = read.numbers.reduce((best, candidate) =>
          Math.abs(candidate - goal.current) < Math.abs(best - goal.current) ? candidate : best,
        );
        setText(String(closest));
      }
    } catch {
      if (reading.current === n) setShot({ state: 'failed' });
    }
  };

  const forget = () => {
    reading.current += 1;
    setShot(null);
  };

  const send = async (amount: number, how: 'form' | 'one') => {
    setBusy(how);
    setFailed(false);
    try {
      await onResult({
        goalId: goal.id,
        value: amount,
        ...(proof && how === 'form' ? { proof } : {}),
      });
      setText('');
      if (how === 'form') forget();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (usable && value !== null) void send(value, 'form');
      }}
      className="space-y-3 rounded-xl bg-surface-2 p-3"
      noValidate
    >
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {t(adding ? 'space.result.add' : 'space.result.total')}
        </label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <input
              id={id}
              value={text}
              inputMode="decimal"
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
              className={`${FIELD} tabular w-32`}
            />
            <span className="text-sm text-muted">{goal.unit}</span>
          </div>
          <Button
            type="submit"
            loading={busy === 'form'}
            disabled={!usable || busy !== null || shot?.state === 'reading'}
            icon={<PenLine aria-hidden="true" className="size-4" />}
          >
            {t(adding ? 'space.result.addSave' : 'space.result.save')}
          </Button>
          {adding ? (
            <Button
              variant="secondary"
              loading={busy === 'one'}
              disabled={busy !== null}
              onClick={() => void send(1, 'one')}
              icon={<Plus aria-hidden="true" className="size-4" />}
            >
              {t('space.result.plusOne')}
            </Button>
          ) : null}
        </div>
      </div>

      {shot === null || shot.state === 'failed' ? (
        <label
          className={buttonClass(
            'ghost',
            'sm',
            'cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent',
          )}
        >
          <ImagePlus aria-hidden="true" className="size-4" />
          {t('space.proof.attach')}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void pick(file);
            }}
          />
        </label>
      ) : null}
      {shot?.state === 'failed' ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          {t('space.proof.failed')}
        </p>
      ) : null}
      {shot?.state === 'reading' ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-accent" />
          {t(shot.stage === 'loading' ? 'space.proof.loading' : 'space.proof.reading', {
            percent: percent(shot.ratio),
          })}
        </p>
      ) : null}
      {proof ? (
        <div className="space-y-2 text-sm">
          {proof.numbers.length > 0 ? (
            <>
              <p id={`${id}-numbers`}>{t('space.proof.found')}</p>
              <div
                role="group"
                aria-labelledby={`${id}-numbers`}
                className="flex flex-wrap gap-1.5"
              >
                {proof.numbers.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={value === candidate}
                    onClick={() => setText(String(candidate))}
                    className={`tabular rounded-full border px-2.5 py-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      value === candidate
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line bg-surface hover:bg-surface-2'
                    }`}
                  >
                    {number(candidate)}
                  </button>
                ))}
              </div>
              {value !== null && !proofJustifies(proof, value) ? (
                <p className="text-warning">{t('space.proof.mismatch')}</p>
              ) : null}
            </>
          ) : (
            <p className="text-warning">{t('space.proof.none')}</p>
          )}
          <p className="flex items-start gap-1.5 text-muted">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('space.proof.private')}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={forget}
            icon={<X aria-hidden="true" className="size-4" />}
          >
            {t('space.proof.remove')}
          </Button>
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          {t('common.failed')}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The earned days: those still ahead (each milestone rewards a member once), and those received.
 */
function Rewards({ rewards }: { rewards: MemberSpaceView['rewards'] }) {
  const { plural, percent, date } = useI18n();
  const received = new Set(rewards.received.map((r) => r.percent));
  const ahead = rewards.offered
    ? (
        [
          [50, rewards.offered.at50],
          [100, rewards.offered.at100],
        ] as const
      ).filter(([at, days]) => days > 0 && !received.has(at))
    : [];
  if (ahead.length === 0 && rewards.received.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1 text-sm">
      {ahead.length > 0 ? (
        <li className="flex items-start gap-2">
          <Gift aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>
            {ahead
              .map(([at, days]) =>
                plural('space.rewards.ahead', days, { percent: percent(at / 100) }),
              )
              .join(' · ')}
          </span>
        </li>
      ) : null}
      {rewards.received.map((reward) => (
        <li key={reward.percent} className="flex items-start gap-2 text-muted">
          <Gift aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {plural('space.rewards.received', reward.days, {
            percent: percent(reward.percent / 100),
            date: date(new Date(reward.at)),
          })}
        </li>
      ))}
    </ul>
  );
}

/** The goal reached: well done, and the next one. */
function GoalReached({
  goal,
  rewards,
  onNext,
}: {
  goal: MemberGoal;
  rewards: MemberSpaceView['rewards'];
  onNext: () => void;
}) {
  const { t } = useI18n();
  const withUnit = useWithUnit();
  return (
    <div className="space-y-4">
      <Notice tone="accent" icon={<Trophy aria-hidden="true" className="size-4" />}>
        <p className="font-medium">{t('space.goal.reached')}</p>
        <p className="mt-0.5 text-muted">
          {t('space.goal.reachedBody', { target: withUnit(goal.target, goal.unit) })}
        </p>
      </Notice>
      <ProgressBar progress={100} reached={new Set(goal.milestones.map((m) => m.percent))} />
      <Rewards rewards={rewards} />
      <Button onClick={onNext} icon={<Flag aria-hidden="true" className="size-4" />}>
        {t('space.goal.next')}
      </Button>
    </div>
  );
}

const BADGES: Readonly<Record<BadgeCode, { icon: LucideIcon; name: MessageKey }>> = {
  first_result: { icon: PenLine, name: 'badge.first_result' },
  streak_7_days: { icon: Flame, name: 'badge.streak_7_days' },
  first_proof: { icon: ShieldCheck, name: 'badge.first_proof' },
  milestone_25: { icon: Flag, name: 'badge.milestone_25' },
  milestone_50: { icon: Mountain, name: 'badge.milestone_50' },
  milestone_75: { icon: Rocket, name: 'badge.milestone_75' },
  milestone_100: { icon: Trophy, name: 'badge.milestone_100' },
  mentor: { icon: HeartHandshake, name: 'badge.mentor' },
  rescuer: { icon: LifeBuoy, name: 'badge.rescuer' },
};

/** The badges every member can earn today; the others show once earned. */
const ALWAYS_SHOWN: readonly BadgeCode[] = [
  'first_result',
  'first_proof',
  'streak_7_days',
  'milestone_25',
  'milestone_50',
  'milestone_75',
  'milestone_100',
];

function useBadgeHint(): (code: BadgeCode) => string {
  const { t, percent } = useI18n();
  return (code) => {
    if (code.startsWith('milestone_')) {
      return t('badge.milestone.hint', { percent: percent(Number(code.slice(10)) / 100) });
    }
    const hints: Partial<Record<BadgeCode, MessageKey>> = {
      first_result: 'badge.first_result.hint',
      streak_7_days: 'badge.streak_7_days.hint',
      first_proof: 'badge.first_proof.hint',
      mentor: 'badge.mentor.hint',
      rescuer: 'badge.rescuer.hint',
    };
    const key = hints[code];
    return key ? t(key) : '';
  };
}

/** The badges earned, and those ahead with how to earn them (`ahead`: beyond the usual ones). */
function BadgesCard({ badges, ahead }: { badges: EarnedBadge[]; ahead: readonly BadgeCode[] }) {
  const { t, date } = useI18n();
  const hint = useBadgeHint();
  const earned = new Map(badges.map((b) => [b.code, b.awardedAt]));
  const shown = [...new Set<BadgeCode>([...badges.map((b) => b.code), ...ALWAYS_SHOWN, ...ahead])];
  const ordered = [
    ...shown.filter((code) => earned.has(code)),
    ...shown.filter((code) => !earned.has(code)),
  ];
  return (
    <Card
      icon={<Sparkles aria-hidden="true" className="size-4" />}
      title={t('space.badges.title')}
      description={t('space.badges.body')}
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {ordered.map((code) => {
          const at = earned.get(code);
          const Icon = at ? BADGES[code].icon : Lock;
          return (
            <li
              key={code}
              className={`flex items-start gap-3 rounded-xl border p-3 ${
                at ? 'border-accent/40 bg-accent-soft' : 'border-line'
              }`}
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                  at ? 'bg-accent text-on-accent' : 'bg-surface-2 text-muted'
                }`}
              >
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="min-w-0 text-sm">
                <span className="block font-medium">{t(BADGES[code].name)}</span>
                <span className="block text-muted">
                  {at
                    ? t('space.badges.earned', { date: date(new Date(at)) })
                    : `${t('space.badges.ahead')} · ${hint(code)}`}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** A milestone the member may share, and how. */
interface ShareOffer {
  announce: NonNullable<MemberSpaceView['announce']>;
  goal: MemberGoal;
  percent: Milestone;
  /** The team's trial: nothing is posted. */
  trial: boolean;
  send: (request: ShareRequest) => Promise<ShareAnswer>;
}

const SHARE_OUTCOMES: Readonly<Record<ShareAnswer['status'], MessageKey>> = {
  sent: 'space.share.sent',
  waiting: 'space.share.waiting',
  simulated: 'space.share.simulated',
  blocked: 'space.share.failed',
  failed: 'space.share.failed',
  duplicate: 'space.share.duplicate',
};

/**
 * Sharing a milestone in the community's chat (SPEC Phase 5, point 4): the exact words first,
 * in the community's language, then one tap. Nothing goes without it.
 */
function SharePrompt({ offer }: { offer: ShareOffer }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'sending' | 'error' | ShareAnswer['status']>('idle');
  const words = announcementText(offer.announce.locale, {
    firstName: offer.announce.firstName,
    goal: offer.goal.title,
    percent: offer.percent,
  });
  if (state !== 'idle' && state !== 'sending' && state !== 'error') {
    const key = offer.trial ? 'space.share.trial' : SHARE_OUTCOMES[state];
    return (
      <p className="mt-2 flex items-center gap-1.5 font-medium">
        <Megaphone aria-hidden="true" className="size-4 shrink-0" />
        {t(key, { place: offer.announce.place })}
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface p-3">
      <p className="font-medium">{t('space.share.title')}</p>
      <blockquote className="rounded-md bg-surface-2 px-3 py-2">{words}</blockquote>
      <p className="text-muted">{t('space.share.where', { place: offer.announce.place })}</p>
      <Button
        size="sm"
        loading={state === 'sending'}
        icon={<Megaphone aria-hidden="true" className="size-4" />}
        onClick={() => {
          setState('sending');
          offer.send({ goalId: offer.goal.id, percent: offer.percent }).then(
            (answer) => setState(answer.status),
            () => setState('error'),
          );
        }}
      >
        {t('space.share.action')}
      </Button>
      {state === 'error' ? (
        <p role="alert" className="flex items-center gap-1.5 text-danger">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          {t('common.failed')}
        </p>
      ) : null}
    </div>
  );
}

const PROOF_OUTCOMES: Readonly<Record<NonNullable<ResultAnswer['proof']>, MessageKey>> = {
  justified: 'space.proof.justified',
  declared: 'space.proof.declared',
  duplicate: 'space.proof.duplicate',
};

/** What a result or an opening brought: the goal, a milestone, new badges, or thanks. */
function CelebrationNotice({
  celebration,
  onClose,
  share,
}: {
  celebration: Celebration;
  onClose: () => void;
  /** The milestone to share with the community, when the creator chose where. */
  share: ShareOffer | null;
}) {
  const { t, plural, percent } = useI18n();
  const highest = celebration.milestones.at(-1);
  const lines: string[] = [];
  if (celebration.achieved) lines.push(t('space.celebrate.achieved'));
  else if (highest) lines.push(t('space.celebrate.milestone', { percent: percent(highest / 100) }));
  if (celebration.earnedDays > 0) {
    lines.push(plural('space.celebrate.days', celebration.earnedDays));
  }
  for (const badge of celebration.badges) {
    lines.push(t('space.celebrate.badge', { badge: t(BADGES[badge].name) }));
  }
  const festive = lines.length > 0;
  if (!festive && celebration.recorded) lines.push(t('space.celebrate.saved'));
  if (celebration.proof) lines.push(t(PROOF_OUTCOMES[celebration.proof]));
  if (lines.length === 0) return null;
  return (
    <div role="status">
      <Notice
        tone={festive ? 'accent' : 'info'}
        icon={
          festive ? (
            <PartyPopper aria-hidden="true" className="size-4" />
          ) : (
            <Check aria-hidden="true" className="size-4" />
          )
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            {lines.map((line, i) => (
              <p key={line} className={i === 0 && festive ? 'font-medium' : ''}>
                {line}
              </p>
            ))}
            {share ? <SharePrompt offer={share} /> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('space.celebrate.close')}
            className="rounded-md p-0.5 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      </Notice>
    </div>
  );
}
