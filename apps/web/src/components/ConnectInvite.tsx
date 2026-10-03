import type { IntegrationsStatus } from '@stayput/core';
import { Clock, Gauge, Radar } from 'lucide-react';
import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { DiscordIcon, TelegramIcon } from '../ui/BrandIcons';
import { buttonClass, type ButtonVariant } from '../ui/Button';
import { ExternalButton } from '../ui/ExternalLink';

/**
 * « Connect Discord » / « Connect Telegram »: straight to adding StayPut's bot (Whop opens the
 * page), or to the platform's tab when this StayPut cannot offer it yet (the tab says why).
 */
export function ConnectButton({
  platform,
  status,
  root,
  variant = 'secondary',
}: {
  platform: 'discord' | 'telegram';
  status: IntegrationsStatus;
  root: string;
  variant?: ButtonVariant;
}) {
  const { t } = useI18n();
  const url =
    platform === 'discord' ? status.discord.install?.url : status.telegram.addToGroup?.url;
  const Icon = platform === 'discord' ? DiscordIcon : TelegramIcon;
  const label = t(platform === 'discord' ? 'connect.discord' : 'connect.telegram');
  return url ? (
    <ExternalButton
      href={url}
      whopAppId={status.whopAppId}
      variant={variant}
      size="sm"
      icon={<Icon className="size-4" />}
    >
      {label}
    </ExternalButton>
  ) : (
    <Link to={`${root}/sources/${platform}`} className={buttonClass(variant, 'sm')}>
      <Icon className="size-4" />
      {label}
    </Link>
  );
}

const BENEFITS = [
  { key: 'connect.benefit.earlier', Icon: Radar },
  { key: 'connect.benefit.timing', Icon: Clock },
  { key: 'connect.benefit.score', Icon: Gauge },
] as const;

/**
 * Integrations while neither Discord nor Telegram is connected (brief v4 §11): what StayPut does
 * not see yet, what connecting changes, and the two ways to do it.
 */
export function ConnectInvite({ status, root }: { status: IntegrationsStatus; root: string }) {
  const { t } = useI18n();
  return (
    <section
      data-tour="connect"
      className="flex flex-col gap-5 rounded-xl border border-line-strong p-5 @3xl:flex-row @3xl:items-center @3xl:justify-between"
    >
      <div className="min-w-0">
        <h2 className="title-section">{t('connect.title')}</h2>
        <p className="mt-1 text-sm">{t('connect.body')}</p>
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-fg">
          {BENEFITS.map(({ key, Icon }) => (
            <li key={key} className="flex items-center gap-2">
              <Icon aria-hidden="true" className="size-4 text-accent" />
              {t(key)}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap gap-3 @3xl:shrink-0">
        <ConnectButton platform="discord" status={status} root={root} variant="primary" />
        <ConnectButton platform="telegram" status={status} root={root} />
      </div>
    </section>
  );
}
