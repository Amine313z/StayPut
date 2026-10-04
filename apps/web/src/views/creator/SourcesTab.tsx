import type { AccountPlatform, IntegrationsStatus } from '@stayput/core';
import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { AccountsCard } from '../../components/AccountsCard';
import { ConnectInvite } from '../../components/ConnectInvite';
import { DiscordCard } from '../../components/DiscordCard';
import { ErrorPanel, Loading } from '../../components/Status';
import { SyncPanel } from '../../components/SyncPanel';
import { TelegramCard } from '../../components/TelegramCard';
import { useI18n } from '../../i18n';
import { useCreatorData } from '../CreatorView';
import { PlatformDashboardView } from './platform/PlatformDashboard';

/**
 * Where StayPut reads activity, one tab each: Whop (always), Discord and Telegram, each a
 * dashboard of its own once connected (brief v4 §9.6; their activity, once a tab of its own, is
 * in each). Only who wrote, where and when is ever kept.
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

/** The platform has a server or a group connected. */
function connectedTo(status: IntegrationsStatus, platform: AccountPlatform): boolean {
  return platform === 'discord'
    ? status.discord.servers.length > 0
    : status.telegram.groups.length > 0;
}

/** Integrations › Discord: its dashboard; before a server is connected, how to connect one. */
export function DiscordTab() {
  return <PlatformTab platform="discord" />;
}

/** Integrations › Telegram: its dashboard; before a group is connected, how to add the bot. */
export function TelegramTab() {
  return <PlatformTab platform="telegram" />;
}

function PlatformTab({ platform }: { platform: AccountPlatform }) {
  const { api, integrations, members } = useCreatorData();
  return (
    <WithIntegrations>
      {(status) =>
        connectedTo(status, platform) ? (
          <div className="space-y-6">
            <PlatformDashboardView key={platform} platform={platform} status={status} />
            <Privacy />
          </div>
        ) : (
          <div className="space-y-6">
            {platform === 'discord' ? (
              <DiscordCard
                status={status.discord}
                whopAppId={status.whopAppId}
                api={api}
                onChange={integrations.reload}
              />
            ) : (
              <TelegramCard
                status={status.telegram}
                whopAppId={status.whopAppId}
                api={api}
                onChange={integrations.reload}
              />
            )}
            {/* Accounts seen writing before the server or group went away: still to tie. */}
            <AccountsCard
              api={api}
              platform={platform}
              members={members.state.status === 'ready' ? members.state.data.members : []}
              onChange={() => {
                integrations.reload();
                members.reload();
              }}
            />
            <Privacy />
          </div>
        )
      }
    </WithIntegrations>
  );
}

/**
 * The former Integrations › Activity (fix prompt v4.1, block 7: its content is in each platform's
 * tab): Discord's, or Telegram's when only a group is connected.
 */
export function ActivityAddress() {
  const { integrations } = useCreatorData();
  const status = integrations.state.status === 'ready' ? integrations.state.data : null;
  const telegramOnly =
    status !== null && status.discord.servers.length === 0 && status.telegram.groups.length > 0;
  return <Navigate to={`../${telegramOnly ? 'telegram' : 'discord'}`} replace />;
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

/** Only who wrote, where and when: never what. */
function Privacy() {
  const { t } = useI18n();
  return (
    <p className="flex items-start gap-2 text-sm text-muted">
      <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
      {t('sources.privacy')}
    </p>
  );
}
