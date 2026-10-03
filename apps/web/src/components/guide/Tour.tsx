import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useId } from 'react';
import { TOUR, type GuideCard } from '../../guide';
import { useI18n } from '../../i18n';
import { Button } from '../../ui/Button';
import { Figures } from '../../ui/Figures';
import { Spotlight } from './Spotlight';

/**
 * The tour (brief v4 §10), five places of the dashboard one after the other: the hero amount,
 * the action of the day, a risk ring, Automations, Integrations. Next, Back and Skip (also →, ←
 * and Escape); a click on the dimmed page does nothing, so no click ends it by mistake. `zero`
 * is « $0.00 » in the community's currency: the hero's starting point.
 */
export function Tour({
  index,
  zero,
  onIndex,
  onClose,
}: {
  index: number;
  zero: string;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const { t, number } = useI18n();
  const titleId = useId();
  const step = TOUR[Math.min(index, TOUR.length - 1)]!;
  const last = index >= TOUR.length - 1;
  const counter = t('tour.step', { step: number(index + 1), total: number(TOUR.length) });
  const body = t(step.body, { zero });
  const next = () => (last ? onClose() : onIndex(index + 1));
  const back = () => {
    if (index > 0) onIndex(index - 1);
  };
  return (
    <Spotlight
      targets={step.targets}
      stepKey={step.id}
      label={t('tour.label')}
      onClose={onClose}
      onKey={(key) => {
        if (key === 'ArrowRight') next();
        if (key === 'ArrowLeft') back();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="label-text">
          <Figures text={counter} figures={[number(index + 1), number(TOUR.length)]} />
        </p>
        <Button variant="ghost" size="sm" className="-me-2" onClick={onClose}>
          {t('tour.skip')}
        </Button>
      </div>
      <h2 id={titleId} className="title-section mt-1">
        {t(step.title)}
      </h2>
      <p className="mt-1.5">
        <Figures text={body} figures={step.id === 'risk' ? ['0', '100'] : [zero]} />
      </p>
      <div className="mt-4 flex items-center justify-between gap-3">
        {index > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="-ms-2"
            icon={<ArrowLeft aria-hidden="true" className="size-4" />}
            onClick={back}
          >
            {t('tour.back')}
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" size="sm" data-autofocus="" onClick={next}>
          {t(last ? 'tour.done' : 'tour.next')}
          {last ? null : <ArrowRight aria-hidden="true" className="size-4" />}
        </Button>
      </div>
    </Spotlight>
  );
}

/**
 * « Show me » (a guide card): its place in the light with the card's name, until « Got it », a
 * click anywhere or Escape.
 */
export function ShowMe({ card, onClose }: { card: GuideCard; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Spotlight
      targets={card.targets}
      stepKey={card.id}
      label={t(card.title)}
      onClose={onClose}
      onBackdrop={onClose}
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="title-section">{t(card.title)}</h2>
        <Button variant="primary" size="sm" data-autofocus="" onClick={onClose}>
          {t('guide.gotIt')}
        </Button>
      </div>
    </Spotlight>
  );
}
