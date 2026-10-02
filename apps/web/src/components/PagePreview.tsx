import { Eye } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ExternalButton } from '../ui/ExternalLink';

/**
 * « See the page »: a card's public page shown inside StayPut, in a window that closes, so that
 * looking at it never leaves Whop (the founder, 2 October: opened in a new tab, the page had no
 * way back). The page shown is the real one, exactly what a visitor sees.
 */
export function PagePreviewButton({
  url,
  goal,
  whopAppId,
}: {
  url: string;
  goal: string;
  whopAppId: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<Eye aria-hidden="true" className="size-4" />}
        onClick={() => setOpen(true)}
      >
        {t('card.preview')}
      </Button>
      {open ? (
        <Dialog
          title={t('card.preview.title')}
          description={t('card.preview.body')}
          onClose={() => setOpen(false)}
        >
          <div className="space-y-3">
            <iframe
              src={samePath(url)}
              title={t('card.preview.frame', { goal })}
              // The page has no script; its only link (to join) may open, in a new tab.
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              className="block h-[min(34rem,calc(100dvh-14rem))] min-h-64 w-full rounded-xl border border-line bg-bg"
            />
            <ExternalButton href={url} whopAppId={whopAppId} variant="ghost" size="sm">
              {t('card.preview.newTab')}
            </ExternalButton>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The page loaded from the address StayPut is shown at (its policy allows frames from it only):
 * inside Whop, that is Whop's frame of StayPut. The link to share keeps the public address.
 */
function samePath(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return url;
  }
}
