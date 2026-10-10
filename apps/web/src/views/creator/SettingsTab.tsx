import {
  DEFAULT_HIGH_FROM,
  DEFAULT_MEDIUM_FROM,
  NICHES,
  NICHE_PRESETS,
  RISK_FACTORS,
  isNiche,
  normalizeWeights,
  type Niche,
  type RiskSettingsView,
  type RiskWeights,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import {
  Check,
  CircleAlert,
  CircleCheck,
  Code,
  Copy,
  Languages,
  RotateCcw,
  Save,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DEMO_WHOP_ID, putJson, useApi } from '../../api';
import { BadgeCard } from '../../components/BadgeCard';
import { DataCard, TeamCard } from '../../components/DataCards';
import { LegalCard } from '../../components/Legal';
import { legalPagesEnabled } from '../../features';
import { LEVELS } from '../../components/Risk';
import { ErrorPanel, Loading } from '../../components/Status';
import { useDemo } from '../../demoMode';
import { useI18n } from '../../i18n';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { LanguageSelect } from '../../ui/LanguageSelect';
import { FIELD, NumberField, Row } from '../../components/SettingsParts';
import { useCreatorData } from '../CreatorView';
import { Announcements } from './Announcements';
import { Buddies } from './Buddies';
import { Rescues } from './Rescues';
import { EarnedDays } from './EarnedDays';
import { GoalProposals } from './GoalProposals';

const NICHE_LABELS: Readonly<Record<Niche, MessageKey>> = {
  trading: 'niche.trading',
  fitness: 'niche.fitness',
  online_business: 'niche.online_business',
  coaching: 'niche.coaching',
  ecommerce: 'niche.ecommerce',
  personal_development: 'niche.personal_development',
  other: 'niche.other',
};

const FACTORS: Readonly<Record<keyof RiskWeights, { name: MessageKey; hint: MessageKey }>> = {
  recency: { name: 'factor.recency', hint: 'factor.recency.hint' },
  frequency: { name: 'factor.frequency', hint: 'factor.frequency.hint' },
  progress: { name: 'factor.progress', hint: 'factor.progress.hint' },
  payment: { name: 'factor.payment', hint: 'factor.payment.hint' },
  friction: { name: 'factor.friction', hint: 'factor.friction.hint' },
};

/** The Worker scores again in the background after a save: the members are read after this. */
const RELOAD_AFTER_MS = 4_000;

/**
 * The creator's settings (SPEC Phase 6, point 12), one tab each: how the score is computed
 * (Phase 3), how the automations leave (Phase 4, ActionSettings), and the member space: the
 * goals proposed to members, the earned days, the buddies, the rescue challenges and the
 * announcements (Phase 5).
 */
function WithRiskSettings({ children }: { children: (settings: RiskSettingsView) => ReactNode }) {
  const { api } = useCreatorData();
  const { state, retry } = useApi<RiskSettingsView>(`${api}/settings/risk`);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <>{children(state.data)}</>;
}

/**
 * Settings › General: the language (the only place it changes, English by default), the « Verified
 * retention » badge (SPEC 6.11), the team and the community's data (6.12), the legal pages (8.1),
 * and what a developer or Whop's support asks for, the community's id. There is no theme to choose: dark is StayPut's
 * only one.
 */
export function GeneralSettingsTab() {
  const { t } = useI18n();
  const { companyId: id, companyName, api, integrations } = useCreatorData();
  // The demo shows a Whop-shaped id, the one in its badge's addresses and its export.
  const companyId = useDemo() ? DEMO_WHOP_ID : id;
  const languageId = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-6">
      <Card
        icon={<Languages aria-hidden="true" className="size-4" />}
        title={<span id={languageId}>{t('settings.language')}</span>}
        description={t('settings.language.hint')}
      >
        <LanguageSelect labelledBy={languageId} />
        <p className="mt-3 text-sm">{t('settings.language.members')}</p>
      </Card>
      <BadgeCard
        api={api}
        integrations={integrations.state.status === 'ready' ? integrations.state.data : null}
      />
      <TeamCard api={api} />
      <DataCard api={api} companyId={companyId} companyName={companyName} />
      {legalPagesEnabled() ? <LegalCard /> : null}
      <Card
        icon={<Code aria-hidden="true" className="size-4" />}
        title={t('settings.developer')}
        description={t('settings.developer.hint')}
      >
        <dl className="flex flex-wrap items-center justify-between gap-3">
          <dt className="text-sm">{t('settings.developer.companyId')}</dt>
          <dd className="flex items-center gap-2">
            <code className="tabular rounded-md border border-line px-2 py-1 text-sm text-fg">
              {companyId}
            </code>
            <Button
              variant="ghost"
              size="sm"
              icon={
                copied ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : (
                  <Copy aria-hidden="true" className="size-4" />
                )
              }
              onClick={() => {
                void navigator.clipboard?.writeText(companyId).then(
                  () => setCopied(true),
                  () => undefined,
                );
              }}
            >
              {t(copied ? 'settings.developer.copied' : 'settings.developer.copy')}
            </Button>
          </dd>
        </dl>
      </Card>
    </div>
  );
}

