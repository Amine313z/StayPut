import {
  COHORT_HORIZONS,
  DEFAULT_HIGH_FROM,
  DEFAULT_MEDIUM_FROM,
  DEFAULT_TEMPLATES,
  NICHE_PRESETS,
  analyzeCohorts,
  findBlockingLessons,
  normalizeWeights,
  renderMessage,
  type AccountsView,
  type ActionRow,
  type ActionView,
  type ActionsPage,
  type AlumniView,
  type CohortCounts,
  type CohortHorizon,
  type DiscordChannelChoice,
  type InsightsReport,
  type MemberRow,
  type MessageAction,
  type PeopleView,
  type PlatformActivityView,
  type PlatformPerson,
  type RiskSettingsView,
  type TemplateValues,
} from '@stayput/core';

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

export interface DemoPagesInput {
  now: number;
  community: string;
  rows: readonly MemberRow[];
  /** What a member pays a month. */
  monthly: (member: MemberRow) => number;
  /** The Discord server and the Telegram group of the community. */
  guildId: string;
  chatId: string;
  telegramTitle: string;
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
  insights: InsightsReport;
  platformActivity: () => PlatformActivityView;
  people: () => PeopleView;
  accounts: () => AccountsView;
  changeAccount: (what: string, body: Record<string, unknown>) => AccountsView | null;
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
  let actions: ActionRow[] = [
    // Waiting for the creator (manual mode).
    action('Margaux Picard', {
      type: 'exit_survey',
      status: 'proposed',
      trigger: 'cancel_at_period_end',
      createdAt: ago(4 * HOUR),
      message: message('exit_survey', 'Margaux Picard'),
    }),
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
    // Done, the newest first.
    action('Lou Marchand', {
      type: 'high_risk_message',
      status: 'sent',
      trigger: 'score_high',
      createdAt: ago(26 * HOUR),
      sendAt: ago(12 * MINUTE),
      sentAt: ago(12 * MINUTE),
      message: message('high_risk_message', 'Lou Marchand', { days_inactive: 9 }),
    }),
    action('Clara Faure', {
      type: 'payment_retry',
      status: 'sent',
      trigger: 'payment_failed',
      createdAt: ago(2 * DAY),
      sendAt: ago(47 * MINUTE),
      sentAt: ago(47 * MINUTE),
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
      offer: { reason: 'no_time', days: 30, keep: true, resumesAt: iso(now + 30 * DAY) },
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
    action('Anaïs Robin', {
      type: 'promo_offer',
      status: 'sent',
      trigger: 'exit_survey',
      createdAt: ago(31 * HOUR),
      sendAt: ago(30 * HOUR),
      sentAt: ago(30 * HOUR),
      offer: {
        reason: 'too_expensive',
        percentOff: 20,
        months: 3,
        keep: false,
        promoCode: 'STAY-7QK2MX4P',
        expiresAt: iso(now + 6 * DAY),
      },
    }),
    action('Victor Leclerc', {
      type: 'high_risk_message',
      status: 'sent',
      trigger: 'score_high',
      createdAt: ago(2 * DAY),
      sendAt: ago(31 * HOUR),
      sentAt: ago(31 * HOUR),
      message: message('high_risk_message', 'Victor Leclerc', { days_inactive: 7 }),
    }),
    action('Tom Barbier', {
      type: 'high_risk_message',
      status: 'blocked_by_guardrail',
      trigger: 'score_high',
      createdAt: ago(2 * DAY + 3 * HOUR),
      blockedReason: 'message_spacing',
      message: message('high_risk_message', 'Tom Barbier', { days_inactive: 9 }),
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
  ];
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
      );

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

  // ---- Integrations: Discord and Telegram over 30 days ----
  const joined = rows.filter((m) => m.status === 'joined');
  const active = [...joined]
    .filter((m) => m.activity.messages > 0)
    .sort((a, b) => b.activity.messages - a.activity.messages);
  const days = Array.from({ length: 30 }, (_, i) => new Date(now - (29 - i) * DAY));
  // A trading community: busy on weekdays, quieter at the weekend.
  const daily = (base: number, salt: number) =>
    days.map((day, i) => {
      const weekend = day.getDay() === 0 || day.getDay() === 6;
      const wave = Math.round(Math.sin((i + salt) * 1.7) * base * 0.18);
      return Math.max(0, Math.round(base * (weekend ? 0.45 : 1)) + wave);
    });
  const discordDaily = daily(46, 1);
  const telegramDaily = daily(14, 4);
  const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);
  const topMembers = active.slice(0, 6).map((m, i) => ({
    id: m.id,
    name: m.name,
    discord: Math.round(m.activity.messages * (i % 3 === 2 ? 0.55 : 0.8)),
    telegram: Math.round(m.activity.messages * (i % 3 === 2 ? 0.45 : 0.2)),
    lastAt: m.lastActivityAt ?? ago(DAY),
  }));
  const platformActivity: PlatformActivityView = {
    from: localDay(days[0]!),
    to: localDay(days[29]!),
    platforms: [
      {
        platform: 'discord',
        messages: sum(discordDaily),
        authors: 44,
        members: 39,
        team: 2,
        guests: 1,
        unlinked: 2,
        lastAt: ago(4 * MINUTE),
        daily: discordDaily,
      },
      {
        platform: 'telegram',
        messages: sum(telegramDaily),
        authors: 23,
        members: 19,
        team: 2,
        guests: 0,
        unlinked: 2,
        lastAt: ago(6 * MINUTE),
        daily: telegramDaily,
      },
    ],
    places: [
      {
        platform: 'discord',
        id: input.guildId,
        name: community,
        messages: sum(discordDaily),
        lastAt: ago(4 * MINUTE),
      },
      {
        platform: 'telegram',
        id: input.chatId,
        name: input.telegramTitle,
        messages: sum(telegramDaily),
        lastAt: ago(6 * MINUTE),
      },
    ],
    topMembers,
  };

  // ---- The accounts on Discord and Telegram, and who they are ----
  const handle = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.');
  const accountsState: AccountsView = {
    unlinked: [
      {
        platform: 'discord',
        accountId: '1187420000000100001',
        name: 'Margaux P.',
        username: 'margauxp',
        messages: 6,
        lastAt: ago(13 * HOUR),
        suggestions: [
          { memberId: byName('Margaux Picard').id, name: 'Margaux Picard', strong: true },
        ],
      },
      {
        platform: 'discord',
        accountId: '1187420000000100002',
        name: 'Kev',
        username: 'kev.trades',
        messages: 14,
        lastAt: ago(3 * HOUR),
        suggestions: [{ memberId: byName('Kevin Nguyen').id, name: 'Kevin Nguyen', strong: false }],
      },
      {
        platform: 'telegram',
        accountId: '6120000001',
        name: 'Yanis B',
        username: 'yanisbenali',
        messages: 9,
        lastAt: ago(2 * DAY),
        suggestions: [{ memberId: byName('Yanis Benali').id, name: 'Yanis Benali', strong: true }],
      },
      {
        platform: 'telegram',
        accountId: '6120000002',
        name: 'Alex',
        username: null,
        messages: 3,
        lastAt: ago(4 * DAY),
        suggestions: [],
      },
    ],
    linked: active.slice(0, 8).map((m, i) => ({
      platform: i % 3 === 2 ? ('telegram' as const) : ('discord' as const),
      accountId: `11874200000002${String(i).padStart(5, '0')}`,
      name: m.name,
      username: handle(m.name ?? 'member'),
      member: { id: m.id, name: m.name },
      via: i % 4 === 3 ? ('member' as const) : ('whop' as const),
    })),
    dismissed: [
      {
        platform: 'discord',
        accountId: '1187420000000100009',
        name: 'Atlas Team',
        username: 'atlas.team',
        as: 'team',
        at: ago(40 * DAY),
      },
    ],
  };
  const sameAccount =
    (body: Record<string, unknown>) => (account: { platform: string; accountId: string }) =>
      account.platform === body.platform && account.accountId === body.accountId;

  // ---- Everyone StayPut knows there, not only who writes ----
  const people = (): PeopleView => {
    const list: PlatformPerson[] = [];
    joined.forEach((m, i) => {
      const onTelegram = i % 3 === 2;
      list.push({
        platform: onTelegram ? 'telegram' : 'discord',
        accountId: `${onTelegram ? '61200' : '11874200000003'}${String(i).padStart(5, '0')}`,
        name: m.name,
        username: handle(m.name ?? 'member'),
        status: 'member',
        member: { id: m.id, name: m.name },
        here: true,
        joinedAt: m.joinedAt,
        leftAt: null,
        messages: Math.round(m.activity.messages * (onTelegram ? 0.4 : 0.8)),
        lastMessageAt: m.activity.messages > 0 ? m.lastActivityAt : null,
      });
    });
    for (const account of accountsState.unlinked) {
      list.push({
        platform: account.platform,
        accountId: account.accountId,
        name: account.name,
        username: account.username,
        status: 'unlinked',
        member: null,
        here: true,
        joinedAt: ago(20 * DAY),
        leftAt: null,
        messages: account.messages,
        lastMessageAt: account.lastAt,
      });
    }
    list.push({
      platform: 'discord',
      accountId: '1187420000000100009',
      name: 'Atlas Team',
      username: 'atlas.team',
      status: 'team',
      member: null,
      here: true,
      joinedAt: ago(300 * DAY),
      leftAt: null,
      messages: 64,
      lastMessageAt: ago(2 * HOUR),
    });
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
          known: list.filter((p) => p.platform === 'discord').length,
          list: 'listed',
        },
        {
          platform: 'telegram',
          id: input.chatId,
          name: input.telegramTitle,
          total: 29,
          known: list.filter((p) => p.platform === 'telegram').length,
          list: 'joins',
        },
      ],
      total: list.length,
      people: list,
    };
  };

  // ---- Settings › Risk score, the Alumni offer, the Discord channels ----
  let riskSettings: RiskSettingsView = {
    niche: 'trading',
    weights: NICHE_PRESETS.trading.weights,
    recencyThresholdDays: NICHE_PRESETS.trading.recencyThresholdDays,
    mediumFrom: DEFAULT_MEDIUM_FROM,
    highFrom: DEFAULT_HIGH_FROM,
  };
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

  return {
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
    platformActivity: () => platformActivity,
    people,
    accounts: () => accountsState,
    changeAccount: (what, body) => {
      const matches = sameAccount(body);
      if (what === 'link') {
        const account = accountsState.unlinked.find(matches);
        const member = rows.find((m) => m.id === body.memberId);
        if (!account || !member) return null;
        accountsState.unlinked = accountsState.unlinked.filter((a) => a !== account);
        accountsState.linked.unshift({
          platform: account.platform,
          accountId: account.accountId,
          name: account.name,
          username: account.username,
          member: { id: member.id, name: member.name },
          via: 'creator',
        });
      } else if (what === 'unlink') {
        const account = accountsState.linked.find(matches);
        if (!account) return null;
        accountsState.linked = accountsState.linked.filter((a) => a !== account);
        accountsState.unlinked.unshift({
          platform: account.platform,
          accountId: account.accountId,
          name: account.name,
          username: account.username,
          messages: 0,
          lastAt: ago(DAY),
          suggestions: [],
        });
      } else if (what === 'dismiss') {
        const account = accountsState.unlinked.find(matches);
        if (!account) return null;
        accountsState.unlinked = accountsState.unlinked.filter((a) => a !== account);
        accountsState.dismissed.unshift({
          platform: account.platform,
          accountId: account.accountId,
          name: account.name,
          username: account.username,
          as: body.as === 'guest' ? 'guest' : 'team',
          at: iso(Date.now()),
        });
      } else if (what === 'restore') {
        const account = accountsState.dismissed.find(matches);
        if (!account) return null;
        accountsState.dismissed = accountsState.dismissed.filter((a) => a !== account);
        accountsState.unlinked.unshift({
          platform: account.platform,
          accountId: account.accountId,
          name: account.name,
          username: account.username,
          messages: 0,
          lastAt: account.at,
          suggestions: [],
        });
      } else return null;
      return accountsState;
    },
    riskSettings: () => riskSettings,
    saveRiskSettings: (next) => {
      riskSettings = { ...next, weights: normalizeWeights(next.weights) };
      return riskSettings;
    },
    alumni: () => ({
      offer: {
        name: `${community} Alumni`,
        url: 'https://whop.com/atlas-trading-club/atlas-alumni/',
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
