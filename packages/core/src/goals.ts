/**
 * The member's goal (SPEC Phase 5): what they aim for, from where, by when, and the milestones on
 * the way, at 25, 50, 75 and 100 % of the distance from the start to the target, whichever way
 * it goes (a weight to lose counts as well as an income to reach). The database computes the
 * progress and the milestones (stayput.goal_progress); this module holds the goals a creator
 * proposes by default for their niche, and checks what a member or a creator sends.
 */

import type { Niche } from './risk';
import type { TemplateLocale } from './templates';

/** What a goal is about: buddies are matched on the same category when possible. */
export const GOAL_CATEGORIES = [
  'income',
  'clients',
  'sales',
  'body',
  'practice',
  'learning',
  'performance',
  'other',
] as const;

export type GoalCategory = (typeof GOAL_CATEGORIES)[number];

export function isGoalCategory(value: unknown): value is GoalCategory {
  return typeof value === 'string' && (GOAL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * How the member records a result: `total`, where they stand now (a weight, a monthly revenue);
 * `add`, what they did since the last time (two more clients, one more session).
 */
export type GoalEntry = 'total' | 'add';

export const GOAL_ENTRIES: readonly GoalEntry[] = ['total', 'add'];

export function isGoalEntry(value: unknown): value is GoalEntry {
  return value === 'total' || value === 'add';
}

/** A goal the creator proposes to their members: the member then sets its numbers and date. */
export interface GoalProposal {
  title: string;
  unit: string;
  category: GoalCategory;
  entry: GoalEntry;
}

/** The milestones of a goal, in percent of the way from the start to the target. */
export const MILESTONES = [25, 50, 75, 100] as const;

export type Milestone = (typeof MILESTONES)[number];

/**
 * Where `current` stands from the start to the target, from 0 to 100, never beyond: as
 * stayput.goal_progress computes it (exactly, in cents, so that both always agree).
 */
export function goalProgress(start: number, target: number, current: number): number {
  const [s, t, c] = [start, target, current].map((value) => Math.round(value * 100)) as [
    number,
    number,
    number,
  ];
  if (t === s) return 0;
  return Math.max(0, Math.min(100, Math.floor(((c - s) * 100) / (t - s))));
}

/** The milestones a progress has reached. */
export function milestonesAt(progress: number): Milestone[] {
  return MILESTONES.filter((milestone) => progress >= milestone);
}

/** The badges a member can earn (the catalog of stayput.badges). */
export const BADGE_CODES = [
  'first_result',
  'streak_7_days',
  'first_proof',
  'milestone_25',
  'milestone_50',
  'milestone_75',
  'milestone_100',
  'mentor',
  'rescuer',
] as const;

export type BadgeCode = (typeof BADGE_CODES)[number];

export function isBadgeCode(value: unknown): value is BadgeCode {
  return typeof value === 'string' && (BADGE_CODES as readonly string[]).includes(value);
}

export const GOAL_TITLE_MAX = 80;
export const GOAL_UNIT_MAX = 20;
export const MAX_GOAL_PROPOSALS = 6;
/** Below the largest numeric(14, 2) the database keeps. */
export const GOAL_VALUE_MAX = 100_000_000_000;
/** How far a target date may be: five years. */
export const GOAL_MAX_YEARS = 5;

interface NicheGoal {
  category: GoalCategory;
  entry: GoalEntry;
  text: Readonly<Record<TemplateLocale, { title: string; unit: string }>>;
}

/**
 * The goals proposed to the members of a niche until the creator writes their own: three each,
 * in the member's language. Amounts in euros in French and in dollars in English, the member
 * changes the unit if it is not theirs.
 */
export const NICHE_GOALS: Readonly<Record<Niche, readonly NicheGoal[]>> = {
  trading: [
    {
      category: 'income',
      entry: 'total',
      text: {
        fr: { title: 'Atteindre mon objectif de gains mensuels', unit: '€' },
        en: { title: 'Reach my monthly profit target', unit: '$' },
      },
    },
    {
      category: 'practice',
      entry: 'add',
      text: {
        fr: { title: 'Suivre mon plan de trading', unit: 'jours' },
        en: { title: 'Follow my trading plan', unit: 'days' },
      },
    },
    {
      category: 'performance',
      entry: 'total',
      text: {
        fr: { title: 'Améliorer mon taux de réussite', unit: '%' },
        en: { title: 'Improve my win rate', unit: '%' },
      },
    },
  ],
  fitness: [
    {
      category: 'body',
      entry: 'total',
      text: {
        fr: { title: 'Atteindre mon poids cible', unit: 'kg' },
        en: { title: 'Reach my target weight', unit: 'kg' },
      },
    },
    {
      category: 'practice',
      entry: 'add',
      text: {
        fr: { title: 'M’entraîner régulièrement', unit: 'séances' },
        en: { title: 'Train regularly', unit: 'sessions' },
      },
    },
    {
      category: 'performance',
      entry: 'total',
      text: {
        fr: { title: 'Courir plus loin', unit: 'km' },
        en: { title: 'Run further', unit: 'km' },
      },
    },
  ],
  online_business: [
    {
      category: 'income',
      entry: 'total',
      text: {
        fr: { title: 'Atteindre mon chiffre d’affaires mensuel', unit: '€' },
        en: { title: 'Reach my monthly revenue', unit: '$' },
      },
    },
    {
      category: 'clients',
      entry: 'add',
      text: {
        fr: { title: 'Trouver mes premiers clients', unit: 'clients' },
        en: { title: 'Land my first clients', unit: 'clients' },
      },
    },
    {
      category: 'practice',
      entry: 'add',
      text: {
        fr: { title: 'Publier du contenu chaque semaine', unit: 'publications' },
        en: { title: 'Publish content every week', unit: 'posts' },
      },
    },
  ],
  coaching: [
    {
      category: 'clients',
      entry: 'add',
      text: {
        fr: { title: 'Signer de nouveaux clients', unit: 'clients' },
        en: { title: 'Sign new clients', unit: 'clients' },
      },
    },
    {
      category: 'income',
      entry: 'total',
      text: {
        fr: { title: 'Atteindre mon revenu mensuel', unit: '€' },
        en: { title: 'Reach my monthly income', unit: '$' },
      },
    },
    {
      category: 'practice',
      entry: 'add',
      text: {
        fr: { title: 'Mener mes séances', unit: 'séances' },
        en: { title: 'Run my sessions', unit: 'sessions' },
      },
    },
  ],
  ecommerce: [
    {
      category: 'income',
      entry: 'total',
      text: {
        fr: { title: 'Atteindre mon chiffre d’affaires mensuel', unit: '€' },
        en: { title: 'Reach my monthly revenue', unit: '$' },
      },
    },
    {
      category: 'sales',
      entry: 'add',
      text: {
        fr: { title: 'Réaliser mes ventes', unit: 'ventes' },
        en: { title: 'Make sales', unit: 'sales' },
      },
    },
    {
      category: 'practice',
      entry: 'add',
      text: {
        fr: { title: 'Lancer de nouveaux produits', unit: 'produits' },
        en: { title: 'Launch new products', unit: 'products' },
      },
    },
  ],
  personal_development: [
    {
      category: 'practice',
      entry: 'add',
      text: {
        fr: { title: 'Tenir ma nouvelle habitude', unit: 'jours' },
        en: { title: 'Keep my new habit', unit: 'days' },
      },
    },
    {
      category: 'learning',
      entry: 'add',
      text: {
        fr: { title: 'Lire des livres', unit: 'livres' },
        en: { title: 'Read books', unit: 'books' },
      },
    },
    {
      category: 'learning',
      entry: 'total',
      text: {
        fr: { title: 'Terminer la formation', unit: '%' },
        en: { title: 'Finish the course', unit: '%' },
      },
    },
  ],
  other: [
    {
      category: 'learning',
      entry: 'total',
      text: {
        fr: { title: 'Terminer la formation', unit: '%' },
        en: { title: 'Finish the course', unit: '%' },
      },
    },
    {
      category: 'practice',
      entry: 'add',
      text: {
        fr: { title: 'Pratiquer régulièrement', unit: 'séances' },
        en: { title: 'Practice regularly', unit: 'sessions' },
      },
    },
    {
      category: 'other',
      entry: 'add',
      text: {
        fr: { title: 'Avancer chaque semaine', unit: 'étapes' },
        en: { title: 'Move forward every week', unit: 'steps' },
      },
    },
  ],
};

/** The goals a niche proposes, in a language. */
export function nicheGoalProposals(niche: Niche, locale: TemplateLocale): GoalProposal[] {
  return NICHE_GOALS[niche].map((goal) => ({
    title: goal.text[locale].title,
    unit: goal.text[locale].unit,
    category: goal.category,
    entry: goal.entry,
  }));
}

/** A text the member or the creator typed: trimmed, inner spaces collapsed, within `max`. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

/** A number the database can keep: finite, within the bounds, to the cent. */
export function goalValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) > GOAL_VALUE_MAX) return null;
  // `+ 0` turns a rounded -0 into 0.
  return Math.round(value * 100) / 100 + 0;
}

