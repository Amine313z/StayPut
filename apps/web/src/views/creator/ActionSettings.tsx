import {
  COACHING_MESSAGE_MAX,
  DEFAULT_TEMPLATES,
  MESSAGE_ACTIONS,
  OFFER_LIMITS,
  TEMPLATE_VARIABLES,
  templateProblems,
  type ActionSettingsUpdate,
  type ActionSettingsView,
  type ExitReason,
  type MessageAction,
  type MessageTemplate,
  type OfferSettings,
  type TemplateLocale,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { CircleAlert, CircleCheck, Globe, OctagonX, Save, ShieldCheck } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { putJson, useApi } from '../../api';
import { FIELD, NumberField, Row } from '../../components/SettingsParts';
import { ErrorPanel, Loading } from '../../components/Status';
import { REASON_LABELS } from '../../exit-reasons';
import { useI18n } from '../../i18n';
import { SUGGESTED_TIME_ZONES, browserTimeZone, timeZoneGroups, zoneLabel } from '../../timezone';
import { Notice } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useCreatorData } from '../CreatorView';

/** The limits the Worker accepts (apps/worker, ACTION_LIMITS): stricter than the SPEC, never looser. */
const CAPS = {
  maxMessagesPer5Days: [0, 1],
  maxMessagesPerMonth: [0, 4],
  maxPaymentRetries: [0, 2],
  monthlyPromoCap: [0, 100],
  maxFreeDaysPerQuarter: [0, 14],
} as const;
type Cap = keyof typeof CAPS;
const CAP_NAMES = Object.keys(CAPS) as Cap[];

const TITLE_MAX = 80;
const BODY_MAX = 300;

