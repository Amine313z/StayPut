import {
  BADGE_MIN_MEMBERS,
  badgeText,
  retentionBadgeSvg,
  type BadgeView,
  type IntegrationsStatus,
} from '@stayput/core';
import { BadgeCheck, Check, Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { putJson, useApi } from '../api';
import { useI18n } from '../i18n';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';
import { Skeleton } from '../ui/Skeleton';
import { Switch } from '../ui/Switch';
import { useToast } from '../ui/Toast';
import { failureText } from './MemberActions';

/**
 * Settings › General, the « Verified retention » badge (SPEC Phase 6.11): on or off; once on, the
 * badge as it shows (drawn here, the Worker serves the same drawing), the code to paste on a sales
 * page, and its verification page. Until 10 members joined more than 90 days ago, it shows nowhere.
 */
export function BadgeCard({
  api,
  integrations,
}: {
  api: string;
  integrations: IntegrationsStatus | null;
}) {
  const { t, number } = useI18n();
  const toast = useToast();
  const switchId = useId();
  const codeId = useId();
  const { state } = useApi<BadgeView>(`${api}/badge`);
  const [saved, setSaved] = useState<BadgeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const view = saved ?? (state.status === 'ready' ? state.data : null);
  const change = async (enabled: boolean) => {
    setBusy(true);
    try {
      setSaved(await putJson<BadgeView>(`${api}/badge`, { enabled }));
    } catch (error) {
      toast({ tone: 'error', title: failureText(error, t) });
    } finally {
      setBusy(false);
    }
  };
  const retention = view?.retention ?? null;
  const alt = view && retention !== null ? badgeText(view.locale, retention) : '';
  const code =
    view && retention !== null
      ? `<a href="${view.verifyUrl}" target="_blank" rel="noopener"><img src="${view.badgeUrl}" alt="${alt}" height="20"></a>`
      : '';
  return (
    <Card
      icon={<BadgeCheck aria-hidden="true" className="size-4" />}
      title={t('badge.title')}
      description={t('badge.description')}
      actions={
        <span className="flex items-center gap-3">
          <span id={switchId} className="text-sm font-medium text-fg">
            {t('badge.switch')}
          </span>
          {view ? (
            <Switch
              checked={view.enabled}
              onChange={(enabled) => void change(enabled)}
              labelledBy={switchId}
              busy={busy}
            />
          ) : (
            <Skeleton className="h-6 w-10 rounded-full" />
          )}
        </span>
      }
    >
      {state.status === 'error' ? (
        <p className="text-sm">{t('common.failed')}</p>
      ) : view === null ? (
        <Skeleton className="h-16 w-full rounded-xl" />
      ) : !view.enabled ? (
        <p className="text-sm">{t('badge.off')}</p>
      ) : retention === null ? (
        <p className="text-sm text-fg">
          {t('badge.waiting', {
            minimum: number(BADGE_MIN_MEMBERS),
            members: number(view.members),
          })}
        </p>
      ) : (
        <div className="space-y-4" data-badge="">
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
              retentionBadgeSvg(view.locale, retention),
            )}`}
            alt={alt}
            height={20}
            className="h-5 w-auto"
          />
          <p className="text-[0.8125rem] text-subtle">
            {t('badge.counted', { members: number(view.members) })}
          </p>
          <div className="space-y-2">
            <label htmlFor={codeId} className="text-sm font-medium text-fg">
              {t('badge.code')}
            </label>
            <textarea
              id={codeId}
              readOnly
              rows={3}
              value={code}
              className="tabular w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[0.8125rem] text-fg focus-visible:outline-2 focus-visible:outline-accent"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={
                copied ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : (
                  <Copy aria-hidden="true" className="size-4" />
                )
              }
              onClick={() => {
                void navigator.clipboard?.writeText(code).then(
                  () => setCopied(true),
                  () => undefined,
                );
              }}
            >
              {t(copied ? 'badge.copied' : 'badge.copy')}
            </Button>
            <ExternalButton
              href={view.verifyUrl}
              whopAppId={integrations?.whopAppId ?? null}
              variant="ghost"
              size="sm"
            >
              {t('badge.verify')}
            </ExternalButton>
          </div>
        </div>
      )}
    </Card>
  );
}