function parseProposal(value: unknown): GoalProposal | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const title = cleanText(item.title, GOAL_TITLE_MAX);
  const unit = cleanText(item.unit, GOAL_UNIT_MAX);
  if (!title || !unit || !isGoalEntry(item.entry)) return null;
  return {
    title,
    unit,
    category: isGoalCategory(item.category) ? item.category : 'other',
    entry: item.entry,
  };
}

/**
 * The goals a creator proposes, as they sent them: up to six, each with a title, a unit and how
 * results are recorded. Null when one of them is not right.
 */
export function parseGoalProposals(value: unknown): GoalProposal[] | null {
  if (!Array.isArray(value) || value.length > MAX_GOAL_PROPOSALS) return null;
  const proposals: GoalProposal[] = [];
  for (const item of value) {
    const proposal = parseProposal(item);
    if (!proposal) return null;
    proposals.push(proposal);
  }
  return proposals;
}

/** A goal the member sets. */
export interface GoalInput extends GoalProposal {
  /** Where they stand today. */
  start: number;
  target: number;
  /** By when, YYYY-MM-DD. */
  targetDate: string;
}

const DAY_MS = 86_400_000;

/** A calendar day, YYYY-MM-DD, that exists. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * The goal a member sends, checked: a title and a unit, a start and a different target, a date
 * from yesterday (their today, wherever they are) to five years from now. Null when it is not
 * right.
 */
export function parseGoalInput(value: unknown, now: Date): GoalInput | null {
  const proposal = parseProposal(value);
  if (!proposal) return null;
  const item = value as Record<string, unknown>;
  const start = goalValue(item.start);
  const target = goalValue(item.target);
  if (start === null || target === null || start === target) return null;
  if (!isCalendarDate(item.targetDate)) return null;
  const earliest = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
  const latest = new Date(now);
  latest.setUTCFullYear(latest.getUTCFullYear() + GOAL_MAX_YEARS);
  if (item.targetDate < earliest || item.targetDate > latest.toISOString().slice(0, 10)) {
    return null;
  }
  return { ...proposal, start, target, targetDate: item.targetDate };
}

/** A result the member records: on which goal, and the number they typed. */
export interface ResultEntry {
  goalId: string;
  /** Where they stand now (`total`), or what they add (`add`, may correct with a negative). */
  value: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseResultEntry(value: unknown): ResultEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.goalId !== 'string' || !UUID.test(item.goalId)) return null;
  const number = goalValue(item.value);
  return number === null ? null : { goalId: item.goalId, value: number };
}
