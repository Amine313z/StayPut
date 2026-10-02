import type { IntegrationsStatus } from '@stayput/core';
import { Activity, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AccountsCard } from '../../components/AccountsCard';
import { DiscordCard } from '../../components/DiscordCard';
import { PeopleCard } from '../../components/PeopleCard';
import { PlatformActivityCard } from '../../components/PlatformActivityCard';
import { ErrorPanel, Loading } from '../../components/Status';
import { SyncPanel } from '../../components/SyncPanel';
import { TelegramCard } from '../../components/TelegramCard';
import { useI18n } from '../../i18n';
import { EmptyState } from '../../ui/EmptyState';
import { useCreatorData } from '../CreatorView';

/**
 * Where StayPut reads activity, one tab each: Whop (always), Discord and Telegram (if the creator
 * connects them), then the activity they bring. Only who wrote and when is ever kept.
 */

/** Integrations › Whop: the synchronization with Whop, and what StayPut keeps of it. */
export function WhopTab() {
  const { sync } = useCreatorData();
  return (
    <div className="space-y-6">
      <SyncPanel sync={sync} />
      <Privacy />
    </div>
  );
}

/** Integrations › Discord: the servers StayPut reads, and connecting one. */
export function DiscordTab() {
  const { api, integrations } = useCreatorData();
  return (
    <WithIntegrations>
      {(status) => (
        <div className="space-y-6">
          <DiscordCard
            status={status.discord}
            whopAppId={status.whopAppId}
            api={api}
            onChange={integrations.reload}
          />
          <Privacy />
        </div>
      )}
    </WithIntegrations>
  );
}

/** Integrations › Telegram: the groups StayPut reads, and adding the bot to one. */
export function TelegramTab() {
  const { api, integrations } = useCreatorData();
  return (
    <WithIntegrations>
      {(status) => (
        <div className="space-y-6">
          <TelegramCard
            status={status.telegram}
            whopAppId={status.whopAppId}
            api={api}
            onChange={integrations.reload}
          />
          <Privacy />
        </div>
      )}
    </WithIntegrations>
  );
}

/**
 * Integrations › Activity: what the connected servers and groups bring, the people in them, and
 * their accounts to tie to members.
 */
export function ActivityTab() {
  const { t } = useI18n();
  const { api, integrations, members } = useCreatorData();
  // New messages may come from accounts to tie; tying one moves its messages.
  const [accountsKey, setAccountsKey] = useState(0);
  const [activityKey, setActivityKey] = useState(0);
  // The people move with both: a new writer, an account tied.
  const [peopleKey, setPeopleKey] = useState(0);
  return (
    <WithIntegrations>
      {(status) => {
        const platforms = [
          ...(status.discord.servers.length > 0 ? (['discord'] as const) : []),
          ...(status.telegram.groups.length > 0 ? (['telegram'] as const) : []),
        ];
        if (platforms.length === 0) {
          return (
            <EmptyState
              icon={<Activity aria-hidden="true" className="size-5" />}
              body={t('activity.connectFirst')}
            />
          );
        }
        return (
          <div className="space-y-6">
            <PlatformActivityCard
              api={api}
              platforms={platforms}
              refreshKey={activityKey}
              onNews={() => {
                integrations.reload();
                setAccountsKey((key) => key + 1);
                setPeopleKey((key) => key + 1);
              }}
            />
            <PeopleCard api={api} whopAppId={status.whopAppId} refreshKey={peopleKey} />
            <AccountsCard
              api={api}
              members={members.state.status === 'ready' ? members.state.data.members : []}
              refreshKey={accountsKey}
              onChange={() => {
                integrations.reload();
                members.reload();
                setActivityKey((key) => key + 1);
                setPeopleKey((key) => key + 1);
              }}
            />
            <Privacy />
          </div>
        );
      }}
    </WithIntegrations>
  );
}

/** The sources' state once read; meanwhile, the wait or what went wrong. */
function WithIntegrations({ children }: { children: (status: IntegrationsStatus) => ReactNode }) {
  const { integrations } = useCreatorData();
  if (integrations.state.status === 'loading') return <Loading />;
  if (integrations.state.status === 'error') {
    return (
      <ErrorPanel
        error={integrations.state.error}
        forbiddenKey="error.forbidden.creator"
        onRetry={integrations.retry}
      />
    );
  }
  return <>{children(integrations.state.data)}</>;
}

/** Only who wrote and when: never what. */
function Privacy() {
  const { t } = useI18n();
  return (
    <p className="flex items-start gap-2 text-sm text-muted">
      <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
      {t('sources.privacy')}
    </p>
  );
}
