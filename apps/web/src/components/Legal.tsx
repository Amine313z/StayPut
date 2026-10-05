import type { MessageKey } from '@stayput/i18n';
import { Eye, Scale } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Dialog } from '../ui/Dialog';

/**
 * StayPut's legal pages (SPEC Phase 8.1), read inside StayPut: the Worker serves them
 * (`/privacy`, `/terms`, `/dpa`), and a window that closes shows them, as a card's public page,
 * so that reading them never leaves Whop. In the interface's language.
 */

export type LegalDocument = 'privacy' | 'terms' | 'dpa';

const DOCUMENTS: Readonly<Record<LegalDocument, { name: MessageKey; hint: MessageKey }>> = {
  privacy: { name: 'legal.privacy', hint: 'legal.privacy.hint' },
  terms: { name: 'legal.terms', hint: 'legal.terms.hint' },
  dpa: { name: 'legal.dpa', hint: 'legal.dpa.hint' },
};

/** The window showing one of them. */
export function LegalDialog({
  document,
  onClose,
}: {
  document: LegalDocument;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const name = t(DOCUMENTS[document].name);
  return (
    <Dialog title={name} description={t('legal.draft')} onClose={onClose}>
      <iframe
        // From the address StayPut is shown at: inside Whop, Whop's frame of StayPut.
        src={`/${document}?lang=${locale}`}
        title={t('legal.frame', { document: name })}
        // The page has no script; its links stay inside the window.
        sandbox=""
        referrerPolicy="no-referrer"
        data-legal-frame={document}
        className="block h-[min(34rem,calc(100dvh-14rem))] min-h-64 w-full rounded-xl border border-line bg-bg"
      />
    </Dialog>
  );
}

/** Settings › General › Legal: the three documents, each to read. */
export function LegalCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState<LegalDocument | null>(null);
  return (
    <Card
      icon={<Scale aria-hidden="true" className="size-4" />}
      title={t('legal.title')}
      description={t('legal.hint')}
    >
      <ul className="divide-y divide-line" data-legal>
        {(Object.keys(DOCUMENTS) as LegalDocument[]).map((document) => (
          <li
            key={document}
            className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">{t(DOCUMENTS[document].name)}</p>
              <p className="text-sm">{t(DOCUMENTS[document].hint)}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<Eye aria-hidden="true" className="size-4" />}
              aria-label={`${t('legal.read')} · ${t(DOCUMENTS[document].name)}`}
              onClick={() => setOpen(document)}
            >
              {t('legal.read')}
            </Button>
          </li>
        ))}
      </ul>
      {open ? <LegalDialog document={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

/** The member view's own: the privacy policy, as a quiet link at the bottom. */
export function PrivacyLink() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="rounded-sm text-sm text-muted underline underline-offset-4 transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => setOpen(true)}
      >
        {t('member.privacy')}
      </button>
      {open ? <LegalDialog document="privacy" onClose={() => setOpen(false)} /> : null}
    </>
  );
}
