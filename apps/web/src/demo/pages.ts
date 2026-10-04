import {
  COHORT_HORIZONS,
  DEFAULT_HIGH_FROM,
  DEFAULT_MEDIUM_FROM,
  DEFAULT_TEMPLATES,
  MESSAGE_KINDS,
  NICHE_PRESETS,
  actionOutcome,
  analyzeCohorts,
  findBlockingLessons,
  normalizeWeights,
  renderMessage,
  type AccountPlatform,
  type AccountsView,
  type ActionRow,
  type ActionType,
  type ActionView,
  type ActionsPage,
  type AlumniView,
  type CohortCounts,
  type CohortHorizon,
  type DiscordChannelChoice,
  type ExitReason,
  type InsightsReport,
  type IntegrationsStatus,
  type LinkedAccount,
  type MemberRow,
  type MessageAction,
  type PeopleView,
  type PlatformActivityView,
  type PlatformPerson,
  type RiskSettingsView,
  type TemplateValues,
  type UnlinkedAccount,
} from '@stayput/core';
import { createPlatformLog, type LogPlace, type PlatformLog } from './platforms';

/**
 * The demo's other pages (Automations, Analytics, Integrations › Activity, Settings › Risk
 * score): what StayPut did and proposes for the imaginary community of world.ts, its weekly
 * analyses, what it saw on Discord and Telegram, and its settings, all told from the same
 * members. What the visitor does there (approve, cancel, tie an account, save) changes the demo
 * until the page is reloaded.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The Alumni offer's entry link, shown as an example (fix prompt v4.1, block 5): never a real
 * community's page. « Open » is disabled in the demo (ui/ExternalLink.tsx).
 */
export const DEMO_ALUMNI_URL = 'https://whop.com/your-community/alumni';

/** An offer applied to a membership, as the home counts them (the Worker's list). */
const OFFER_TYPES: readonly ActionType[] = [
  'pause_offer',
  'promo_offer',
  'extend_offer',
  'coaching_offer',
  'affiliate_invite',
];

export interface DemoPagesInput {
  now: number;
  community: string;
  rows: readonly MemberRow[];
  /** What a member pays a month. */
  monthly: (member: MemberRow) => number;
  /**
   * What StayPut saved (world.ts), and how: each one is an action of the History, sent before the
   * money came in, that says « Recovered ».
   */
  saves: readonly {
    memberId: string;
    at: number;
    amount: number;
    via: 'retry' | 'notice' | 'pause' | 'extend';
  }[];
  /** The Discord server and the Telegram group of the community. */
  guildId: string;
  chatId: string;
  telegramTitle: string;
  /** The community's time zone: its days and hours (Integrations › Discord and › Telegram). */
  zone: string;
}

export interface DemoPages {
  actions: (view: ActionView) => ActionsPage;
  /** Approves the actions waiting (all of them without `ids`). */
  approve: (ids?: readonly string[]) => number;
  cancel: (id: string) => boolean;
  /** What waits for approval, as the home's priority counts it. */
  pending: () => { actions: number; members: number; revenue: number };
  /** Members a message reached (or will) within 5 days: not « unreached » on the home. */
  reached: () => ReadonlySet<string>;
  /** When a « Score turned high » action first came for a member; null when none did. */
  scoreTurnedHigh: (memberId: string) => number | null;
  /** What StayPut did over the last 30 days (the History's), as the home counts it. */
  done30d: () => {
    total: number;
    messages: number;
    paymentRetries: number;
    offers: number;
    pauses: number;
  };
  insights: InsightsReport;
  /**
   * The departure survey's answers of the last 90 days, by reason (the most frequent first): those
   * the History shows, an offer for each, one per member (their latest).
   */
  exitReasons: () => { reason: ExitReason; count: number }[];
  /** Every answer to the departure survey (an offer made for a reason), when it was given. */
  exitAnswers: () => { at: number; reason: ExitReason }[];
  platformActivity: () => PlatformActivityView;
  people: () => PeopleView;
  /** Integrations › Discord and › Telegram (fix prompt v4.1, block 7): every message, counted. */
  platforms: PlatformLog;
  accounts: () => AccountsView;
  changeAccount: (what: string, body: Record<string, unknown>) => AccountsView | null;
  /**
   * The sources' counts as the accounts stand: the members tied there, and the accounts waiting
   * with messages (stayput.unlinked_authors), as on the server.
   */
  integrations: (status: IntegrationsStatus) => IntegrationsStatus;
  /**
   * A member wrote on Discord or Telegram (`preferred`, or the platform they are on) while the
   * demo is open: counted there, today. Which platform it was; null when they are on neither.
   */
  recordMessage: (
    memberId: string,
    at: number,
    preferred: AccountPlatform,
  ) => AccountPlatform | null;
  /**
   * A message the feed tells, already among the 30 days' counts: its account's last message.
   * Which platform it was; null when they are on neither.
   */
  noteMessage: (memberId: string, at: number, preferred: AccountPlatform) => AccountPlatform | null;
  /**
   * A member's own accounts on Discord and Telegram (a member's drawer): whether StayPut knows
   * one there, and what it wrote over 30 days. An account still waiting for its member is not
   * theirs yet: its messages are not counted for them.
   */
  memberPlatforms: (
    memberId: string,
  ) => Record<AccountPlatform, { linked: boolean; messages: number; lastAt: number | null }>;
  riskSettings: () => RiskSettingsView;
  saveRiskSettings: (next: RiskSettingsView) => RiskSettingsView;
  alumni: () => AlumniView;
  discordChannels: () => DiscordChannelChoice[];
  saveDiscordChannels: (ids: readonly string[]) => DiscordChannelChoice[];
}

