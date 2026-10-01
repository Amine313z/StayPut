import type { MessageKey } from '@stayput/i18n';
import { useLocation } from 'react-router';
import type { ApiError } from '../api';
import { useI18n } from '../i18n';

export function Loading() {
  const { t } = useI18n();
  return (
    <p role="status" className="flex items-center gap-3 text-muted">
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-line border-t-accent"
      />
      {t('common.loading')}
    </p>
  );
}

/**
 * A failed call, in words the user can act on. `forbiddenKey` says who the screen is for: the
 * same 403 means "team only" on the dashboard and "no access" in the member space.
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
    <section role="alert" className="rounded-2xl border border-line bg-surface p-5">
      <h1 className="text-lg font-semibold">{t('error.title')}</h1>
      {signIn && signInFailed ? <p className="mt-2 font-medium">{t('auth.failed')}</p> : null}
      <p className="mt-2 text-muted">{t(messageKey)}</p>
      {signIn ? (
        <a
          href={signIn}
          className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('auth.signIn')}
        </a>
      ) : null}
      {retryable && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('common.retry')}
        </button>
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
