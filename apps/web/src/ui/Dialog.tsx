import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { buttonClass } from './Button';
import { useScrollLock } from './scrollLock';

/**
 * A window over StayPut: the browser's own modal <dialog>, so the page behind is out of reach and
 * Escape closes it, like its « Close » button and a click beside it. It exists only while open:
 * the parent shows it, and removes it on `onClose`.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // The page behind stays still while the window is open.
  useScrollLock();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  // Every way out goes through the dialog's own close: the focus then returns where it was.
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      onClick={(event) => {
        // A click on the dimmed page lands on the dialog itself, never on its content.
        if (event.target === event.currentTarget) close();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-card"
    >
      <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h2 id={titleId} className="font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1 text-sm text-muted">
              {description}
            </p>
          ) : null}
        </div>
        <button type="button" onClick={close} className={buttonClass('ghost', 'sm', 'shrink-0')}>
          <X aria-hidden="true" className="size-4" />
          {t('common.close')}
        </button>
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </dialog>
  );
}
