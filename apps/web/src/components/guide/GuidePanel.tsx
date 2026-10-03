import {
  ArrowRight,
  ChevronRight,
  Clock,
  Plug,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { GUIDE_CARDS, SHORTCUTS, type GuideCard, type Shortcut } from '../../guide';
import { useI18n } from '../../i18n';
import { Button, buttonClass } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Figures } from '../../ui/Figures';
import { Stagger, StaggerItem } from '../../ui/Motion';
import { useGuide } from './context';
import { GuideLoop } from './Loops';

const SHORTCUT_ICONS: Record<Shortcut['id'], LucideIcon> = {
  leaving: Users,
  retries: RotateCw,
  connect: Plug,
  limits: SlidersHorizontal,
};

/** The figures a card's words hold, drawn in Satoshi like every number (« every 5 days »). */
const CARD_FIGURES: Partial<Record<GuideCard['id'], readonly string[]>> = { control: ['5'] };

/**
 * The guide (brief v4 §10), a 420 px panel on the right: five cards, each with its looping
 * picture, three lines at most and « Show me », which opens the page and lights up the place;
 * then « What do you want to do? » with four shortcuts, then « Replay the tour ». No paragraph,
 * no mechanics, no test mode (it has its own bar on top of every screen). From a real
 * dashboard, the way into the demo community stays at the very bottom, one line.
 */
export function GuidePanel({
  root,
  demo,
  onClose,
}: {
  root: string;
  demo: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const guide = useGuide();
  return (
    <Drawer title={t('guide.title')} onClose={onClose}>
      <Stagger as="ul" className="space-y-3">
        {GUIDE_CARDS.map((card) => (
          <StaggerItem
            as="li"
            key={card.id}
            className="rounded-xl border border-line bg-surface p-3"
          >
            <GuideLoop card={card.id} />
            <h3 className="title-section mt-3 px-1">{t(card.title)}</h3>
            <p className="mt-1 px-1 text-[0.8125rem] leading-5">
              <Figures text={t(card.body)} figures={CARD_FIGURES[card.id] ?? []} />
            </p>
            {card.id === 'connect' ? (
              <div className="mt-2 space-y-1 px-1 text-[0.8125rem] leading-5">
                <p className="flex items-center gap-1.5 text-fg">
                  <Clock aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
                  <span>
                    <Figures text={t('guide.connect.setup')} figures={['2']} />
                  </span>
                </p>
                <p className="flex items-start gap-1.5">
                  <ShieldCheck
                    aria-hidden="true"
                    className="mt-[3px] size-3.5 shrink-0 text-accent"
                  />
                  {t('sources.privacy')}
                </p>
              </div>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              className="mt-3 ms-1"
              onClick={() => guide.showMe(card)}
            >
              {t('guide.showMe')}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </StaggerItem>
        ))}
      </Stagger>

      <section className="mt-8">
        <h3 className="title-section">{t('guide.todo')}</h3>
        <ul className="mt-2 divide-y divide-line">
          {SHORTCUTS.map((shortcut) => {
            const Icon = SHORTCUT_ICONS[shortcut.id];
            return (
              <li key={shortcut.id}>
                <button
                  type="button"
                  onClick={() => guide.go(shortcut)}
                  className="group flex w-full items-center gap-3 rounded-lg px-1 py-3 text-start text-sm font-medium text-fg transition-colors duration-150 hover:text-turq-100 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-accent" />
                  <span className="flex-1">{t(shortcut.label)}</span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5 rtl:rotate-180"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCcw aria-hidden="true" className="size-4" />}
          onClick={guide.startTour}
        >
          {t('guide.replay')}
        </Button>
        {demo ? null : (
          <Link
            to={`/demo?from=${encodeURIComponent(root)}`}
            onClick={onClose}
            className={buttonClass('ghost', 'sm')}
          >
            <Sparkles aria-hidden="true" className="size-4" />
            {t('guide.demo')}
          </Link>
        )}
      </div>
    </Drawer>
  );
}
