import { ExternalLink } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useDemo } from '../demoMode';
import { insideWhop, openThroughWhop } from '../external';
import { useI18n } from '../i18n';
import { buttonClass, type ButtonSize, type ButtonVariant } from './Button';
import { IconTip } from './IconTip';

/**
 * A button that opens a page outside StayPut: a plain new-tab link outside Whop, Whop's
 * `openExternalUrl` inside it. If Whop does not answer, the same link is offered as is. Without
 * a link, nothing shows. In the demo (fix prompt v4.1, block 5), with a link or not, it shows
 * said disabled (« Disabled in the demo », over it when hovered, focused or tapped) and opens
 * nothing: no page outside StayPut is reachable from /demo.
 */
export function ExternalButton({
  href,
  whopAppId,
  icon,
  variant = 'primary',
  size = 'md',
  tour,
  children,
}: {
  href: string | null;
  whopAppId: string | null;
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Where the guide may light it up (`data-tour`, guide.ts). */
  tour?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const demo = useDemo();
  const tip = useId();
  const [fallback, setFallback] = useState(false);
  if (demo) {
    return (
      <IconTip label={t('demo.disabled')} id={tip}>
        <button
          type="button"
          aria-disabled="true"
          aria-describedby={tip}
          data-tour={tour}
          data-demo-disabled=""
          className={buttonClass(variant, size)}
          // Tapped (no hover on a phone), the button takes the focus: its tip shows.
          onClick={(event) => event.currentTarget.focus()}
        >
          {icon}
          {children}
          <ExternalLink aria-hidden="true" className="size-3.5 opacity-70" />
        </button>
      </IconTip>
    );
  }
  if (!href) return null;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-tour={tour}
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
