import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { AccountsCard } from '../../components/AccountsCard';
import { DiscordCard } from '../../components/DiscordCard';
import { PlatformActivityCard } from '../../components/PlatformActivityCard';
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
  const { sync, integrations, api, members } = useCreatorData();
  const status = integrations.state.status === 'ready' ? integrations.state.data : null;
  const platforms = [
    ...(status && status.discord.servers.length > 0 ? (['discord'] as const) : []),
    ...(status && status.telegram.groups.length > 0 ? (['telegram'] as const) : []),
  ];
  const connected = platforms.length > 0;
  // New messages may come from accounts to tie; tying one moves its messages.
  const [accountsKey, setAccountsKey] = useState(0);
  const [activityKey, setActivityKey] = useState(0);
  return (
    <div className="space-y-6">
      <SyncPanel sync={sync} />
      {connected ? (
        <PlatformActivityCard
          api={api}
          platforms={platforms}
          refreshKey={activityKey}
          onNews={() => {
            integrations.reload();
            setAccountsKey((key) => key + 1);
          }}
        />
      ) : null}
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
      {connected ? (
        <AccountsCard
          api={api}
          members={members.state.status === 'ready' ? members.state.data.members : []}
          refreshKey={accountsKey}
          onChange={() => {
            integrations.reload();
            members.reload();
            setActivityKey((key) => key + 1);
          }}
        />
      ) : null}
      <p className="flex items-start gap-2 text-sm text-muted">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
        {t('sources.privacy')}
      </p>
    </div>
  );
}
