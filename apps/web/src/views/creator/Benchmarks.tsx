import type { BenchmarksView } from '@stayput/core';
import { Users } from 'lucide-react';
import { useId, useState } from 'react';
import { putJson, useApi } from '../../api';
import { failureText } from '../../components/MemberActions';
import { useI18n } from '../../i18n';
import { Skeleton } from '../../ui/Skeleton';
import { Switch } from '../../ui/Switch';
import { ChartTable } from '../../ui/charts/ChartTable';
import { useToast } from '../../ui/Toast';

/**
 * Analytics › Overview, « Communities like yours » (SPEC Phase 6.10): the community's retention
 * after 30, 60 and 90 days next to its niche's, once it shares its own, anonymously. The niche's
 * figure shows from 5 communities sharing; never a name, never one community's figures.
 */
export function Benchmarks({ api }: { api: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const titleId = useId();
  const switchId = useId();
  const { state } = useApi<BenchmarksView>(`${api}/benchmarks`);
  const [saved, setSaved] = useState<BenchmarksView | null>(null);
  const [busy, setBusy] = useState(false);
  // Analytics stands without it: a failed read leaves the section out.
  if (state.status === 'error') return null;
  const view = saved ?? (state.status === 'ready' ? state.data : null);
  const niche = view ? t(`niche.${view.niche}`) : '';
  const change = async (optedIn: boolean) => {
    setBusy(true);
    try {
      setSaved(await putJson<BenchmarksView>(`${api}/benchmarks`, { optedIn }));
    } catch (error) {
      toast({ tone: 'error', title: failureText(error, t) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby={titleId}
      data-benchmarks=""
      className="space-y-5 border-t border-line pt-8"
    >
      <header className="flex flex-col gap-3 @3xl:flex-row @3xl:items-start @3xl:justify-between">
        <div className="min-w-0 max-w-2xl">
          <h2 id={titleId} className="title-section flex items-center gap-2">
            <Users aria-hidden="true" className="size-4 text-accent" />
            {t('bench.title')}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {view ? t('bench.description', { niche }) : <Skeleton className="h-4 w-72" />}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span id={switchId} className="text-sm font-medium text-fg">
            {t('bench.switch')}
          </span>
          {view ? (
            <Switch
              checked={view.optedIn}
              onChange={(optedIn) => void change(optedIn)}
              labelledBy={switchId}
              busy={busy}
            />
          ) : (
            <Skeleton className="h-6 w-10 rounded-full" />
          )}
        </div>
      </header>
      {view === null ? (
        <Skeleton className="h-28 w-full rounded-xl" />
      ) : (
        <>
          {view.optedIn ? <Comparison view={view} niche={niche} /> : null}
          <p className="text-[0.8125rem] text-subtle">
            {view.optedIn ? null : `${t('bench.off')} `}
            {t('bench.privacy', { minimum: view.minimum })}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Each horizon: the community's share and its niche's, as two thin bars on one scale, and the
 * same figures as a table for screen readers.
 */
function Comparison({ view, niche }: { view: BenchmarksView; niche: string }) {
  const { t, percent, number } = useI18n();
  const missing = view.horizons.every((h) => h.niche === null);
  const nicheLabel = t('bench.niche', { niche });
  return (
    <div className="space-y-4">
      {/* Two series: the legend names them, the bars carry their figures too. */}
      <ul aria-hidden="true" className="flex flex-wrap gap-4 text-[0.8125rem] text-muted">
        <li className="flex items-center gap-2">
          <span className="h-2 w-4 rounded-full bg-turq-300" />
          {t('bench.you')}
        </li>
        <li className="flex items-center gap-2">
          <span className="h-2 w-4 rounded-full bg-white-100/35" />
          {nicheLabel}
        </li>
      </ul>
      <div aria-hidden="true" className="space-y-4">
        {view.horizons.map((h) => {
          const points =
            h.mine !== null && h.niche !== null ? Math.round((h.mine - h.niche) * 100) : null;
          return (
            <div
              key={h.days}
              data-horizon={h.days}
              className="grid grid-cols-1 gap-x-6 gap-y-2 @xl:grid-cols-[10rem_minmax(0,1fr)]"
            >
              <div className="text-sm">
                <p className="font-medium text-fg">{t('bench.after', { days: number(h.days) })}</p>
                {points !== null ? (
                  <p className="text-[0.8125rem] text-subtle">
                    {points === 0
                      ? t('bench.diff.same')
                      : t(points > 0 ? 'bench.diff.up' : 'bench.diff.down', {
                          points: number(Math.abs(points)),
                        })}
                  </p>
                ) : null}
              </div>
              <div className="min-w-0 space-y-1.5 self-center">
                <Bar
                  value={h.mine}
                  tone="bg-turq-300"
                  label={h.mine === null ? t('bench.mine.none') : percent(h.mine)}
                />
                <Bar
                  value={h.niche}
                  tone="bg-white-100/35"
                  label={h.niche === null ? '—' : percent(h.niche)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <ChartTable>
        <caption>{t('bench.chart')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('bench.horizon')}</th>
            <th scope="col">{t('bench.you')}</th>
            <th scope="col">{nicheLabel}</th>
          </tr>
        </thead>
        <tbody>
          {view.horizons.map((h) => (
            <tr key={h.days}>
              <th scope="row">{t('bench.after', { days: number(h.days) })}</th>
              <td>{h.mine === null ? t('bench.mine.none') : percent(h.mine)}</td>
              <td>{h.niche === null ? '—' : percent(h.niche)}</td>
            </tr>
          ))}
        </tbody>
      </ChartTable>
      {missing ? (
        <p className="text-sm text-fg">{t('bench.notEnough', { niche, minimum: view.minimum })}</p>
      ) : null}
    </div>
  );
}

function Bar({ value, tone, label }: { value: number | null; tone: string; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 min-w-0 flex-1 rounded-full bg-surface-2">
        {value !== null ? (
          <div
            className={`h-2 rounded-full ${tone}`}
            style={{ width: `${Math.max(2, Math.round(value * 100))}%` }}
          />
        ) : null}
      </div>
      <span className="num min-w-10 shrink-0 text-end text-[0.8125rem] text-fg">{label}</span>
    </div>
  );
}