/** Settings › Risk score: the niche, the weight of each sign, the thresholds. */
export function RiskSettingsTab() {
  return (
    <WithRiskSettings>{(settings) => <RiskSettingsForm initial={settings} />}</WithRiskSettings>
  );
}

/** Settings › Member space: the niche saved in Risk score decides the goals proposed. */
export function SpaceSettingsTab() {
  return (
    <WithRiskSettings>
      {(settings) => (
        <div className="space-y-6">
          <GoalProposals niche={settings.niche} />
          <EarnedDays />
          <Buddies />
          <Rescues />
          <Announcements />
        </div>
      )}
    </WithRiskSettings>
  );
}

/** The form as typed: the weights as points of importance (any sum), the numbers as text. */
interface Draft {
  niche: Niche;
  points: RiskWeights;
  recency: string;
  mediumFrom: string;
  highFrom: string;
}

const pointsOf = (weights: RiskWeights) =>
  Object.fromEntries(
    RISK_FACTORS.map((f) => [f, Math.round(weights[f] * 100)]),
  ) as unknown as RiskWeights;

function toDraft(view: RiskSettingsView): Draft {
  return {
    niche: view.niche,
    points: pointsOf(view.weights),
    recency: String(view.recencyThresholdDays),
    mediumFrom: String(view.mediumFrom),
    highFrom: String(view.highFrom),
  };
}

function whole(text: string, min: number, max: number): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/** The settings as the Worker takes them (the same limits it checks), or null. */
function toView(draft: Draft): RiskSettingsView | null {
  const recency = whole(draft.recency, 1, 90);
  const mediumFrom = whole(draft.mediumFrom, 1, 99);
  const highFrom = whole(draft.highFrom, 2, 100);
  if (recency === null || mediumFrom === null || highFrom === null) return null;
  if (mediumFrom >= highFrom) return null;
  return {
    niche: draft.niche,
    weights: normalizeWeights(draft.points),
    recencyThresholdDays: recency,
    mediumFrom,
    highFrom,
  };
}

function sameSettings(a: RiskSettingsView, b: RiskSettingsView): boolean {
  return (
    a.niche === b.niche &&
    a.recencyThresholdDays === b.recencyThresholdDays &&
    a.mediumFrom === b.mediumFrom &&
    a.highFrom === b.highFrom &&
    RISK_FACTORS.every((f) => Math.abs(a.weights[f] - b.weights[f]) < 1e-9)
  );
}

