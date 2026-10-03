import type { AccountPlatform, IntegrationsStatus } from '@stayput/core';
import { ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AccountsCard } from '../../components/AccountsCard';
import { ConnectInvite } from '../../components/ConnectInvite';
import { DiscordCard } from '../../components/DiscordCard';
import { PeopleCard } from '../../components/PeopleCard';
import { PlatformActivityCard } from '../../components/PlatformActivityCard';
import { ErrorPanel, Loading } from '../../components/Status';
import { SyncPanel } from '../../components/SyncPanel';
import { TelegramCard } from '../../components/TelegramCard';
import { useI18n } from '../../i18n';
import { useCreatorData } from '../CreatorView';

/**
 * Where StayPut reads activity, one tab each: Whop (always), Discord and Telegram (if the creator
 * connects them), then the activity they bring. Only who wrote and when is ever kept.
 */

/**
 * Integrations › Whop: the synchronization with Whop, and what StayPut keeps of it. While neither
 * Discord nor Telegram is connected, first what StayPut misses without them (brief v4 §11).
 */
export function WhopTab() {
  const { sync, integrations, root } = useCreatorData();
  const status = integrations.state.status === 'ready' ? integrations.state.data : null;
  return (
    <div className="space-y-6">
      {status && !connected(status) ? <ConnectInvite status={status} root={root} /> : null}
      <SyncPanel sync={sync} />
      <Privacy />
    </div>
  );
}

/** Discord or Telegram brings activity: a server or a group is connected. */
function connected(status: IntegrationsStatus): boolean {
  return status.discord.servers.length > 0 || status.telegram.groups.length > 0;
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
          {status.discord.servers.length > 0 ? <PlatformAccounts platform="discord" /> : null}
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
          {status.telegram.groups.length > 0 ? <PlatformAccounts platform="telegram" /> : null}
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
  const { api, integrations, members, root } = useCreatorData();
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
        if (platforms.length === 0) return <ConnectInvite status={status} root={root} />;
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
            {/* What to do before what to read: the accounts to tie, then everyone. */}
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
            <PeopleCard api={api} whopAppId={status.whopAppId} refreshKey={peopleKey} />
            <Privacy />
          </div>
        );
      }}
    </WithIntegrations>
  );
}

/**
 * A platform's accounts to tie to members, right under its card, which says « tie the others
 * below » (the founder, 2 October: since the tabs, they were only at the bottom of Activity).
 */
function PlatformAccounts({ platform }: { platform: AccountPlatform }) {
  const { api, integrations, members } = useCreatorData();
  return (
    <AccountsCard
      api={api}
      platform={platform}
      members={members.state.status === 'ready' ? members.state.data.members : []}
      onChange={() => {
        integrations.reload();
        members.reload();
      }}
    />
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
