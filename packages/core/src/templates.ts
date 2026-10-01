/**
 * The messages of the actions (SPEC Phase 4): templates with variables, no AI. A default set in
 * English and French for every action that writes to the member (warm, short, never blaming),
 * which the creator can edit. An optional part `[[ … ]]` is kept only when every variable in it
 * has a value, so that a missing first name or lesson never leaves a hole in the sentence.
 */

import type { ActionType } from './actions';

export const TEMPLATE_VARIABLES = [
  'first_name',
  'days_inactive',
  'last_lesson',
  'goal',
  'progress',
  'creator_name',
  'offer',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export type TemplateValues = Partial<Record<TemplateVariable, string | number | null>>;

/** A Whop notification: a title and a short text. */
export interface MessageTemplate {
  title: string;
  body: string;
}

/** The actions that write to the member. */
export type MessageAction = Extract<
  ActionType,
  | 'payment_failed_notice'
  | 'payment_action_notice'
  | 'exit_survey'
  | 'high_risk_message'
  | 'welcome_message'
  | 'alumni_followup'
>;

export const MESSAGE_ACTIONS: readonly MessageAction[] = [
  'payment_failed_notice',
  'payment_action_notice',
  'exit_survey',
  'high_risk_message',
  'welcome_message',
  'alumni_followup',
];

export type TemplateLocale = 'en' | 'fr';

export const DEFAULT_TEMPLATES: Readonly<
  Record<TemplateLocale, Readonly<Record<MessageAction, MessageTemplate>>>
> = {
  en: {
    payment_failed_notice: {
      title: 'Your payment did not go through',
      body: 'Hi[[ {first_name}]], your last payment to {creator_name} did not go through. Update your payment method to keep your access: it takes a minute.',
    },
    payment_action_notice: {
      title: 'Your bank needs a quick check',
      body: 'Hi[[ {first_name}]], your bank asks you to confirm your payment to {creator_name}. Tap here to confirm it in a few seconds.',
    },
    exit_survey: {
      title: 'Before you go',
      body: 'Hi[[ {first_name}]], we saw you are leaving {creator_name} at the end of the period. Tell us why in one tap: we may have something for you.',
    },
    high_risk_message: {
      title: 'We miss you[[, {first_name}]]',
      body: 'It has been {days_inactive} days. Your next step is waiting[[: {last_lesson}]]. Come back whenever you can, we are here.',
    },
    welcome_message: {
      title: 'Welcome[[, {first_name}]]',
      body: 'Glad to have you in {creator_name}. The best first step: say hello to the community, then start the first lesson.',
    },
    alumni_followup: {
      title: 'News from {creator_name}',
      body: 'Hi[[ {first_name}]], a lot happened since you left. Here is a welcome-back code if you feel like coming back: {offer}.',
    },
  },
  fr: {
    payment_failed_notice: {
      title: 'Ton paiement n’est pas passé',
      body: 'Salut[[ {first_name}]], ton dernier paiement à {creator_name} n’est pas passé. Mets à jour ton moyen de paiement pour garder ton accès : ça prend une minute.',
    },
    payment_action_notice: {
      title: 'Ta banque demande une confirmation',
      body: 'Salut[[ {first_name}]], ta banque te demande de confirmer ton paiement à {creator_name}. Touche ici pour le valider en quelques secondes.',
    },
    exit_survey: {
      title: 'Avant que tu partes',
      body: 'Salut[[ {first_name}]], on a vu que tu quittes {creator_name} à la fin de la période. Dis-nous pourquoi en un clic : on a peut-être quelque chose pour toi.',
    },
    high_risk_message: {
      title: 'Tu nous manques[[, {first_name}]]',
      body: 'Ça fait {days_inactive} jours. Ta prochaine étape t’attend[[ : {last_lesson}]]. Reviens quand tu peux, on est là.',
    },
    welcome_message: {
      title: 'Bienvenue[[, {first_name}]]',
      body: 'Content de t’avoir dans {creator_name}. Le meilleur premier pas : présente-toi à la communauté, puis lance la première leçon.',
    },
    alumni_followup: {
      title: 'Des nouvelles de {creator_name}',
      body: 'Salut[[ {first_name}]], il s’est passé beaucoup de choses depuis ton départ. Voici un code de retour si tu as envie de revenir : {offer}.',
    },
  },
};

const OPTIONAL = /\[\[(.*?)\]\]/gs;
const VARIABLE = /\{([a-z_]+)\}/g;

function present(value: string | number | null | undefined): value is string | number {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/** The text with its variables filled in; an optional part without all its values is dropped. */
export function renderTemplate(template: string, values: TemplateValues): string {
  const value = (name: string) => values[name as TemplateVariable];
  return template
    .replace(OPTIONAL, (_, inner: string) =>
      [...inner.matchAll(VARIABLE)].every((m) => present(value(m[1] ?? ''))) ? inner : '',
    )
    .replace(VARIABLE, (_, name: string) => {
      const filled = value(name);
      return present(filled) ? String(filled).trim() : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function renderMessage(template: MessageTemplate, values: TemplateValues): MessageTemplate {
  return {
    title: renderTemplate(template.title, values),
    body: renderTemplate(template.body, values),
  };
}

/**
 * What is wrong with a template the creator wrote: variables StayPut does not know, and optional
 * parts left open. Empty when it can be saved.
 */
export function templateProblems(template: string): string[] {
  const problems: string[] = [];
  for (const match of template.matchAll(VARIABLE)) {
    const name = match[1] ?? '';
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) problems.push(`{${name}}`);
  }
  const opened = (template.match(/\[\[/g) ?? []).length;
  const closed = (template.match(/\]\]/g) ?? []).length;
  if (opened !== closed) problems.push('[[ ]]');
  return problems;
}

/**
 * Where an AI writer can plug in later (SPEC Phase 4), off: it would receive the template and the
 * values, and return the message. Until then StayPut writes from the templates only.
 */
export interface MessageWriter {
  write(input: {
    action: MessageAction;
    locale: TemplateLocale;
    template: MessageTemplate;
    values: TemplateValues;
  }): Promise<MessageTemplate>;
}

export const AI_WRITER_ENABLED = false;

/** The writer StayPut uses: the templates. */
export const templateWriter: MessageWriter = {
  write: ({ template, values }) => Promise.resolve(renderMessage(template, values)),
};