const MESSAGE_LABELS: Readonly<Record<MessageAction, MessageKey>> = {
  payment_failed_notice: 'actions.type.payment_failed_notice',
  payment_action_notice: 'actions.type.payment_action_notice',
  exit_survey: 'actions.type.exit_survey',
  high_risk_message: 'actions.type.high_risk_message',
  welcome_message: 'actions.type.welcome_message',
  alumni_followup: 'actions.type.alumni_followup',
  buddy_intro: 'actions.type.buddy_intro',
  mentor_intro: 'actions.type.mentor_intro',
  creator_message: 'actions.type.creator_message',
  creator_offer: 'actions.type.creator_offer',
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** The departure offers' numbers (OFFER_LIMITS), each with the reason it answers. */
type OfferNumber = keyof typeof OFFER_LIMITS;
const OFFER_FIELDS: readonly { key: OfferNumber; label: MessageKey; reason?: ExitReason }[] = [
  { key: 'pauseDays', label: 'actionSettings.offers.pauseDays', reason: 'no_time' },
  { key: 'promoPercent', label: 'actionSettings.offers.promoPercent', reason: 'too_expensive' },
  { key: 'promoMonths', label: 'actionSettings.offers.promoMonths' },
  { key: 'extendDays', label: 'actionSettings.offers.extendDays', reason: 'other' },
];

interface Draft extends Omit<ActionSettingsView, Cap | 'offers'> {
  caps: Record<Cap, string>;
  offers: Record<OfferNumber, string> & { coachingMessage: string };
}

function toDraft(view: ActionSettingsView): Draft {
  const { offers, ...rest } = view;
  return {
    ...rest,
    caps: Object.fromEntries(CAP_NAMES.map((cap) => [cap, String(view[cap])])) as Record<
      Cap,
      string
    >,
    offers: {
      pauseDays: String(offers.pauseDays),
      promoPercent: String(offers.promoPercent),
      promoMonths: String(offers.promoMonths),
      extendDays: String(offers.extendDays),
      coachingMessage: offers.coachingMessage ?? '',
    },
  };
}

function inRange(text: string, [min, max]: readonly [number, number]): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

function capValue(cap: Cap, text: string): number | null {
  return inRange(text, CAPS[cap]);
}

function offerValue(key: OfferNumber, text: string): number | null {
  return inRange(text, OFFER_LIMITS[key]);
}

/** The offers as the Worker takes them, or null while one is out of bounds. */
function toOffers(draft: Draft['offers']): OfferSettings | null {
  const [pauseDays, promoPercent, promoMonths, extendDays] = (
    ['pauseDays', 'promoPercent', 'promoMonths', 'extendDays'] as const
  ).map((key) => offerValue(key, draft[key]));
  const message = draft.coachingMessage.trim();
  if (
    pauseDays == null ||
    promoPercent == null ||
    promoMonths == null ||
    extendDays == null ||
    message.length > COACHING_MESSAGE_MAX
  ) {
    return null;
  }
  return { pauseDays, promoPercent, promoMonths, extendDays, coachingMessage: message || null };
}

/** JSON with its keys sorted: two settings compare equal whatever the order of their keys. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );
}

function problemsOf(template: MessageTemplate | undefined): string[] {
  if (!template) return [];
  return [...templateProblems(template.title), ...templateProblems(template.body)];
}

/** The settings as the Worker takes them, or null while one value is out of bounds. */
function toView(draft: Draft): ActionSettingsView | null {
  const caps = Object.fromEntries(CAP_NAMES.map((cap) => [cap, capValue(cap, draft.caps[cap])]));
  if (CAP_NAMES.some((cap) => caps[cap] === null)) return null;
  const offers = toOffers(draft.offers);
  if (!offers) return null;
  for (const locale of ['en', 'fr'] as const) {
    for (const action of MESSAGE_ACTIONS) {
      const template = draft.templates[locale]?.[action];
      if (problemsOf(template).length > 0) return null;
      if (template && (template.title.length > TITLE_MAX || template.body.length > BODY_MAX)) {
        return null;
      }
    }
  }
  const { caps: _caps, offers: _offers, ...rest } = draft;
  return { ...rest, ...(caps as Record<Cap, number>), offers };
}

/**
 * How the actions leave (SPEC Phase 4, 5.2): manual or automatic, the test mode, the emergency
 * stop, the language and hours of the messages, the limits, and the creator's own words.
 */
export function ActionSettings() {
  const { api } = useCreatorData();
  const { state, retry } = useApi<ActionSettingsView>(`${api}/settings/actions`);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <ActionSettingsForm initial={state.data} />;
}

function ActionSettingsForm({ initial }: { initial: ActionSettingsView }) {
  const { t } = useI18n();
  const { api, testMode } = useCreatorData();
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [saved, setSaved] = useState(() => canonical(initial));
  // The zone goes along only when the creator changed it: the one their browser told may have
  // arrived since this form was read.
  const [savedZone, setSavedZone] = useState(initial.timezone);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const ids = useId();
  const browserZone = useMemo(() => browserTimeZone(), []);
  const zoneGroups = useMemo(
    () => timeZoneGroups(initial.timezone, browserZone),
    [initial.timezone, browserZone],
  );
  /** « France · Paris » for a suggested zone, « America/New York » for the others. */
  const zoneName = (zone: string) => {
    const suggested = SUGGESTED_TIME_ZONES.find((s) => s.zone === zone);
    return suggested ? t(suggested.label) : zoneLabel(zone);
  };

  const view = toView(draft);
  const changed = view !== null && canonical(view) !== saved;
  const edit = (update: (current: Draft) => Draft) => {
    setDraft(update);
    if (status !== 'saving') setStatus('idle');
  };
  const editTemplate = (
    locale: TemplateLocale,
    action: MessageAction,
    part: keyof MessageTemplate,
    value: string,
  ) =>
    edit((current) => {
      const previous = current.templates[locale]?.[action] ?? { title: '', body: '' };
      return {
        ...current,
        templates: {
          ...current.templates,
          [locale]: { ...current.templates[locale], [action]: { ...previous, [part]: value } },
        },
      };
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!view || !changed) return;
    setStatus('saving');
    const { timezone, ...rest } = view;
    const body: ActionSettingsUpdate = timezone === savedZone ? rest : view;
    try {
      const next = await putJson<ActionSettingsView>(`${api}/settings/actions`, body);
      setSaved(canonical(next));
      setSavedZone(next.timezone);
      setDraft(toDraft(next));
      // The banner on top of every screen follows the test mode.
      testMode.set(next.dryRun);
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };

  const toggle = (
    id: string,
    checked: boolean,
    label: string,
    hint: string,
    onChange: (value: boolean) => void,
  ) => (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 shrink-0 accent-accent"
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      </div>
    </div>
  );

  const hourSelect = (id: string, value: number, onChange: (hour: number) => void) => (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className={`${FIELD} tabular`}
    >
      {HOURS.map((hour) => (
        <option key={hour} value={hour}>
          {`${String(hour).padStart(2, '0')}:00`}
        </option>
      ))}
    </select>
  );

  return (
    <Card
      icon={<ShieldCheck aria-hidden="true" className="size-4" />}
      title={t('actionSettings.title')}
      description={t('actionSettings.description')}
    >
      <form onSubmit={(event) => void submit(event)} className="divide-y divide-line" noValidate>
        <Row label={t('actionSettings.mode')} labelId={`${ids}-mode`}>
          <div
            role="radiogroup"
            aria-labelledby={`${ids}-mode`}
            className="grid gap-2 sm:grid-cols-2"
          >
            {(['manual', 'auto'] as const).map((mode) => (
              <label
                key={mode}
                className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-2.5 ${
                  draft.mode === mode ? 'border-accent bg-accent-soft' : 'border-line'
                }`}
              >
                <input
                  type="radio"
                  name={`${ids}-mode`}
                  value={mode}
                  checked={draft.mode === mode}
                  onChange={() => edit((current) => ({ ...current, mode }))}
                  className="mt-1 accent-accent"
                />
                <span>
                  <span className="block text-sm font-medium">
                    {t(
                      mode === 'manual' ? 'actionSettings.mode.manual' : 'actionSettings.mode.auto',
                    )}
                  </span>
                  <span className="block text-sm text-muted">
                    {t(
                      mode === 'manual'
                        ? 'actionSettings.mode.manual.hint'
                        : 'actionSettings.mode.auto.hint',
                    )}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </Row>

        <Row label={t('actionSettings.dryRun')} labelId={`${ids}-safety`}>
          <div role="group" aria-labelledby={`${ids}-safety`} className="space-y-3">
            {toggle(
              `${ids}-dry`,
              draft.dryRun,
              t('actionSettings.dryRun'),
              t('actionSettings.dryRun.hint'),
              (dryRun) => edit((current) => ({ ...current, dryRun })),
            )}
            {toggle(
              `${ids}-stop`,
              draft.killSwitch,
              t('actionSettings.killSwitch'),
              t('actionSettings.killSwitch.hint'),
              (killSwitch) => edit((current) => ({ ...current, killSwitch })),
            )}
          </div>
        </Row>

        <Row label={t('actionSettings.locale')} htmlFor={`${ids}-locale`}>
          <select
            id={`${ids}-locale`}
            value={draft.locale}
            onChange={(event) =>
              edit((current) => ({
                ...current,
                locale: event.target.value === 'fr' ? 'fr' : 'en',
              }))
            }
            className={`${FIELD} w-full sm:w-56`}
          >
            <option value="fr">{t('actionSettings.locale.fr')}</option>
            <option value="en">{t('actionSettings.locale.en')}</option>
          </select>
        </Row>

        <Row label={t('actionSettings.hours')} labelId={`${ids}-hours`}>
          <div role="group" aria-labelledby={`${ids}-hours`} className="space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label htmlFor={`${ids}-zone`}>{t('actionSettings.timezone')}</label>
                <select
                  id={`${ids}-zone`}
                  value={draft.timezone}
                  aria-describedby={`${ids}-zone-hint`}
                  onChange={(event) => {
                    const timezone = event.target.value;
                    edit((current) => ({ ...current, timezone }));
                  }}
                  className={`${FIELD} w-full sm:w-72`}
                >
                  {/* The suggestions come first; the select shows the first option it matches. */}
                  <optgroup label={t('actionSettings.timezone.suggested')}>
                    {SUGGESTED_TIME_ZONES.map(({ zone, label }) => (
                      <option key={zone} value={zone}>
                        {t(label)}
                      </option>
                    ))}
                  </optgroup>
                  {zoneGroups.map(({ region, zones }) => (
                    <optgroup
                      key={region ?? ''}
                      label={region ?? t('actionSettings.timezone.other')}
                    >
                      {zones.map((zone) => (
                        <option key={zone} value={zone}>
                          {zoneLabel(zone)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <p id={`${ids}-zone-hint`} className="mt-1.5 text-sm text-muted">
                {t('actionSettings.timezone.hint')}
              </p>
              {browserZone && browserZone !== draft.timezone ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1"
                  icon={<Globe aria-hidden="true" className="size-4" />}
                  onClick={() => edit((current) => ({ ...current, timezone: browserZone }))}
                >
                  {t('actionSettings.timezone.useBrowser', { zone: zoneName(browserZone) })}
                </Button>
              ) : null}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label htmlFor={`${ids}-quiet-from`}>{t('actionSettings.quietFrom')}</label>
                {hourSelect(`${ids}-quiet-from`, draft.quietHoursStart, (quietHoursStart) =>
                  edit((current) => ({ ...current, quietHoursStart })),
                )}
                <label htmlFor={`${ids}-quiet-to`}>{t('actionSettings.quietTo')}</label>
                {hourSelect(`${ids}-quiet-to`, draft.quietHoursEnd, (quietHoursEnd) =>
                  edit((current) => ({ ...current, quietHoursEnd })),
                )}
              </div>
              <p className="mt-1.5 text-sm text-muted">{t('actionSettings.quiet.hint')}</p>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label htmlFor={`${ids}-default-hour`}>{t('actionSettings.defaultHour')}</label>
                {hourSelect(`${ids}-default-hour`, draft.defaultSendHour, (defaultSendHour) =>
                  edit((current) => ({ ...current, defaultSendHour })),
                )}
              </div>
              <p className="mt-1.5 text-sm text-muted">{t('actionSettings.defaultHour.hint')}</p>
            </div>
          </div>
        </Row>

        <Row label={t('actionSettings.caps')} labelId={`${ids}-caps`}>
          <div
            role="group"
            aria-labelledby={`${ids}-caps`}
            data-tour="limits"
            className="space-y-3"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {CAP_NAMES.map((cap) => (
                <NumberField
                  key={cap}
                  id={`${ids}-cap-${cap}`}
                  label={t(`actionSettings.cap.${cap}`)}
                  value={draft.caps[cap]}
                  invalid={capValue(cap, draft.caps[cap]) === null}
                  min={CAPS[cap][0]}
                  max={CAPS[cap][1]}
                  tour={cap === 'maxPaymentRetries' ? 'retries' : undefined}
                  onChange={(value) =>
                    edit((current) => ({ ...current, caps: { ...current.caps, [cap]: value } }))
                  }
                />
              ))}
            </div>
            <p className="text-sm text-muted">{t('actionSettings.caps.hint')}</p>
          </div>
        </Row>

        <Row label={t('actionSettings.messages')} labelId={`${ids}-messages`}>
          <div role="group" aria-labelledby={`${ids}-messages`} className="space-y-5">
            <p className="text-sm text-muted">
              {t('actionSettings.messages.hint', {
                variables: TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(', '),
              })}
            </p>
            {MESSAGE_ACTIONS.map((action) => {
              const own = draft.templates[draft.locale]?.[action];
              const fallback = DEFAULT_TEMPLATES[draft.locale][action];
              const problems = problemsOf(own);
              const id = `${ids}-${draft.locale}-${action}`;
              return (
                <fieldset key={action} className="space-y-2">
                  <legend className="text-sm font-medium">{t(MESSAGE_LABELS[action])}</legend>
                  <label htmlFor={`${id}-title`} className="sr-only">
                    {t('actionSettings.messageTitle')}
                  </label>
                  <input
                    id={`${id}-title`}
                    type="text"
                    maxLength={TITLE_MAX}
                    value={own?.title ?? ''}
                    placeholder={fallback.title}
                    aria-invalid={problems.length > 0}
                    onChange={(event) =>
                      editTemplate(draft.locale, action, 'title', event.target.value)
                    }
                    className={`${FIELD} w-full`}
                  />
                  <label htmlFor={`${id}-body`} className="sr-only">
                    {t('actionSettings.messageBody')}
                  </label>
                  <textarea
                    id={`${id}-body`}
                    rows={3}
                    maxLength={BODY_MAX}
                    value={own?.body ?? ''}
                    placeholder={fallback.body}
                    aria-invalid={problems.length > 0}
                    onChange={(event) =>
                      editTemplate(draft.locale, action, 'body', event.target.value)
                    }
                    className={`${FIELD} w-full`}
                  />
                  {problems.length > 0 ? (
                    <p className="text-sm text-danger">
                      {t('actionSettings.messageProblem', { problems: problems.join(', ') })}
                    </p>
                  ) : null}
                </fieldset>
              );
            })}
          </div>
        </Row>

        <Row label={t('actionSettings.offers')} labelId={`${ids}-offers`}>
          <div role="group" aria-labelledby={`${ids}-offers`} className="space-y-4">
            <p className="text-sm text-muted">{t('actionSettings.offers.hint')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {OFFER_FIELDS.map(({ key, label, reason }) => (
                <NumberField
                  key={key}
                  id={`${ids}-offer-${key}`}
                  label={t(label, reason ? { reason: t(REASON_LABELS[reason]) } : undefined)}
                  value={draft.offers[key]}
                  invalid={offerValue(key, draft.offers[key]) === null}
                  min={OFFER_LIMITS[key][0]}
                  max={OFFER_LIMITS[key][1]}
                  onChange={(value) =>
                    edit((current) => ({ ...current, offers: { ...current.offers, [key]: value } }))
                  }
                />
              ))}
            </div>
            {capValue('monthlyPromoCap', draft.caps.monthlyPromoCap) === 0 ? (
              <Notice tone="warning" icon={<OctagonX aria-hidden="true" className="size-4" />}>
                {t('actionSettings.offers.promoBlocked')}
              </Notice>
            ) : null}
            {(offerValue('extendDays', draft.offers.extendDays) ?? 0) >
            (capValue('maxFreeDaysPerQuarter', draft.caps.maxFreeDaysPerQuarter) ?? Infinity) ? (
              <Notice tone="warning" icon={<OctagonX aria-hidden="true" className="size-4" />}>
                {t('actionSettings.offers.extendBlocked', {
                  cap: draft.caps.maxFreeDaysPerQuarter,
                })}
              </Notice>
            ) : null}
            <div>
              <label htmlFor={`${ids}-coaching`} className="text-sm">
                {t('actionSettings.offers.coachingMessage', {
                  reason: t(REASON_LABELS.no_results),
                })}
              </label>
              <textarea
                id={`${ids}-coaching`}
                rows={3}
                maxLength={COACHING_MESSAGE_MAX}
                value={draft.offers.coachingMessage}
                placeholder={t('member.offer.coaching.body')}
                aria-describedby={`${ids}-coaching-hint`}
                onChange={(event) => {
                  const coachingMessage = event.target.value;
                  edit((current) => ({
                    ...current,
                    offers: { ...current.offers, coachingMessage },
                  }));
                }}
                className={`${FIELD} mt-1 w-full`}
              />
              <p id={`${ids}-coaching-hint`} className="mt-1.5 text-sm text-muted">
                {t('actionSettings.offers.coachingHint')}
              </p>
            </div>
          </div>
        </Row>

        <div className="flex flex-wrap items-center gap-3 pt-5">
          <Button
            type="submit"
            loading={status === 'saving'}
            disabled={!changed}
            aria-label={t('actionSettings.saveLabel')}
            icon={<Save aria-hidden="true" className="size-4" />}
          >
            {t('actionSettings.save')}
          </Button>
          <p role="status" className="text-sm">
            {status === 'saved' ? (
              <span className="flex items-center gap-1.5 text-accent">
                <CircleCheck aria-hidden="true" className="size-4" />
                {t('actionSettings.saved')}
              </span>
            ) : status === 'failed' ? (
              <span className="flex items-center gap-1.5 text-danger">
                <CircleAlert aria-hidden="true" className="size-4" />
                {t('actionSettings.error')}
              </span>
            ) : null}
          </p>
        </div>
      </form>
    </Card>
  );
}
