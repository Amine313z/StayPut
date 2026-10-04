import {
  PLATFORM_SIGNALS,
  SIGNAL_BITS,
  SIGNAL_POINTS_MAX,
  scoreDistribution,
  type AccountPlatform,
  type PlatformSignalId,
  type PlatformSignals,
  type PlatformSignalsView,
  type RiskLevel,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { SlidersHorizontal } from 'lucide-react';
import { useId, useState } from 'react';
import { putJson } from '../../../api';
import { failureText } from '../../../components/MemberActions';
import { LEVELS } from '../../../components/Risk';
import { useI18n } from '../../../i18n';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { ScoreHistogram } from '../../../ui/charts/ScoreHistogram';
import { Switch } from '../../../ui/Switch';
import { useToast } from '../../../ui/Toast';
import { useCreatorData } from '../../CreatorView';

/** The slider's steps, in points. */
const STEP = 5;

const TITLES: Readonly<Record<PlatformSignalId, { discord: MessageKey; telegram: MessageKey }>> = {
  silent: { discord: 'signals.silent.title', telegram: 'signals.silent.title' },
  drop: { discord: 'signals.drop.title', telegram: 'signals.drop.title' },
  left: { discord: 'signals.left.title.discord', telegram: 'signals.left.title.telegram' },
};

const DESCRIPTIONS: Readonly<
  Record<PlatformSignalId, { discord: MessageKey; telegram: MessageKey }>
> = {
  silent: { discord: 'signals.silent.description', telegram: 'signals.silent.description' },
  drop: { discord: 'signals.drop.description', telegram: 'signals.drop.description' },
  left: {
    discord: 'signals.left.description.discord',
    telegram: 'signals.left.description.telegram',
  },
};

/** The levels the preview counts, the riskiest first. */
const PREVIEW_LEVELS: readonly RiskLevel[] = ['scheduled_departure', 'high', 'medium', 'low'];

/**
 * The platform's signals (brief v4 §9.6): what it says of a member, each turned on or off, each
 * weighing the points the creator gives it (0 to 30) on top of the score's five factors. As they
 * move, the preview spreads the members' scores these settings would give beside today's, and
 * says how many members change level: computed in the browser from what each score is made of
 * (scoreDistribution), never by asking the server. Saved, every score is due again.
 */
export function SignalsPanel({
  platform,
  view,
  onSaved,
}: {
  platform: AccountPlatform;
  view: PlatformSignalsView;
  onSaved: () => void;
}) {
  const { t, plural, number } = useI18n();
  const { api, demo } = useCreatorData();
  const toast = useToast();
  const ids = useId();
  // What was just saved counts as saved until the dashboard reads it back (the page then shows
  // the panel anew: its key is the settings saved).
  const [justSaved, setJustSaved] = useState<PlatformSignals | null>(null);
  const saved = justSaved ?? view.settings[platform];
  const settings = { ...view.settings, [platform]: saved };
  const [draft, setDraft] = useState<PlatformSignals>(saved);
  const [saving, setSaving] = useState(false);
  const changed = PLATFORM_SIGNALS.some(
    (id) => draft[id].on !== saved[id].on || draft[id].points !== saved[id].points,
  );
  const groups = view.groups.map(([made, discord, telegram, rule, count]) => ({
    base: made,
    discord,
    telegram,
    rule,
    count,
  }));
  const thresholds = { mediumFrom: view.mediumFrom, highFrom: view.highFrom };
  const now = scoreDistribution(groups, settings, thresholds);
  const next = scoreDistribution(groups, { ...settings, [platform]: draft }, thresholds);
  const holding = (id: PlatformSignalId) =>
    groups
      .filter((g) => (g[platform] & SIGNAL_BITS[id]) !== 0)
      .reduce((total, g) => total + g.count, 0);
  const moved = PREVIEW_LEVELS.filter((level) => now.levels[level] !== next.levels[level]);
  const name = t(platform === 'discord' ? 'sources.discord.name' : 'sources.telegram.name');

  const set = (id: PlatformSignalId, change: Partial<PlatformSignals[PlatformSignalId]>) =>
    setDraft((current) => ({ ...current, [id]: { ...current[id], ...change } }));
  const save = async () => {
    setSaving(true);
    try {
      await putJson<{ settings: Record<AccountPlatform, PlatformSignals> }>(
        `${api}/platforms/${platform}/signals`,
        draft,
      );
      setJustSaved(draft);
      toast({
        title: t('signals.saved'),
        body: t(demo ? 'signals.saved.demo' : 'signals.saved.body'),
      });
      onSaved();
    } catch (error) {
      toast({ title: t('signals.saveFailed'), body: failureText(error, t) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      icon={<SlidersHorizontal aria-hidden="true" className="size-4" />}
      title={t('signals.title')}
      description={t('signals.description', { platform: name })}
    >
      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <ul className="space-y-5" data-signals={platform}>
          {PLATFORM_SIGNALS.map((id) => {
            const signal = draft[id];
            const title = `${ids}-${id}-title`;
            const description = `${ids}-${id}-description`;
            return (
              <li key={id} data-signal={id} data-on={signal.on} className="flex gap-4">
                <Switch
                  checked={signal.on}
                  onChange={(on) => set(id, { on })}
                  labelledBy={title}
                  describedBy={description}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p id={title} className="text-sm font-medium text-fg">
                      {t(TITLES[id][platform])}
                    </p>
                    <p className="text-xs text-subtle">{plural('signals.holding', holding(id))}</p>
                  </div>
                  <p id={description} className="mt-0.5 text-sm text-muted">
                    {t(DESCRIPTIONS[id][platform], { platform: name })}
                  </p>
                  <label
                    className={`mt-3 flex items-center gap-3 transition-opacity duration-200 ease-brand ${
                      signal.on ? '' : 'opacity-50'
                    }`}
                  >
                    <span className="sr-only">
                      {t('signals.weight', { signal: t(TITLES[id][platform]) })}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={SIGNAL_POINTS_MAX}
                      step={STEP}
                      value={signal.points}
                      disabled={!signal.on}
                      aria-valuetext={t('signals.points', { points: number(signal.points) })}
                      onChange={(event) => set(id, { points: Number(event.target.value) })}
                      className="h-1.5 w-full max-w-64 cursor-pointer accent-turq-300 disabled:cursor-not-allowed"
                    />
                    <span className="num w-20 shrink-0 text-sm text-fg">
                      {t('signals.points', { points: number(signal.points) })}
                    </span>
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="min-w-0" data-preview="">
          <p className="text-sm font-medium text-fg">{t('signals.preview.title')}</p>
          <div className="mt-4">
            <ScoreHistogram
              label={t('signals.preview.title')}
              now={now.bins}
              next={next.bins}
              thresholds={thresholds}
              labels={{
                now: t('signals.preview.now'),
                next: t('signals.preview.next'),
                medium: t(LEVELS.medium.label),
                high: t(LEVELS.high.label),
                range: t('signals.preview.range'),
              }}
            />
          </div>
          <p className="mt-4 text-sm text-muted" aria-live="polite" data-preview-moved="">
            {moved.length === 0
              ? t('signals.preview.same')
              : moved
                  .map((level) =>
                    t('signals.preview.change', {
                      level: t(LEVELS[level].label),
                      from: number(now.levels[level]),
                      to: number(next.levels[level]),
                    }),
                  )
                  .join(' · ')}
          </p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-5">
        <Button onClick={() => void save()} loading={saving} disabled={!changed}>
          {t('signals.save')}
        </Button>
        {changed ? (
          <Button variant="ghost" onClick={() => setDraft(saved)} disabled={saving}>
            {t('signals.reset')}
          </Button>
        ) : null}
        {changed ? <span className="text-xs text-subtle">{t('signals.unsaved')}</span> : null}
      </div>
    </Card>
  );
}
