import type { MessageKey } from '@stayput/i18n';
import { CircleAlert, LoaderCircle, LogIn, RotateCw } from 'lucide-react';
import { useLocation } from 'react-router';
import type { ApiError } from '../api';
import { useI18n } from '../i18n';
import { Button, ButtonLink } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';

export function Loading() {
  const { t } = useI18n();
  return (
    <p role="status" className="flex items-center gap-3 py-6 text-muted">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-accent" />
      {t('common.loading')}
    </p>
  );
}

/**
 * A failed call, in words the user can act on. `forbiddenKey` says who the screen is for: the
 * same 403 means "team only" on the dashboard and "no access" in the member space. Silver, not
 * red (red is for what is urgent about members). A screen the demo has no data for is not a
 * failure: it says so calmly.
 */
export function ErrorPanel({
  error,
  forbiddenKey,
  onRetry,
}: {
  error: ApiError;
  forbiddenKey: MessageKey;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const location = useLocation();
  if (error.code === 'demo') return <EmptyState body={t('error.demo')} />;
  const signIn = error.code === 'unauthenticated' ? signInHref(error.login, location) : null;
  const signInFailed = new URLSearchParams(location.search).get('login') === 'failed';
  const messageKey: MessageKey =
    error.code === 'forbidden'
      ? forbiddenKey
      : signIn
        ? 'error.unauthenticated.login'
        : (`error.${error.code}` as const);
  const retryable = ['network', 'whop_unavailable', 'internal', 'not_configured'].includes(
    error.code,
  );
  return (
    <section
      role="alert"
      className="mx-auto max-w-lg rounded-xl border border-line bg-surface/60 p-6"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted">
        <CircleAlert aria-hidden="true" className="size-5" />
      </span>
      <h1 className="mt-4 text-base font-semibold text-fg">{t('error.title')}</h1>
      {signIn && signInFailed ? <p className="mt-2 font-medium">{t('auth.failed')}</p> : null}
      <p className="mt-2 text-muted">{t(messageKey)}</p>
      {signIn ? (
        <ButtonLink
          href={signIn}
          className="mt-5"
          icon={<LogIn aria-hidden="true" className="size-4" />}
        >
          {t('auth.signIn')}
        </ButtonLink>
      ) : null}
      {retryable && onRetry ? (
        <Button
          onClick={onRetry}
          className="mt-5"
          icon={<RotateCw aria-hidden="true" className="size-4" />}
        >
          {t('common.retry')}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * Where "Sign in with Whop" goes: the Worker's sign-in address, then back to this page (without
 * a previous `login=failed`). Null when signing in outside Whop is off.
 */
function signInHref(
  login: string | null,
  location: { pathname: string; search: string },
): string | null {
  if (!login) return null;
  const search = new URLSearchParams(location.search);
  search.delete('login');
  const query = search.toString();
  const next = `${location.pathname}${query ? `?${query}` : ''}`;
  return `${login}?${new URLSearchParams({ next }).toString()}`;
}
