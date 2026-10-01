import type { SignInMethod } from '@stayput/core';
import { LogOut } from 'lucide-react';
import { useI18n } from '../i18n';
import { ButtonLink } from '../ui/Button';

/**
 * "Sign out", for someone who signed in with Whop outside the iframe (sandbox): to come back as
 * another test user. Inside Whop there is nothing to sign out of.
 */
export function SignOut({ via }: { via: SignInMethod }) {
  const { t } = useI18n();
  if (via !== 'login') return null;
  return (
    <ButtonLink
      href="/auth/logout"
      variant="ghost"
      size="sm"
      icon={<LogOut aria-hidden="true" className="size-4" />}
    >
      {t('auth.signOut')}
    </ButtonLink>
  );
}
