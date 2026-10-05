import type { MemberRetentionView, MemberSession, MemberTelegramStatus } from '@stayput/core';
import type { Locale } from '@stayput/i18n';
import { CircleCheck, Unlink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router';
import { deleteJson, useApi, useReloadOnReturn } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { PrivacyLink } from '../components/Legal';
import { MemberRetention, useRetention } from '../components/MemberRetention';
import { MemberSpace } from '../components/MemberSpace';
import { SignOut } from '../components/SignOut';
import { ErrorPanel, Loading } from '../components/Status';
import { memberSpaceEnabled } from '../features';
import { I18nProvider, useI18n } from '../i18n';
import { Badge } from '../ui/Badge';
import { TelegramIcon } from '../ui/BrandIcons';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';

/**
 * The member view (Whop "experience view", /experiences/:experienceId), never surveillance and
 * never a risk score (SPEC 5.3), in the community's language for its members (never the
 * browser's). In V1 it is the member's subscription only: a payment that needs them, and the
 * cancellation they scheduled with its survey and offer; the member space (goals, badges…) comes
 * back with its switch (features.ts).
 */
export function MemberView() {
  const { experienceId = '' } = useParams();
  const api = `/api/member/${encodeURIComponent(experienceId)}`;
  const { state, retry } = useApi<MemberSession>(`${api}/session`);
  const retention = useRetention(api);

  if (state.status === 'loading' || retention.state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return <ErrorPanel error={state.error} forbiddenKey="error.forbidden.member" onRetry={retry} />;
  }
  const view = retention.state.status === 'ready' ? retention.state.data : null;
  return (
    <SpokenIn locale={view?.locale ?? null}>
      <MemberPage api={api} session={state.data} retention={retention} view={view} />
    </SpokenIn>
  );
}

/** The member view in the community's language (English until it is known). */
function SpokenIn({ locale, children }: { locale: Locale | null; children: ReactNode }) {
  if (!locale) return <>{children}</>;
  return (
    <I18nProvider key={locale} initialLocale={locale}>
      {children}
    </I18nProvider>
  );
}

function MemberPage({
  api,
  session,
  retention,
  view,
}: {
  api: string;
  session: MemberSession;
  retention: ReturnType<typeof useRetention>;
  view: MemberRetentionView | null;
}) {
  const { t } = useI18n();
  const space = memberSpaceEnabled();
  // Nothing to settle, nothing to answer: the member is told so, plainly.
  const allSet =
    !space &&
    view !== null &&
    !view.preview &&
    !view.payment &&
    !view.departure &&
    !view.creatorOffer &&
    !view.alumni;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            {t(space ? 'member.title' : 'member.subscription.title')}
          </h1>
          <p className="mt-1">{t(space ? 'member.welcome' : 'member.subscription.welcome')}</p>
        </div>
        <SignOut via={session.via} />
      </div>
      <MemberRetention api={api} source={retention} />
      {allSet ? (
        <p className="flex items-center gap-2 rounded-xl border border-line px-4 py-3 text-sm">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-accent" />
          {t('member.allSet')}
        </p>
      ) : null}
      {space ? <MemberSpace api={api} /> : null}
      <TelegramLink api={api} />
      {/* What StayPut does with their data, within reach of every member (SPEC Phase 8.1). */}
      <footer className="flex justify-center pt-2">
        <PrivacyLink />
      </footer>
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