/** The calendar day of a moment where the demo is opened: `YYYY-MM-DD`. */
export function localDay(moment: Date): string {
  const month = String(moment.getMonth() + 1).padStart(2, '0');
  const day = String(moment.getDate()).padStart(2, '0');
  return `${moment.getFullYear()}-${month}-${day}`;
}

/** Today at that hour (local), or tomorrow when it is past. */
function nextHour(now: number, hour: number, minutes = 0): number {
  const at = new Date(now);
  at.setHours(hour, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export function createDemoPages(input: DemoPagesInput): DemoPages {
  const { now, community, rows, monthly } = input;
  const iso = (time: number) => new Date(time).toISOString();
  const ago = (ms: number) => iso(now - ms);
  const byName = (name: string) => {
    const member = rows.find((m) => m.name === name);
    if (!member) throw new Error(`no demo member ${name}`);
    return member;
  };
  const firstName = (name: string) => name.split(' ')[0] ?? name;
  const message = (type: MessageAction, name: string, values: TemplateValues = {}) =>
    renderMessage(DEFAULT_TEMPLATES.en[type], {
      first_name: firstName(name),
      creator_name: community,
      ...values,
    });

  // ---- Automations: what StayPut proposes, has planned, and did ----
  let sequence = 0;
  const action = (
    name: string,
    over: Pick<ActionRow, 'type' | 'status' | 'trigger' | 'createdAt'> & Partial<ActionRow>,
  ): ActionRow => {
    const member = byName(name);
    sequence += 1;
    return {
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      member: { id: member.id, name: member.name },
      sendAt: null,
      sentAt: null,
      blockedReason: null,
      message: null,
      note: null,
      offer: null,
      ...over,
    };
  };
  const evening = nextHour(now, 19);
  // Every action that saved money, and the money: the History says « Recovered » for them.
  const savedBy = new Map<string, { amount: number; currency: string }>();
  const savedActions = input.saves.map((save) => {
    const member = rows.find((m) => m.id === save.memberId)!;
    const name = member.name ?? '';
    // Retried a few minutes before the money came in, its renewal having failed two days
    // before; the notice two hours before the member paid; the pause 30 days before they came
    // back and paid; the free days a week before their renewal, paid.
    const sent =
      save.via === 'retry'
        ? save.at - 4 * MINUTE
        : save.via === 'notice'
          ? save.at - 2 * HOUR
          : save.via === 'pause'
            ? save.at - 30 * DAY
            : save.at - 7 * DAY;
    const row = action(name, {
      type:
        save.via === 'retry'
          ? 'payment_retry'
          : save.via === 'notice'
            ? 'payment_failed_notice'
            : save.via === 'pause'
              ? 'pause_offer'
              : 'extend_offer',
      status: 'sent',
      trigger: save.via === 'retry' || save.via === 'notice' ? 'payment_failed' : 'exit_survey',
      createdAt: iso(save.via === 'retry' ? save.at - 2 * DAY : sent - 10 * MINUTE),
      sendAt: iso(sent),
      sentAt: iso(sent),
      message: save.via === 'notice' ? message('payment_failed_notice', name) : null,
      offer:
        save.via === 'pause'
          ? { reason: 'no_time', days: 30, keep: true, resumesAt: iso(sent + 30 * DAY) }
          : save.via === 'extend'
            ? { reason: 'other', days: 7, keep: true }
            : null,
    });
    savedBy.set(row.id, { amount: save.amount, currency: 'usd' });
    return row;
  });
  let actions: ActionRow[] = [
    // Waiting for the creator (manual mode).
    action('Margaux Picard', {
      type: 'exit_survey',
      status: 'proposed',
      trigger: 'cancel_at_period_end',
      createdAt: ago(4 * HOUR),
      message: message('exit_survey', 'Margaux Picard'),
    }),
    // « Score turned high »: only ever for a member whose score is high then (block 4, rule 4).
    action('Yanis Benali', {
      type: 'high_risk_message',
      status: 'proposed',
      trigger: 'score_high',
      createdAt: ago(3 * HOUR),
      sendAt: iso(evening),
      message: message('high_risk_message', 'Yanis Benali', {
        days_inactive: 19,
        last_lesson: 'Module 3 · Risk management',
      }),
    }),
    action('Maxime Vidal', {
      type: 'high_risk_message',
      status: 'proposed',
      trigger: 'score_high',
      createdAt: ago(3 * HOUR + 20 * MINUTE),
      sendAt: iso(evening + 30 * MINUTE),
      message: message('high_risk_message', 'Maxime Vidal', { days_inactive: 24 }),
    }),
    // After StayPut's retry failed again.
    action('Elena Novak', {
      type: 'payment_failed_notice',
      status: 'proposed',
      trigger: 'payment_failed',
      createdAt: ago(2 * HOUR),
      message: message('payment_failed_notice', 'Elena Novak'),
    }),
    action('Ethan Brooks', {
      type: 'welcome_message',
      status: 'proposed',
      trigger: 'activation_radar',
      createdAt: ago(5 * HOUR),
      sendAt: iso(nextHour(now, 18, 30)),
      message: message('welcome_message', 'Ethan Brooks'),
    }),
    action('Kevin Nguyen', {
      type: 'extend_offer',
      status: 'proposed',
      trigger: 'exit_survey',
      createdAt: ago(29 * HOUR),
      offer: { reason: 'other', days: 7, keep: false },
    }),
    // Planned.
    action('Sarah Cohen', {
      type: 'payment_retry',
      status: 'scheduled',
      trigger: 'payment_failed',
      createdAt: ago(95 * MINUTE),
      sendAt: iso(now + 5 * HOUR),
    }),
    action('Omar Fassi', {
      type: 'high_risk_message',
      status: 'scheduled',
      trigger: 'score_high',
      createdAt: ago(20 * HOUR),
      sendAt: iso(nextHour(now + DAY, 19)),
      message: message('high_risk_message', 'Omar Fassi', {
        days_inactive: 11,
        last_lesson: 'Module 2 · Reading the order book',
      }),
    }),
    action('Maya Fernandes', {
      type: 'welcome_message',
      status: 'scheduled',
      trigger: 'activation_radar',
      createdAt: ago(9 * HOUR),
      sendAt: iso(nextHour(now, 18, 30) + 15 * MINUTE),
      message: message('welcome_message', 'Maya Fernandes'),
    }),
    // Done. Lou is at medium risk: the creator wrote to her from the dashboard.
    action('Lou Marchand', {
      type: 'creator_message',
      status: 'sent',
      trigger: 'creator',
      createdAt: ago(26 * HOUR),
      sendAt: ago(12 * MINUTE),
      sentAt: ago(12 * MINUTE),
      message: message('creator_message', 'Lou Marchand'),
    }),
    action('Sarah Cohen', {
      type: 'payment_failed_notice',
      status: 'sent',
      trigger: 'payment_failed',
      createdAt: ago(95 * MINUTE),
      sendAt: ago(90 * MINUTE),
      sentAt: ago(90 * MINUTE),
      message: message('payment_failed_notice', 'Sarah Cohen'),
    }),
    // Retried two hours ago: failed again (« Still failing »), her payment still unpaid.
    action('Elena Novak', {
      type: 'payment_retry',
      status: 'sent',
      trigger: 'payment_failed',
      createdAt: ago(3 * DAY),
      sendAt: ago(2 * HOUR),
      sentAt: ago(2 * HOUR),
    }),
    action('Juliette Caron', {
      type: 'pause_offer',
      status: 'sent',
      trigger: 'exit_survey',
      createdAt: ago(5 * HOUR + 10 * MINUTE),
      sendAt: ago(5 * HOUR),
      sentAt: ago(5 * HOUR),
      offer: { reason: 'no_time', days: 30, keep: true, resumesAt: iso(now - 5 * HOUR + 30 * DAY) },
    }),
    action('Pauline Giraud', {
      type: 'welcome_message',
      status: 'sent',
      trigger: 'activation_radar',
      createdAt: ago(8 * HOUR),
      sendAt: ago(7 * HOUR),
      sentAt: ago(7 * HOUR),
      message: message('welcome_message', 'Pauline Giraud'),
    }),
    action('Rose Gauthier', {
      type: 'creator_message',
      status: 'sent',
      trigger: 'creator',
      createdAt: ago(11 * HOUR),
      sendAt: ago(11 * HOUR),
      sentAt: ago(11 * HOUR),
      message: message('creator_message', 'Rose Gauthier'),
    }),
    // His score turned high two days ago; the message brought him back (« Came back »).
    action('Victor Leclerc', {
      type: 'high_risk_message',
      status: 'sent',
      trigger: 'score_high',
      createdAt: ago(2 * DAY),
      sendAt: ago(31 * HOUR),
      sentAt: ago(31 * HOUR),
      message: message('high_risk_message', 'Victor Leclerc', { days_inactive: 7 }),
    }),
    // The creator wrote to Tom twice in two days: the second one waits for the spacing.
    action('Tom Barbier', {
      type: 'creator_message',
      status: 'blocked_by_guardrail',
      trigger: 'creator',
      createdAt: ago(2 * DAY + 3 * HOUR),
      blockedReason: 'message_spacing',
      message: message('creator_message', 'Tom Barbier'),
    }),
    action('Tom Barbier', {
      type: 'creator_message',
      status: 'sent',
      trigger: 'creator',
      createdAt: ago(4 * DAY + 3 * HOUR),
      sendAt: ago(4 * DAY + 3 * HOUR),
      sentAt: ago(4 * DAY + 3 * HOUR),
      message: message('creator_message', 'Tom Barbier'),
    }),
    action('Benoît Lacroix', {
      type: 'alumni_followup',
      status: 'sent',
      trigger: 'alumni',
      createdAt: ago(5 * DAY),
      sendAt: ago(5 * DAY),
      sentAt: ago(5 * DAY),
      alumniStep: 7,
      message: message('alumni_followup', 'Benoît Lacroix', {
        offer: '20% off for 3 months with the code STAY-K7QM2XPA',
      }),
    }),
    // Too expensive: she took the discount and kept her membership; it comes off her next
    // payments, and she has been active since (« Came back »).
    action('Laura Weber', {
      type: 'promo_offer',
      status: 'sent',
      trigger: 'exit_survey',
      createdAt: ago(6 * DAY + 20 * MINUTE),
      sendAt: ago(6 * DAY),
      sentAt: ago(6 * DAY),
      offer: { reason: 'too_expensive', percentOff: 20, months: 3, keep: true, promoApplied: true },
    }),
    // The creator wrote to her before her membership ended; she left all the same (« Left »).
    action('Sabrina Aït', {
      type: 'creator_message',
      status: 'sent',
      trigger: 'creator',
      createdAt: ago(24 * DAY + 20 * MINUTE),
      sendAt: ago(24 * DAY),
      sentAt: ago(24 * DAY),
      message: message('creator_message', 'Sabrina Aït'),
    }),
    ...savedActions,
  ];
  /**
   * What came of an action that reached its member, from the members as every page shows them
   * (core `actionOutcome`, the Worker's rule): the money saved through it, their payment, a pause,
   * whether they came back after it or left since.
   */
  const outcomeOf = (row: ActionRow) => {
    const member = rows.find((m) => m.id === row.member.id);
    const sent = Date.parse(row.sentAt ?? row.createdAt);
    const leftAt =
      member?.status === 'left' && member.membership?.currentPeriodEnd
        ? Date.parse(member.membership.currentPeriodEnd)
        : null;
    return actionOutcome({
      type: row.type,
      status: row.status,
      saved: savedBy.get(row.id) ?? null,
      paymentFailing: member?.lastPayment?.status === 'failed',
      activeAfter: !!member?.lastActivityAt && Date.parse(member.lastActivityAt) > sent,
      leftAfter: leftAt !== null && leftAt > sent,
      resumesAt: row.offer?.resumesAt ?? null,
    });
  };
  const IN_VIEW: Record<ActionView, (row: ActionRow) => boolean> = {
    queue: (row) => row.status === 'proposed',
    scheduled: (row) => row.status === 'approved' || row.status === 'scheduled',
    history: (row) => !['proposed', 'approved', 'scheduled'].includes(row.status),
  };
  const moment = (row: ActionRow) => Date.parse(row.sentAt ?? row.sendAt ?? row.createdAt);
  const list = (view: ActionView) =>
    actions
      .filter(IN_VIEW[view])
      .sort((a, b) =>
        view === 'history'
          ? moment(b) - moment(a)
          : view === 'scheduled'
            ? moment(a) - moment(b)
            : 0,
      )
      .map((row) => (view === 'history' ? { ...row, outcome: outcomeOf(row) } : row));

  // ---- Analytics: the months of arrival, and the lessons members stall after ----
  // Members arrive through each month; a month counts at a horizon once its members are old
  // enough. July's arrivals left faster (a summer cohort): the analysis flags it.
  const RATES: Record<CohortHorizon, number> = { 30: 0.09, 60: 0.14, 90: 0.19 };
  const cohortCounts: CohortCounts[] = [];
  const today = new Date(now);
  for (let back = 7; back >= 0; back--) {
    const start = new Date(today.getFullYear(), today.getMonth() - back, 1);
    const end = new Date(today.getFullYear(), today.getMonth() - back + 1, 1);
    const month = localDay(start);
    const size = [18, 21, 24, 19, 26, 22, 17, 4][7 - back] ?? 12;
    const summer = start.getMonth() === 6;
    const eligible = {} as Record<CohortHorizon, number>;
    const left = {} as Record<CohortHorizon, number>;
    for (const h of COHORT_HORIZONS) {
      const share = Math.max(
        0,
        Math.min(1, (now - h * DAY - start.getTime()) / (end.getTime() - start.getTime())),
      );
      // Counted once most of the month's members are old enough (else « — », not a noisy rate).
      eligible[h] = share >= 0.6 ? Math.round(size * share) : 0;
      left[h] = Math.round(eligible[h] * (summer ? RATES[h] * 2.4 : RATES[h]));
    }
    cohortCounts.push({ month, members: size, eligible, left });
  }
  const cohorts = analyzeCohorts(cohortCounts);
  const lessons = findBlockingLessons(
    [
      ['Module 1 · Market basics', 52, 2],
      ['Module 2 · Reading the order book', 47, 4],
      ['Module 3 · Risk management', 41, 15],
      ['Module 4 · Position sizing', 29, 3],
      ['Module 5 · Backtesting', 23, 8],
      ['Module 6 · Your trading plan', 15, 1],
    ].map(([title, reached, stalled], i) => ({
      lessonId: `lesn_demo${i + 1}`,
      courseId: 'cors_demoAtlas',
      title: String(title),
      reached: Number(reached),
      stalled: Number(stalled),
    })),
  ).sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.rate - a.rate);
  const lastMonday = new Date(now);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - ((lastMonday.getUTCDay() + 6) % 7));
  lastMonday.setUTCHours(7, 30, 0, 0);
  if (lastMonday.getTime() > now) lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  const insights: InsightsReport = {
    computedAt: lastMonday.toISOString(),
    cohorts: cohorts.cohorts.map(({ month, members, rates, alertHorizon }) => ({
      month,
      members,
      rates,
      alertHorizon,
    })),
    averages: cohorts.averages,
    lessons,
  };

  // ---- Integrations: who is on Discord and Telegram, and what they wrote over 30 days ----
  // One account per person and place, and every figure of Integrations (each platform's
  // messages and days, the servers and groups, the most active members, everyone, the accounts
  // to tie) counted from them as the server counts them: never a figure of its own. A member's
  // messages there are part of their own (Members, 30 days); the rest they wrote on Whop.
  const joined = rows.filter((m) => m.status === 'joined');
  const handle = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.');
  const days = Array.from({ length: 30 }, (_, i) => new Date(now - (29 - i) * DAY));
  const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);

  interface DemoAccount {
    platform: AccountPlatform;
    accountId: string;
    name: string | null;
    username: string | null;
    status: 'member' | 'unlinked' | 'team' | 'guest';
    member: MemberRow | null;
    via: LinkedAccount['via'];
    /** The members it may be, while it waits for one. */
    suggestions: UnlinkedAccount['suggestions'];
    /** Over the last 30 days. */
    messages: number;
    lastAt: number | null;
    joinedAt: number;
    /** When the creator set it aside. */
    setAsideAt: number | null;
    /** The creator's latest change comes first in its list. */
    changed: number;
    /** It left the server or the group then; null while there. */
    leftAt: number | null;
  }
  const account = (over: Partial<DemoAccount> & Pick<DemoAccount, 'platform' | 'accountId'>) =>
    ({
      name: null,
      username: null,
      status: 'member',
      member: null,
      via: null,
      suggestions: [],
      messages: 0,
      lastAt: null,
      joinedAt: now - 120 * DAY,
      setAsideAt: null,
      changed: 0,
      leftAt: null,
      ...over,
    }) satisfies DemoAccount;

  // Accounts waiting for a member, and whose they may be: their messages are no member's yet.
  const suggestion = (name: string, strong: boolean) => {
    const member = byName(name);
    return [{ memberId: member.id, name: member.name, strong }];
  };
  const accounts: DemoAccount[] = [
    account({
      platform: 'discord',
      accountId: '1187420000000100001',
      name: 'Margaux P.',
      username: 'margauxp',
      status: 'unlinked',
      suggestions: suggestion('Margaux Picard', true),
      messages: 6,
      lastAt: now - 13 * HOUR,
    }),
    account({
      platform: 'discord',
      accountId: '1187420000000100002',
      name: 'Kev',
      username: 'kev.trades',
      status: 'unlinked',
      suggestions: suggestion('Kevin Nguyen', false),
      messages: 14,
      lastAt: now - 3 * HOUR,
    }),
    account({
      platform: 'telegram',
      accountId: '6120000001',
      name: 'Yanis B',
      username: 'yanisbenali',
      status: 'unlinked',
      suggestions: suggestion('Yanis Benali', true),
      messages: 9,
      lastAt: now - 2 * DAY,
    }),
    account({
      platform: 'telegram',
      accountId: '6120000002',
      name: 'Alex',
      status: 'unlinked',
      messages: 3,
      lastAt: now - 4 * DAY,
    }),
  ];
  // The members' own accounts: most of them on the Discord server, a third in the Telegram group
  // too (one in six there only). A member whose account waits above has no other one there.
  const waitingFor = (member: MemberRow, platform: AccountPlatform) =>
    accounts.some(
      (a) => a.platform === platform && a.suggestions.some((s) => s.memberId === member.id),
    );
  joined.forEach((m, i) => {
    const onDiscord = i % 6 !== 5;
    const onTelegram = i % 3 === 2;
    const total = m.activity.messages;
    const shares: [AccountPlatform, number][] = [
      ['discord', onDiscord ? (onTelegram ? 0.55 : 0.75) : 0],
      ['telegram', onTelegram ? (onDiscord ? 0.25 : 0.75) : 0],
    ];
    for (const [platform, share] of shares) {
      if (share === 0 || waitingFor(m, platform)) continue;
      const messages = Math.round(total * share);
      accounts.push(
        account({
          platform,
          accountId:
            platform === 'discord'
              ? `11874200000003${String(i).padStart(5, '0')}`
              : // Never one of the accounts above (6120000002 was both Kevin's and Alex's).
                `61201${String(i).padStart(5, '0')}`,
          name: m.name,
          username: handle(m.name ?? 'member'),
          member: m,
          // Discord: from the member's Whop profile; Telegram: the member linked it.
          via: platform === 'discord' ? 'whop' : 'member',
          messages,
          lastAt: messages > 0 && m.lastActivityAt ? Date.parse(m.lastActivityAt) : null,
          joinedAt: m.joinedAt ? Date.parse(m.joinedAt) : now - 120 * DAY,
        }),
      );
    }
  });
  // The team, set aside as such (its messages never count in the scores), and a guest.
  accounts.push(
    account({
      platform: 'discord',
      accountId: '1187420000000100009',
      name: 'Atlas Team',
      username: 'atlas.team',
      status: 'team',
      messages: 64,
      lastAt: now - 2 * HOUR,
      joinedAt: now - 300 * DAY,
      setAsideAt: now - 40 * DAY,
    }),
    account({
      platform: 'telegram',
      accountId: '6120000009',
      name: 'Atlas Team',
      username: 'atlas_team',
      status: 'team',
      messages: 21,
      lastAt: now - 5 * HOUR,
      joinedAt: now - 280 * DAY,
      setAsideAt: now - 38 * DAY,
    }),
    account({
      platform: 'discord',
      accountId: '1187420000000100010',
      name: 'Marc Olivier',
      username: 'marc.live',
      status: 'guest',
      messages: 5,
      lastAt: now - 26 * HOUR,
      joinedAt: now - 15 * DAY,
      setAsideAt: now - 12 * DAY,
    }),
  );

  // Two members left: Yanis the Discord server five days ago, Omar the Telegram group three days
  // ago (Integrations: the signal « Left », the people no longer there).
  const leaves: [string, AccountPlatform, number][] = [
    ['Yanis Benali', 'discord', 5],
    ['Omar Fassi', 'telegram', 3],
  ];
  for (const [name, platform, daysAgo] of leaves) {
    const theirs = accounts.find((a) => a.platform === platform && a.member?.name === name);
    if (theirs) theirs.leftAt = now - daysAgo * DAY - 3 * HOUR;
  }

  // Three members active elsewhere went quiet on Discord a week or more ago (Integrations ›
  // Discord: the signal « Gone quiet », and what it would change): Lou, Nora and Laura.
  const quiet: [string, number][] = [
    ['Lou Marchand', 9],
    ['Nora Chabane', 11],
    ['Laura Weber', 8],
  ];
  for (const [name, daysAgo] of quiet) {
    const theirs = accounts.find((a) => a.platform === 'discord' && a.member?.name === name);
    if (theirs && theirs.messages > 0) theirs.lastAt = now - daysAgo * DAY - 5 * HOUR;
  }

  const on = (platform: AccountPlatform) => accounts.filter((a) => a.platform === platform);
  const wrote = (platform: AccountPlatform) => on(platform).filter((a) => a.messages > 0);
  const latest = (list: readonly DemoAccount[]) =>
    list.reduce<number | null>(
      (last, a) => (a.lastAt !== null && a.lastAt > (last ?? 0) ? a.lastAt : last),
      null,
    );

  // ---- The Discord channels, and where messages are written ----
  let channels: DiscordChannelChoice[] = [
    ['general', 'Community', true, true],
    ['trade-ideas', 'Community', true, true],
    ['wins', 'Community', true, true],
    ['questions', 'Course', true, true],
    ['module-help', 'Course', true, false],
    ['announcements', 'Info', false, false],
  ].map(([name, category, readable, followed], i) => ({
    id: `11874200000000${String(i + 1).padStart(5, '0')}`,
    name: String(name),
    category: String(category),
    readable: Boolean(readable),
    followed: Boolean(followed),
  }));
  // Each followed channel's share of what members write, and the group's topics'.
  const SHARES: Readonly<Record<string, number>> = {
    general: 0.42,
    'trade-ideas': 0.3,
    questions: 0.16,
    wins: 0.12,
  };
  const places = (platform: AccountPlatform): LogPlace[] =>
    platform === 'discord'
      ? channels.map((c) => ({
          id: c.id,
          kind: 'channel' as const,
          name: c.name,
          parent: community,
          weight: c.followed ? (SHARES[c.name] ?? 0) : 0,
          followed: c.followed,
        }))
      : [
          {
            id: `${input.chatId}:`,
            kind: 'general' as const,
            name: input.telegramTitle,
            parent: null,
            weight: 0.3,
            followed: true,
          },
          {
            id: `${input.chatId}:2`,
            kind: 'topic' as const,
            name: 'Signals',
            parent: input.telegramTitle,
            weight: 0.5,
            followed: true,
          },
          {
            id: `${input.chatId}:3`,
            kind: 'topic' as const,
            name: 'Questions',
            parent: input.telegramTitle,
            weight: 0.2,
            followed: true,
          },
        ];

  // ---- Every message, one by one (Integrations › Discord and › Telegram) ----
  const log = createPlatformLog({
    now,
    zone: input.zone,
    accounts,
    rows,
    places,
    thresholds: () => ({ mediumFrom: riskSettings.mediumFrom, highFrom: riskSettings.highFrom }),
  });

  const platformActivity = (): PlatformActivityView => {
    const tile = (platform: AccountPlatform) => {
      const authors = wrote(platform);
      const count = (status: DemoAccount['status']) =>
        authors.filter((a) => a.status === status).length;
      const written = (status: DemoAccount['status']) =>
        sum(authors.filter((a) => a.status === status).map((a) => a.messages));
      return {
        platform,
        messages: sum(authors.map((a) => a.messages)),
        // The members' part is what their own 30 days add up to there (their drawers).
        messagesBy: {
          members: written('member'),
          team: written('team'),
          guests: written('guest'),
          unlinked: written('unlinked'),
        },
        authors: authors.length,
        members: count('member'),
        team: count('team'),
        guests: count('guest'),
        unlinked: count('unlinked'),
        lastAt: latest(authors) === null ? null : iso(latest(authors)!),
        daily: log.daily(platform),
      };
    };
    const platforms = [tile('discord'), tile('telegram')];
    // The members who wrote the most there, both platforms together.
    const byMember = new Map<
      string,
      { id: string; name: string | null; discord: number; telegram: number; lastAt: number }
    >();
    for (const a of accounts) {
      if (a.status !== 'member' || !a.member || a.messages === 0) continue;
      const entry = byMember.get(a.member.id) ?? {
        id: a.member.id,
        name: a.member.name,
        discord: 0,
        telegram: 0,
        lastAt: 0,
      };
      entry[a.platform] += a.messages;
      entry.lastAt = Math.max(entry.lastAt, a.lastAt ?? 0);
      byMember.set(a.member.id, entry);
    }
    return {
      from: localDay(days[0]!),
      to: localDay(days[29]!),
      platforms,
      places: platforms
        .map((p) => ({
          platform: p.platform,
          id: p.platform === 'discord' ? input.guildId : input.chatId,
          name: p.platform === 'discord' ? community : input.telegramTitle,
          messages: p.messages,
          lastAt: p.lastAt ?? ago(30 * DAY),
        }))
        .sort((a, b) => b.messages - a.messages),
      topMembers: [...byMember.values()]
        .sort((a, b) => b.discord + b.telegram - (a.discord + a.telegram))
        .slice(0, 6)
        .map((m) => ({ ...m, lastAt: iso(m.lastAt) })),
    };
  };

  // ---- Everyone StayPut knows there, not only who writes ----
  const people = (): PeopleView => {
    const list: PlatformPerson[] = accounts.map((a) => ({
      platform: a.platform,
      accountId: a.accountId,
      name: a.name,
      username: a.username,
      status: a.status,
      member: a.status === 'member' && a.member ? { id: a.member.id, name: a.member.name } : null,
      here: a.leftAt === null,
      joinedAt: iso(a.joinedAt),
      leftAt: a.leftAt === null ? null : iso(a.leftAt),
      messages: a.messages,
      lastMessageAt: a.lastAt === null ? null : iso(a.lastAt),
    }));
    list.sort(
      (a, b) =>
        Date.parse(b.lastMessageAt ?? '1970-01-01') - Date.parse(a.lastMessageAt ?? '1970-01-01'),
    );
    return {
      places: [
        {
          platform: 'discord',
          id: input.guildId,
          name: community,
          total: 44,
          known: on('discord').length,
          list: 'listed',
        },
        {
          platform: 'telegram',
          id: input.chatId,
          name: input.telegramTitle,
          total: 29,
          known: on('telegram').length,
          list: 'joins',
        },
      ],
      total: list.length,
      totals: {
        discord: list.filter((p) => p.platform === 'discord').length,
        telegram: list.filter((p) => p.platform === 'telegram').length,
      },
      people: list,
    };
  };

  // ---- The accounts seen writing, and the member each is ----
  const latestFirst = (a: DemoAccount, b: DemoAccount) => b.changed - a.changed;
  const accountsView = (): AccountsView => ({
    unlinked: accounts
      .filter((a) => a.status === 'unlinked')
      .sort((a, b) => latestFirst(a, b) || (b.lastAt ?? 0) - (a.lastAt ?? 0))
      .map((a) => ({
        platform: a.platform,
        accountId: a.accountId,
        name: a.name,
        username: a.username,
        messages: a.messages,
        lastAt: iso(a.lastAt ?? now - DAY),
        suggestions: a.suggestions,
      })),
    linked: accounts
      .filter((a) => a.status === 'member' && a.member && a.messages > 0)
      .sort((a, b) => latestFirst(a, b) || b.messages - a.messages)
      .map((a) => ({
        platform: a.platform,
        accountId: a.accountId,
        name: a.name,
        username: a.username,
        member: { id: a.member!.id, name: a.member!.name },
        via: a.via,
      })),
    dismissed: accounts
      .filter((a) => a.status === 'team' || a.status === 'guest')
      .sort((a, b) => latestFirst(a, b) || (b.setAsideAt ?? 0) - (a.setAsideAt ?? 0))
      .map((a) => ({
        platform: a.platform,
        accountId: a.accountId,
        name: a.name,
        username: a.username,
        as: a.status === 'guest' ? ('guest' as const) : ('team' as const),
        at: iso(a.setAsideAt ?? now),
      })),
  });
  let changes = 0;
  const findAccount = (body: Record<string, unknown>) =>
    accounts.find((a) => a.platform === body.platform && a.accountId === body.accountId);
  /** The member's account there; the other platform when they are not on that one. */
  const memberAccount = (memberId: string, preferred: AccountPlatform) => {
    const theirs = accounts.filter((a) => a.status === 'member' && a.member?.id === memberId);
    return theirs.find((a) => a.platform === preferred) ?? theirs[0] ?? null;
  };

  // ---- Settings › Risk score, the Alumni offer, the Discord channels ----
  let riskSettings: RiskSettingsView = {
    niche: 'trading',
    weights: NICHE_PRESETS.trading.weights,
    recencyThresholdDays: NICHE_PRESETS.trading.recencyThresholdDays,
    mediumFrom: DEFAULT_MEDIUM_FROM,
    highFrom: DEFAULT_HIGH_FROM,
  };

  const memberPlatforms = (memberId: string) => {
    const of = (platform: AccountPlatform) => {
      const mine = on(platform).filter((a) => a.status === 'member' && a.member?.id === memberId);
      return {
        linked: mine.length > 0,
        messages: sum(mine.map((a) => a.messages)),
        lastAt: latest(mine),
      };
    };
    return { discord: of('discord'), telegram: of('telegram') };
  };

  return {
    memberPlatforms,
    actions: (view) => ({
      view,
      counts: {
        queue: list('queue').length,
        scheduled: list('scheduled').length,
        history: list('history').length,
      },
      actions: list(view),
      mode: 'manual',
      dryRun: false,
      killSwitch: false,
    }),
    approve: (ids) => {
      let approved = 0;
      actions = actions.map((row) => {
        if (row.status !== 'proposed' || (ids && !ids.includes(row.id))) return row;
        approved += 1;
        const soon = Date.now() + 2 * MINUTE;
        return {
          ...row,
          status: 'scheduled',
          sendAt: iso(Math.max(soon, row.sendAt ? Date.parse(row.sendAt) : soon)),
        };
      });
      return approved;
    },
    cancel: (id) => {
      const row = actions.find((a) => a.id === id);
      if (!row || !['proposed', 'approved', 'scheduled'].includes(row.status)) return false;
      actions = actions.map((a) => (a.id === id ? { ...a, status: 'cancelled' } : a));
      return true;
    },
    pending: () => {
      const waiting = list('queue');
      const members = new Set(waiting.map((row) => row.member.id));
      return {
        actions: waiting.length,
        members: members.size,
        revenue:
          Math.round(
            [...members].reduce((total, id) => {
              const member = rows.find((m) => m.id === id);
              return total + (member ? monthly(member) : 0);
            }, 0) * 100,
          ) / 100,
      };
    },
    exitReasons: () => {
      const latest = new Map<string, { at: number; reason: ExitReason }>();
      for (const row of actions) {
        const reason = row.offer?.reason;
        const at = Date.parse(row.createdAt);
        if (!reason || now - at > 90 * DAY) continue;
        const known = latest.get(row.member.id);
        if (!known || known.at < at) latest.set(row.member.id, { at, reason });
      }
      const counts = new Map<ExitReason, number>();
      for (const { reason } of latest.values()) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      return [...counts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    },
    exitAnswers: () =>
      actions.flatMap((row) =>
        row.offer?.reason ? [{ at: Date.parse(row.createdAt), reason: row.offer.reason }] : [],
      ),
    scoreTurnedHigh: (memberId) => {
      const times = actions
        .filter((row) => row.trigger === 'score_high' && row.member.id === memberId)
        .map((row) => Date.parse(row.createdAt));
      return times.length > 0 ? Math.min(...times) : null;
    },
    done30d: () => {
      const done = actions.filter(
        (row) =>
          (row.status === 'sent' || row.status === 'simulated') && now - moment(row) < 30 * DAY,
      );
      const count = (keep: (type: ActionType) => boolean) =>
        done.filter((row) => keep(row.type)).length;
      return {
        total: done.length,
        messages: count((type) => MESSAGE_KINDS[type] !== 'none'),
        paymentRetries: count((type) => type === 'payment_retry'),
        offers: count((type) => OFFER_TYPES.includes(type)),
        pauses: count((type) => type === 'pause_offer'),
      };
    },
    reached: () =>
      new Set(
        actions
          .filter(
            (row) =>
              row.message !== null &&
              ['proposed', 'approved', 'scheduled', 'sent', 'simulated'].includes(row.status) &&
              Date.now() - moment(row) < 5 * DAY,
          )
          .map((row) => row.member.id),
      ),
    insights,
    platformActivity,
    people,
    platforms: log,
    accounts: accountsView,
    integrations: (status) => {
      const counts = (platform: AccountPlatform) => ({
        linkedMembers: new Set(
          on(platform)
            .filter((a) => a.status === 'member' && a.member)
            .map((a) => a.member!.id),
        ).size,
        unlinkedAuthors: on(platform).filter((a) => a.status === 'unlinked' && a.messages > 0)
          .length,
      });
      return {
        ...status,
        discord: { ...status.discord, ...counts('discord') },
        telegram: { ...status.telegram, ...counts('telegram') },
      };
    },
    recordMessage: (memberId, at, preferred) => {
      const theirs = memberAccount(memberId, preferred);
      if (!theirs) return null;
      theirs.messages += 1;
      theirs.lastAt = Math.max(theirs.lastAt ?? 0, at);
      log.record(theirs, at);
      return theirs.platform;
    },
    noteMessage: (memberId, at, preferred) => {
      const theirs = memberAccount(memberId, preferred);
      if (!theirs) return null;
      if (theirs.messages > 0 && at > (theirs.lastAt ?? 0)) {
        // The feed's message is their last one there: so is it in the log.
        log.moveLast(theirs, at);
        theirs.lastAt = at;
      }
      return theirs.platform;
    },
    changeAccount: (what, body) => {
      const found = findAccount(body);
      if (!found) return null;
      if (what === 'link') {
        // Its messages waiting become the member's (Members counts them from now on).
        const member = rows.find((m) => m.id === body.memberId);
        if (found.status !== 'unlinked' || !member) return null;
        found.status = 'member';
        found.member = member;
        found.via = 'creator';
        member.activity.messages += found.messages;
      } else if (what === 'unlink') {
        if (found.status !== 'member' || !found.member) return null;
        found.member.activity.messages = Math.max(
          0,
          found.member.activity.messages - found.messages,
        );
        found.status = 'unlinked';
        found.member = null;
        found.via = null;
      } else if (what === 'dismiss') {
        if (found.status !== 'unlinked') return null;
        found.status = body.as === 'guest' ? 'guest' : 'team';
        found.setAsideAt = Date.now();
      } else if (what === 'restore') {
        if (found.status !== 'team' && found.status !== 'guest') return null;
        found.status = 'unlinked';
        found.setAsideAt = null;
      } else return null;
      found.changed = ++changes;
      return accountsView();
    },
    riskSettings: () => riskSettings,
    saveRiskSettings: (next) => {
      riskSettings = { ...next, weights: normalizeWeights(next.weights) };
      return riskSettings;
    },
    alumni: () => ({
      offer: {
        name: `${community} Alumni`,
        url: DEMO_ALUMNI_URL,
        createdAt: ago(46 * DAY),
        completedAt: ago(46 * DAY),
      },
      entered: 9,
      left: 1,
      returned: 2,
    }),
    discordChannels: () => channels,
    saveDiscordChannels: (ids) => {
      channels = channels.map((c) => ({ ...c, followed: c.readable && ids.includes(c.id) }));
      return channels;
    },
  };
}
