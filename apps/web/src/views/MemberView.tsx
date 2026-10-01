import type { MemberSession, MemberTelegramStatus } from '@stayput/core';
import { CircleCheck, Sparkles, Unlink } from 'lucide-react';
import { useParams } from 'react-router';
import { deleteJson, useApi, useReloadOnReturn } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { SignOut } from '../components/SignOut';
import { ErrorPanel, Loading } from '../components/Status';
import { useI18n } from '../i18n';
import { Badge } from '../ui/Badge';
import { TelegramIcon } from '../ui/BrandIcons';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';

/**
 * The member view (Whop "experience view", /experiences/:experienceId): progress, never
 * surveillance, and never a risk score (SPEC 5.3).
 */
export function MemberView() {
  const { experienceId = '' } = useParams();
  const { t } = useI18n();
  const api = `/api/member/${encodeURIComponent(experienceId)}`;
  const { state, retry } = useApi<MemberSession>(`${api}/session`);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return <ErrorPanel error={state.error} forbiddenKey="error.forbidden.member" onRetry={retry} />;
  }
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('member.title')}</h1>
          <p className="mt-1 text-muted">{t('member.welcome')}</p>
        </div>
        <SignOut via={state.data.via} />
      </div>
      <Card
        icon={<Sparkles aria-hidden="true" className="size-4" />}
        title={t('member.goal.title')}
        description={t('member.goal.body')}
      />
      <TelegramLink api={api} />
    </div>
  );
}

/**
 * Linking one's Telegram account, when the community counts a Telegram group: Whop does not
 * tell apps a member's Telegram, the member says it by opening the bot with a signed link.
 */
function TelegramLink({ api }: { api: string }) {
  const { t, locale } = useI18n();
  // The language goes along: the bot answers the member in it.
  const { state, reload } = useApi<MemberTelegramStatus>(`${api}/telegram?lang=${locale}`);
  useReloadOnReturn(reload);
  if (state.status !== 'ready') return null;
  const status = state.data;
  if (!status.available && !status.linked) return null;
  return (
    <Card
      icon={<TelegramIcon className="size-5 text-telegram" />}
      title={t('member.telegram.title')}
      description={t(status.linked ? 'member.telegram.linkedBody' : 'member.telegram.body')}
      actions={
        status.linked ? (
          <Badge tone="accent" icon={<CircleCheck aria-hidden="true" className="size-3" />}>
            {t('member.telegram.linked')}
          </Badge>
        ) : null
      }
    >
      {status.linked ? (
        <ConfirmButton
          label={t('member.telegram.unlink')}
          confirmLabel={t('member.telegram.unlinkConfirm')}
          icon={<Unlink aria-hidden="true" className="size-4" />}
          run={async () => {
            await deleteJson(`${api}/telegram`);
            reload();
          }}
        />
      ) : status.link ? (
        <div className="space-y-3">
          <ExternalButton
            href={status.link.url}
            whopAppId={status.whopAppId}
            icon={<TelegramIcon className="size-4" />}
          >
            {t('member.telegram.link')}
          </ExternalButton>
          <p className="text-sm text-muted">{t('member.telegram.privacy')}</p>
        </div>
      ) : null}
    </Card>
  );
}
