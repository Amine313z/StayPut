import {
  DEFAULT_TEMPLATES,
  MESSAGE_ACTIONS,
  TEMPLATE_VARIABLES,
  templateProblems,
  type ActionSettingsUpdate,
  type ActionSettingsView,
  type MessageAction,
  type MessageTemplate,
  type TemplateLocale,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { CircleAlert, CircleCheck, Globe, Save, ShieldCheck } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { putJson, useApi } from '../../api';
import { FIELD, NumberField, Row } from '../../components/SettingsParts';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { browserTimeZone, timeZoneGroups, zoneLabel } from '../../timezone';
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
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface Draft extends Omit<ActionSettingsView, Cap> {
  caps: Record<Cap, string>;
}

function toDraft(view: ActionSettingsView): Draft {
  const { templates, ...rest } = view;
  return {
    ...rest,
    templates,
    caps: Object.fromEntries(CAP_NAMES.map((cap) => [cap, String(view[cap])])) as Record<
      Cap,
      string
    >,
  };
}

function capValue(cap: Cap, text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const value = Number(text);
  const [min, max] = CAPS[cap];
  return value >= min && value <= max ? value : null;
}

function problemsOf(template: MessageTemplate | undefined): string[] {
  if (!template) return [];
  return [...templateProblems(template.title), ...templateProblems(template.body)];
}

/** The settings as the Worker takes them, or null while one value is out of bounds. */
function toView(draft: Draft): ActionSettingsView | null {
  const caps = Object.fromEntries(CAP_NAMES.map((cap) => [cap, capValue(cap, draft.caps[cap])]));
  if (CAP_NAMES.some((cap) => caps[cap] === null)) return null;
  for (const locale of ['en', 'fr'] as const) {
    for (const action of MESSAGE_ACTIONS) {
      const template = draft.templates[locale]?.[action];
      if (problemsOf(template).length > 0) return null;
      if (template && (template.title.length > TITLE_MAX || template.body.length > BODY_MAX)) {
        return null;
      }
    }
  }
  const { caps: _caps, ...rest } = draft;
  return { ...rest, ...(caps as Record<Cap, number>) };
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
  const { api } = useCreatorData();
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [saved, setSaved] = useState(() => JSON.stringify(initial));
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

  const view = toView(draft);
  const changed = view !== null && JSON.stringify(view) !== saved;
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
      setSaved(JSON.stringify(next));
      setSavedZone(next.timezone);
      setDraft(toDraft(next));
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
                  {t('actionSettings.timezone.useBrowser', { zone: zoneLabel(browserZone) })}
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
          <div role="group" aria-labelledby={`${ids}-caps`} className="space-y-3">
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
