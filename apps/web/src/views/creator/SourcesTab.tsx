import { ShieldCheck } from 'lucide-react';
import { DiscordCard } from '../../components/DiscordCard';
import { ErrorPanel, Loading } from '../../components/Status';
import { SyncPanel } from '../../components/SyncPanel';
import { TelegramCard } from '../../components/TelegramCard';
import { useI18n } from '../../i18n';
import { useCreatorData } from '../CreatorView';

/**
 * Where StayPut reads activity: Whop (always), Discord and Telegram (if the creator connects
 * them). Only who wrote and when is ever kept.
 */
export function SourcesTab() {
  const { t } = useI18n();
  const { sync, integrations, api } = useCreatorData();
  return (
    <div className="space-y-6">
      <SyncPanel sync={sync} />
      {integrations.state.status === 'loading' ? (
        <Loading />
      ) : integrations.state.status === 'error' ? (
        <ErrorPanel
          error={integrations.state.error}
          forbiddenKey="error.forbidden.creator"
          onRetry={integrations.retry}
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <DiscordCard
            status={integrations.state.data.discord}
            whopAppId={integrations.state.data.whopAppId}
            api={api}
            onChange={integrations.reload}
          />
          <TelegramCard
            status={integrations.state.data.telegram}
            whopAppId={integrations.state.data.whopAppId}
            api={api}
            onChange={integrations.reload}
          />
        </div>
      )}
      <p className="flex items-start gap-2 text-sm text-muted">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
        {t('sources.privacy')}
      </p>
    </div>
  );
}
