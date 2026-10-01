import type { SignInMethod } from '@stayput/core';
import { useI18n } from '../i18n';

/**
 * "Sign out", for someone who signed in with Whop outside the iframe (sandbox): to come back as
 * another test user. Inside Whop there is nothing to sign out of.
 */
export function SignOut({ via }: { via: SignInMethod }) {
  const { t } = useI18n();
  if (via !== 'login') return null;
  return (
    <a
      href="/auth/logout"
      className="text-sm text-muted underline underline-offset-4 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {t('auth.signOut')}
    </a>
  );
}
