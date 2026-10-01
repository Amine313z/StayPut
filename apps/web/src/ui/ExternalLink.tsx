import { ExternalLink } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { insideWhop, openThroughWhop } from '../external';
import { useI18n } from '../i18n';
import { buttonClass, type ButtonSize, type ButtonVariant } from './Button';

/**
 * A button that opens a page outside StayPut: a plain new-tab link outside Whop, Whop's
 * `openExternalUrl` inside it. If Whop does not answer, the same link is offered as is.
 */
export function ExternalButton({
  href,
  whopAppId,
  icon,
  variant = 'primary',
  size = 'md',
  children,
}: {
  href: string;
  whopAppId: string | null;
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [fallback, setFallback] = useState(false);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass(variant, size)}
        onClick={(event) => {
          if (!whopAppId || !insideWhop()) return;
          event.preventDefault();
          void openThroughWhop(href, whopAppId).then((answered) => setFallback(!answered));
        }}
      >
        {icon}
        {children}
        <ExternalLink aria-hidden="true" className="size-3.5 opacity-70" />
      </a>
      {fallback ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted underline underline-offset-4 hover:text-fg"
        >
          {t('external.fallback')}
        </a>
      ) : null}
    </span>
  );
}
