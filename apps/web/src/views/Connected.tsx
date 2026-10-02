import { isCompanyId } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { ArrowLeft, CircleAlert, CircleCheck } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useI18n } from '../i18n';
import { DiscordIcon } from '../ui/BrandIcons';
import { ButtonLink } from '../ui/Button';

const REASONS: Record<string, MessageKey> = {
  denied: 'connected.reason.denied',
  expired: 'connected.reason.expired',
  unavailable: 'connected.reason.unavailable',
};

/**
 * Where Discord's page sends the creator back (/auth/discord/callback, then here): it says how
 * the connection went. This tab can be closed: the dashboard in Whop updates by itself. Signed in
 * to StayPut outside Whop (sandbox), the creator also gets a button back to their sources.
 */
export function Connected() {
  const { t, plural } = useI18n();
  const [params] = useSearchParams();
  const ok = params.get('status') === 'ok';
  const name = params.get('name') || t('discord.unnamed');
  const channels = Number(params.get('channels') ?? 0);
  const company = params.get('company');
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
      <span className="relative mx-auto flex size-14 items-center justify-center">
        <DiscordIcon className="size-12 text-discord" />
        <span
          className={`absolute -end-1 -bottom-1 flex size-6 items-center justify-center rounded-full ring-4 ring-surface ${
            ok ? 'bg-accent-soft text-accent' : 'bg-danger-soft text-danger'
          }`}
        >
          {ok ? (
            <CircleCheck aria-hidden="true" className="size-4" />
          ) : (
            <CircleAlert aria-hidden="true" className="size-4" />
          )}
        </span>
      </span>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">
        {t(ok ? 'connected.discord.title' : 'connected.failed.title')}
      </h1>
      <p className="mt-2 text-muted">
        {ok
          ? t('connected.discord.body', {
              name,
              channels: plural(
                'discord.channelsFollowed',
                Number.isFinite(channels) ? channels : 0,
              ),
            })
          : t(REASONS[params.get('reason') ?? ''] ?? 'connected.reason.error')}
      </p>
      {isCompanyId(company) ? (
        <div className="mt-6">
          <ButtonLink
            href={`/dashboard/${company}/sources/discord`}
            icon={<ArrowLeft aria-hidden="true" className="size-4" />}
          >
            {t('connected.return')}
          </ButtonLink>
        </div>
      ) : null}
      <p className="mt-6 text-sm text-muted">
        {t(isCompanyId(company) ? 'connected.backHere' : 'connected.back')}
      </p>
    </div>
  );
}
