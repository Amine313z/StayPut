import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useId } from 'react';
import { TOUR, type GuideCard, type TourStep } from '../../guide';
import { useI18n } from '../../i18n';
import { Button } from '../../ui/Button';
import { Figures } from '../../ui/Figures';
import { Spotlight } from './Spotlight';

/**
 * The tour (brief v4 §10, fix prompt v4.1 block 1), five places one after the other: the amount
 * saved, the action of the day and the first member's risk ring on the dashboard, then a rule of
 * Automations and connecting Discord, each on its page (the frame opens it). Next, Back and Skip
 * (also →, ← and Escape); a click on the dimmed page does nothing, so no click ends it by
 * mistake. `zero` is « $0.00 » in the community's currency: the hero's starting point.
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
  const at = Math.min(index, TOUR.length - 1);
  const step = TOUR[at]!;
  const following = TOUR[at + 1];
  const last = at >= TOUR.length - 1;
  const counter = t('tour.step', { step: number(at + 1), total: number(TOUR.length) });
  const next = () => (last ? onClose() : onIndex(at + 1));
  const back = () => {
    if (at > 0) onIndex(at - 1);
  };
  return (
    <Spotlight
      targets={step.targets}
      stepKey={step.id}
      next={following?.page === step.page ? following.targets : undefined}
      label={t('tour.label')}
      onClose={onClose}
      onKey={(key) => {
        if (key === 'ArrowRight') next();
        if (key === 'ArrowLeft') back();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="label-text">
          <Figures text={counter} figures={[number(at + 1), number(TOUR.length)]} />
        </p>
        <Button variant="ghost" size="sm" className="-me-2" onClick={onClose}>
          {t('tour.skip')}
        </Button>
      </div>
      <h2 id={titleId} className="title-section mt-1">
        {t(step.title)}
      </h2>
      <StepBody step={step} zero={zero} />
      <div className="mt-4 flex items-center justify-between gap-3">
        {at > 0 ? (
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

/** A step's one-line explanation, its figures in Satoshi. */
function StepBody({ step, zero }: { step: TourStep; zero: string }) {
  const { t } = useI18n();
  return (
    <p className="mt-1.5">
      <Figures text={t(step.body, { zero })} figures={step.id === 'risk' ? ['0', '100'] : [zero]} />
    </p>
  );
}

/**
 * « Show me » (a guide card): its page, its place in the same light as the tour's, with the
 * card's name and what the place is for — the tour step's words when the tour shows the same
 * place, else the card's caption — until « Got it », a click on the dimmed page or Escape.
 */
export function ShowMe({
  card,
  zero,
  onClose,
}: {
  card: GuideCard;
  zero: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const step = TOUR.find((s) => s.id === card.step);
  return (
    <Spotlight
      targets={card.targets}
      stepKey={card.id}
      label={t(card.title)}
      onClose={onClose}
      onBackdrop={onClose}
    >
      <h2 className="title-section">{t(card.title)}</h2>
      {step ? <StepBody step={step} zero={zero} /> : <p className="mt-1.5">{t(card.body)}</p>}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" size="sm" data-autofocus="" onClick={onClose}>
          {t('guide.gotIt')}
        </Button>
      </div>
    </Spotlight>
  );
}
