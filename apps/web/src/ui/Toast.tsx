import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useI18n } from '../i18n';
import { TOAST_MS, ease } from '../motion';

export interface ToastInput {
  tone?: 'success' | 'error';
  title: string;
  body?: string;
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/**
 * Toasts (MOTION.md): they slide in at the bottom right, stack, and leave after 4 s, or when
 * closed. Read by screen readers as they come (a polite live region).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const show = useCallback(
    (toast: ToastInput) => {
      const id = next.current++;
      setItems((current) => [...current.slice(-3), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-20 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96"
      >
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0, transition: ease('standard') }}
              exit={{ opacity: 0, x: 24, transition: ease('micro') }}
              role={item.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-line bg-surface/95 p-3.5 shadow-lift backdrop-blur"
            >
              {item.tone === 'error' ? (
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
              ) : (
                <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{item.title}</p>
                {item.body ? <p className="mt-0.5 text-sm text-muted">{item.body}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label={t('common.close')}
                className="-m-1 rounded-md p-1 text-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/** Shows a toast. Outside a ToastProvider (a test of one screen), does nothing. */
export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext) ?? noop;
}

function noop(): void {}