function RiskSettingsForm({ initial }: { initial: RiskSettingsView }) {
  const { t, percent, number } = useI18n();
  const { api, members } = useCreatorData();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [saves, setSaves] = useState(0);
  const ids = useId();

  // The members' new scores, a moment after each save (the latest reload function).
  const reloadMembers = useRef(members.reload);
  useEffect(() => {
    reloadMembers.current = members.reload;
  }, [members.reload]);
  useEffect(() => {
    if (saves === 0) return;
    const timer = setTimeout(() => reloadMembers.current(), RELOAD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [saves]);

  const view = toView(draft);
  const changed = view !== null && !sameSettings(view, saved);
  // What each weight will count for once brought back to a sum of 1 (all at zero: the defaults).
  const shares = normalizeWeights(draft.points);
  const recency = whole(draft.recency, 1, 90);
  const mediumFrom = whole(draft.mediumFrom, 1, 99);
  const highFrom = whole(draft.highFrom, 2, 100);
  const levelsValid = mediumFrom !== null && highFrom !== null && mediumFrom < highFrom;

  const edit = (update: (current: Draft) => Draft) => {
    setDraft(update);
    if (status !== 'saving') setStatus('idle');
  };
  const applyNiche = (niche: Niche, levelsToo = false) =>
    edit((current) => ({
      ...current,
      niche,
      points: pointsOf(NICHE_PRESETS[niche].weights),
      recency: String(NICHE_PRESETS[niche].recencyThresholdDays),
      ...(levelsToo
        ? { mediumFrom: String(DEFAULT_MEDIUM_FROM), highFrom: String(DEFAULT_HIGH_FROM) }
        : {}),
    }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!view || !changed) return;
    setStatus('saving');
    try {
      const next = await putJson<RiskSettingsView>(`${api}/settings/risk`, view);
      setSaved(next);
      setDraft(toDraft(next));
      setStatus('saved');
      setSaves((n) => n + 1);
    } catch {
      setStatus('failed');
    }
  };

  return (
    <Card
      icon={<SlidersHorizontal aria-hidden="true" className="size-4" />}
      title={t('riskSettings.title')}
      description={t('riskSettings.description')}
    >
      <form onSubmit={(event) => void submit(event)} className="divide-y divide-line" noValidate>
        <Row label={t('riskSettings.niche')} htmlFor={`${ids}-niche`}>
          <select
            id={`${ids}-niche`}
            value={draft.niche}
            onChange={(event) => {
              if (isNiche(event.target.value)) applyNiche(event.target.value);
            }}
            className={`${FIELD} w-full sm:w-72`}
            aria-describedby={`${ids}-niche-hint`}
          >
            {NICHES.map((niche) => (
              <option key={niche} value={niche}>
                {t(NICHE_LABELS[niche])}
              </option>
            ))}
          </select>
          <p id={`${ids}-niche-hint`} className="mt-1.5 text-sm text-muted">
            {t('riskSettings.nicheHint')}
          </p>
        </Row>

        <Row label={t('riskSettings.weights')} labelId={`${ids}-weights`}>
          <div role="group" aria-labelledby={`${ids}-weights`} className="space-y-4">
            <p className="text-sm text-muted">{t('riskSettings.weightsHint')}</p>
            {RISK_FACTORS.map((factor) => {
              const id = `${ids}-weight-${factor}`;
              const share = percent(shares[factor]);
              return (
                <div
                  key={factor}
                  className="grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-x-4 gap-y-1.5"
                >
                  <div className="min-w-0">
                    <label htmlFor={id} className="text-sm font-medium">
                      {t(FACTORS[factor].name)}
                    </label>
                    <p id={`${id}-hint`} className="text-xs text-muted">
                      {t(FACTORS[factor].hint)}
                    </p>
                  </div>
                  <output
                    htmlFor={id}
                    className="tabular row-span-2 self-end pb-0.5 text-end text-sm font-semibold"
                  >
                    {share}
                  </output>
                  <input
                    id={id}
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={draft.points[factor]}
                    aria-describedby={`${id}-hint`}
                    aria-valuetext={share}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      edit((current) => ({
                        ...current,
                        points: { ...current.points, [factor]: value },
                      }));
                    }}
                    className="w-full accent-accent"
                  />
                </div>
              );
            })}
          </div>
        </Row>

        <Row label={t('riskSettings.recency')} htmlFor={`${ids}-threshold`}>
          <div className="flex items-center gap-2">
            <input
              id={`${ids}-threshold`}
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              value={draft.recency}
              aria-invalid={recency === null}
              aria-describedby={`${ids}-threshold-hint`}
              onChange={(event) => {
                const value = event.target.value;
                edit((current) => ({ ...current, recency: value }));
              }}
              className={`${FIELD} tabular w-24`}
            />
            <span className="text-sm text-muted">{t('riskSettings.days')}</span>
          </div>
          <p
            id={`${ids}-threshold-hint`}
            className={`mt-1.5 text-sm ${recency === null ? 'text-danger' : 'text-muted'}`}
          >
            {t(recency === null ? 'riskSettings.recencyInvalid' : 'riskSettings.recencyHint')}
          </p>
        </Row>

        <Row label={t('riskSettings.levels')} labelId={`${ids}-levels`}>
          <div role="group" aria-labelledby={`${ids}-levels`} className="space-y-3">
            <div className="flex flex-wrap gap-4">
              <NumberField
                id={`${ids}-medium`}
                label={t('riskSettings.mediumFrom')}
                value={draft.mediumFrom}
                invalid={!levelsValid}
                min={1}
                max={99}
                onChange={(value) => edit((current) => ({ ...current, mediumFrom: value }))}
              />
              <NumberField
                id={`${ids}-high`}
                label={t('riskSettings.highFrom')}
                value={draft.highFrom}
                invalid={!levelsValid}
                min={2}
                max={100}
                onChange={(value) => edit((current) => ({ ...current, highFrom: value }))}
              />
            </div>
            {levelsValid ? (
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['low', 0, mediumFrom - 1],
                    ['medium', mediumFrom, highFrom - 1],
                    ['high', highFrom, 100],
                  ] as const
                ).map(([level, from, to]) => {
                  const { label, Icon } = LEVELS[level];
                  return (
                    <Badge key={level} icon={<Icon aria-hidden="true" className="size-3" />}>
                      {t('riskSettings.range', {
                        level: t(label),
                        from: number(from),
                        to: number(to),
                      })}
                    </Badge>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-danger">{t('riskSettings.levelsInvalid')}</p>
            )}
            <p className="text-sm text-muted">{t('riskSettings.departure')}</p>
          </div>
        </Row>

        <div className="flex flex-wrap items-center gap-3 pt-5">
          <Button
            type="submit"
            loading={status === 'saving'}
            disabled={!changed}
            icon={<Save aria-hidden="true" className="size-4" />}
          >
            {t('common.save')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => applyNiche(draft.niche, true)}
            icon={<RotateCcw aria-hidden="true" className="size-4" />}
          >
            {t('riskSettings.reset')}
          </Button>
          <p role="status" className="text-sm">
            {status === 'saved' ? (
              <span className="flex items-center gap-1.5 text-accent">
                <CircleCheck aria-hidden="true" className="size-4" />
                {t('riskSettings.saved')}
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
