import { X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { SPRING } from '../motion';
import { buttonClass } from './Button';
import { useScrollLock } from './scrollLock';

/**
 * A panel that slides in from the right on the drawers' spring (brief v4 §14), on an elevated
 * surface, the page behind dimmed to 50 % black: the browser's own modal <dialog>, so the page
 * behind is out of reach and Escape closes it, like its « Close » button and a click beside it.
 * Anchored to the window's right edge (`right: 0`, never left to the margins), `min(420px,
 * 100vw)` wide, the page behind locked still (fix prompt v4.1, block 3). It exists only while
 * open: the parent shows it, and removes it on `onClose`.
 */
export function Drawer({
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
  useScrollLock();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="drawer fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-[min(420px,100vw)] max-w-none overflow-hidden border-0 border-s border-line bg-transparent p-0 text-fg"
    >
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        transition={SPRING}
        className="flex h-full flex-col bg-surface-2"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="title-section">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm">
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" onClick={close} className={buttonClass('ghost', 'sm', 'shrink-0')}>
            <X aria-hidden="true" className="size-4" />
            {t('common.close')}
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </motion.div>
    </dialog>
  );
}
