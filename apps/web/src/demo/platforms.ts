import {
  PLATFORM_SIGNALS,
  SIGNAL_BITS,
  addDays,
  allPlatformSignals,
  firedSignals,
  zonedClock,
  zonedDay,
  zonedMoment,
  type AccountPlatform,
  type ActivityPlatform,
  type ActivityWindow,
  type HeatCell,
  type MemberRow,
  type PlatformDashboard,
  type PlatformDay,
  type PlatformDayView,
  type PlatformInputs,
  type PlatformMember,
  type PlatformPlace,
  type PlatformSignals,
  type PlatformSlotView,
  type ScoreMaking,
  type SignalPlatform,
} from '@stayput/core';
import { seeded } from './random';

/**
 * What the demo community wrote on Discord and Telegram (and on Whop, a log of its own: its chats
 * and forums, 0049), message by message (fix prompt v4.1,
 * block 7; brief v4 §9.6): when, where, and from which account, never what. Each account's 30
 * days add up to its count of the pages (pages.ts: the members' drawers, the people, the accounts
 * to tie) and end on its last message; the members wrote there in the two months before too, so
 * that who went silent shows. Integrations › Discord and › Telegram are counted from it as the
 * Worker counts them (0033): the figures of the top, the days, the hours, the places, the most
 * active and the silent members, the signals and their preview.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** An account as the pages keep it: what the log needs of it. */
export interface LogAccount {
  platform: ActivityPlatform;
  accountId: string;
  status: 'member' | 'unlinked' | 'team' | 'guest';
  member: MemberRow | null;
  /** Its messages over the last 30 days. */
  messages: number;
  /** Its last message, however old. */
  lastAt: number | null;
  joinedAt: number;
  /** It left the server or the group then; null while there. */
  leftAt: number | null;
}

/** A place messages are written in, and its share of them. */
export interface LogPlace {
  id: string;
  kind: PlatformPlace['kind'];
  name: string | null;
  parent: string | null;
  /** Its share of what is written (0: nothing). */
  weight: number;
  /** Shown even without a message: a channel StayPut reads, a group connected. */
  followed: boolean;
}

interface Logged {
  account: LogAccount;
  at: number;
  place: string;
}

/** When a trading community writes, hour by hour of its day: mornings, the US open, evenings. */
const HOURS = [
  0.08, 0.05, 0.04, 0.04, 0.05, 0.1, 0.25, 0.6, 1.5, 1.7, 1.5, 1.1, 0.9, 0.9, 1.3, 1.6, 1.5, 1.0,
  0.9, 1.0, 1.3, 1.4, 1.1, 0.4,
];

const WINDOWS: readonly [ActivityWindow, number][] = [
  ['d7', 7],
  ['d14', 14],
  ['d30', 30],
];

export interface PlatformLog {
  dashboard: (platform: ActivityPlatform) => PlatformDashboard;
  day: (platform: ActivityPlatform, day: string) => PlatformDayView;
  slot: (platform: ActivityPlatform, dow: number, hour: number) => PlatformSlotView;
  /** A member's figures on each platform, as risk_features gives them (none: no account). */
  figures: (memberId: string) => Partial<Record<SignalPlatform, PlatformInputs>>;
  /** What a member's score is made of beyond its five factors; null for one not scored. */
  making: (member: MemberRow) => ScoreMaking | null;
  signals: () => Record<SignalPlatform, PlatformSignals>;
  saveSignals: (
    platform: AccountPlatform,
    signals: PlatformSignals,
  ) => Record<SignalPlatform, PlatformSignals>;
  /** A message written while the demo is open (the live feed): the log takes it. */
  record: (account: LogAccount, at: number) => void;
  /** The account's last message was at `at` (a line of the feed): its latest one moves there. */
  moveLast: (account: LogAccount, at: number) => void;
  /** Each of the 30 days' messages on a platform, the first first. */
  daily: (platform: ActivityPlatform) => number[];
}

export function createPlatformLog(input: {
  now: number;
  zone: string;
  accounts: readonly LogAccount[];
  rows: readonly MemberRow[];
  /** The places of a platform now (the channels followed may change). */
  places: (platform: ActivityPlatform) => readonly LogPlace[];
  /** The levels' thresholds now (Settings › Risk score). */
  thresholds: () => { mediumFrom: number; highFrom: number };
}): PlatformLog {
  const { now, zone, accounts, rows } = input;
  // Its own seed: the rest of the demo draws the same numbers as before.
  const random = seeded(20_261_005);
  const today = zonedDay(now, zone);
  const days = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  /** Whole days of the community's calendar between a moment and today. */
  const back = (time: number) =>
    Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${zonedDay(time, zone)}T00:00:00Z`)) / DAY,
    );
  const pick = (weights: readonly number[]) => {
    let left = random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
      left -= weights[i]!;
      if (left < 0) return i;
    }
    return weights.length - 1;
  };
  /** A day from `near` to `far` days back, the weekends quieter. */
  const pickDay = (near: number, far: number) => {
    const span = Array.from({ length: far - near + 1 }, (_, i) => near + i);
    const weights = span.map((d) => {
      const weekday = new Date(`${addDays(today, -d)}T12:00:00Z`).getUTCDay();
      return weekday === 0 || weekday === 6 ? 0.45 : 1;
    });
    return span[pick(weights)]!;
  };
  /** A moment of a day, at an hour the community writes, before `before`. */
  const momentOn = (daysBack: number, before: number) => {
    const day = addDays(today, -daysBack);
    const at = zonedMoment(day, pick(HOURS), Math.floor(random() * 60), zone);
    if (at < before) return at + Math.floor(random() * 50) * 1000;
    const start = zonedMoment(day, 0, 0, zone);
    return start + Math.floor(random() * Math.max(1, before - start));
  };
  const placeFor = (platform: ActivityPlatform) => {
    const places = input.places(platform).filter((p) => p.weight > 0);
    return places[pick(places.map((p) => p.weight))]?.id ?? '';
  };

  // ---- The messages, account by account ----
  const log: Logged[] = [];
  for (const account of accounts) {
    const joinedBack = Math.max(0, back(account.joinedAt));
    const last = account.lastAt;
    if (account.messages > 0 && last !== null) {
      const lastBack = back(last);
      const firstBack = Math.max(lastBack, Math.min(29, joinedBack));
      log.push({ account, at: last, place: placeFor(account.platform) });
      for (let i = 1; i < account.messages; i++) {
        log.push({
          account,
          at: momentOn(pickDay(lastBack, firstBack), last),
          place: placeFor(account.platform),
        });
      }
    }
    if (account.status !== 'member' || !account.member || joinedBack <= 30) continue;
    // The two months before: a member who writes there wrote there then; one who wrote nothing
    // these 30 days, up to their last sign of life there.
    const lastSeen = account.member.lastActivityAt
      ? Date.parse(account.member.lastActivityAt)
      : null;
    if (account.messages > 0) {
      const older = Math.round(account.messages * (0.5 + random() * 0.8));
      const far = Math.min(89, joinedBack);
      for (let i = 0; i < older; i++) {
        const daysBack = pickDay(30, far);
        log.push({ account, at: momentOn(daysBack, now), place: placeFor(account.platform) });
      }
    } else {
      // Nothing these 30 days: a member drifting away (and some others) wrote there before going
      // quiet, up to their last sign of life there when it is that old, else 31 to 60 days ago.
      const drifting = account.member.risk !== null && account.member.risk.level !== 'low';
      const seenBack = lastSeen === null ? null : back(lastSeen);
      if (!drifting && random() >= 0.3 && (seenBack === null || seenBack < 30)) continue;
      const lastBack =
        seenBack !== null && seenBack >= 30 && seenBack < 90
          ? seenBack
          : Math.min(joinedBack - 1, 31 + Math.floor(random() * 30));
      if (lastBack < 30) continue;
      const last = lastBack === seenBack && lastSeen !== null ? lastSeen : momentOn(lastBack, now);
      account.lastAt = last;
      log.push({ account, at: last, place: placeFor(account.platform) });
      const more = 1 + Math.floor(random() * 5);
      for (let i = 0; i < more; i++) {
        const daysBack = pickDay(lastBack, Math.min(89, joinedBack, lastBack + 25));
        log.push({ account, at: momentOn(daysBack, last), place: placeFor(account.platform) });
      }
    }
  }

  // ---- Counting it, as the Worker does ----
  const atRisk = (member: MemberRow | null) =>
    member?.risk?.level === 'high' || member?.risk?.level === 'scheduled_departure';
  const of = (platform: ActivityPlatform) => log.filter((m) => m.account.platform === platform);
  const within = (platform: ActivityPlatform, daysBack: number) =>
    of(platform).filter((m) => back(m.at) < daysBack);
  /** A member of the community wrote it (the team, guests and accounts not tied yet aside). */
  const byMember = (m: Logged) => m.account.status === 'member' && m.account.member !== null;
  const memberOf = (m: Logged) => m.account.member!;
  const asMember = (member: MemberRow, messages: number, lastAt: number): PlatformMember => ({
    id: member.id,
    name: member.name,
    messages,
    lastAt: new Date(lastAt).toISOString(),
    score: member.risk?.score ?? null,
    level: member.risk?.level ?? null,
  });

  /** The places, each with its messages, members and 3 most active members. */
  const placesOf = (platform: ActivityPlatform, messages: readonly Logged[]): PlatformPlace[] => {
    const known = input.places(platform);
    const ids = new Set([
      ...known.filter((p) => p.followed && p.kind !== 'topic').map((p) => p.id),
      ...messages.map((m) => m.place),
    ]);
    return [...ids]
      .map((id) => {
        const place = known.find((p) => p.id === id);
        const there = messages.filter((m) => m.place === id);
        const counts = new Map<string, { member: MemberRow; n: number }>();
        for (const m of there.filter(byMember)) {
          const entry = counts.get(memberOf(m).id) ?? { member: memberOf(m), n: 0 };
          entry.n += 1;
          counts.set(memberOf(m).id, entry);
        }
        return {
          id,
          kind:
            place?.kind ??
            (platform === 'discord' ? 'channel' : platform === 'whop' ? 'chat' : 'group'),
          name: place?.name ?? null,
          parent: place?.parent ?? null,
          messages: there.length,
          members: counts.size,
          lastAt:
            there.length > 0 ? new Date(Math.max(...there.map((m) => m.at))).toISOString() : null,
          top: [...counts.values()]
            .sort((a, b) => b.n - a.n || a.member.id.localeCompare(b.member.id))
            .slice(0, 3)
            .map(({ member, n }) => ({ id: member.id, name: member.name, messages: n })),
        } satisfies PlatformPlace;
      })
      .sort(
        (a, b) =>
          b.messages - a.messages ||
          (a.name ?? '￿').localeCompare(b.name ?? '￿') ||
          a.id.localeCompare(b.id),
      );
  };

  /** The community's members who wrote there over 90 days: their counts, their last message. */
  const people = (platform: ActivityPlatform) => {
    const byId = new Map<string, { member: MemberRow; at: number[] }>();
    for (const m of within(platform, 90).filter(byMember)) {
      const member = memberOf(m);
      if (member.status !== 'joined') continue;
      const entry = byId.get(member.id) ?? { member, at: [] };
      entry.at.push(m.at);
      byId.set(member.id, entry);
    }
    return [...byId.values()].map(({ member, at }) => ({
      member,
      last: Math.max(...at),
      count: (daysBack: number) => at.filter((t) => back(t) < daysBack).length,
      total: at.length,
    }));
  };

  let signals = allPlatformSignals({});

  const figures = (memberId: string) => {
    const result: Partial<Record<SignalPlatform, PlatformInputs>> = {};
    for (const platform of ['discord', 'telegram'] as const) {
      const account = accounts.find(
        (a) => a.platform === platform && a.status === 'member' && a.member?.id === memberId,
      );
      if (!account) continue;
      const mine = of(platform).filter((m) => m.account === account && back(m.at) < 35);
      result[platform] = {
        week: mine.filter((m) => back(m.at) < 7).length,
        before: mine.filter((m) => back(m.at) >= 7).length,
        lastAt: mine.length > 0 ? Math.max(...mine.map((m) => m.at)) : null,
        leftAt: account.leftAt,
      };
    }
    return result;
  };

  // The scores as the demo made them: the base each signal's points are added to.
  const base = new Map(rows.flatMap((m) => (m.risk ? [[m.id, m.risk.score] as const] : [])));
  const making = (member: MemberRow): ScoreMaking | null => {
    if (!member.risk) return null;
    const there = figures(member.id);
    const bits = (platform: SignalPlatform) => {
      const inputs = there[platform];
      return inputs
        ? firedSignals(inputs, now).reduce((total, id) => total | SIGNAL_BITS[id], 0)
        : 0;
    };
    return {
      base: base.get(member.id) ?? member.risk.score,
      discord: bits('discord'),
      telegram: bits('telegram'),
      rule: member.membership?.cancelAtPeriodEnd
        ? 1
        : member.lastPayment?.status === 'failed'
          ? 2
          : 0,
    };
  };

  return {
    dashboard: (platform) => {
      const recent = within(platform, 30);
      const everyone = people(platform);
      const daily: PlatformDay[] = days.map((day) => {
        const that = recent.filter((m) => zonedDay(m.at, zone) === day);
        const members = that.filter(byMember);
        return {
          day,
          messages: that.length,
          members: members.length,
          atRisk: members.filter((m) => atRisk(memberOf(m))).length,
        };
      });
      const cells = new Map<string, { cell: HeatCell; members: Set<string> }>();
      for (const m of recent) {
        const { dow, hour } = zonedClock(m.at, zone);
        const key = `${dow}:${hour}`;
        const entry = cells.get(key) ?? {
          cell: { dow, hour, messages: 0, members: 0 },
          members: new Set<string>(),
        };
        entry.cell.messages += 1;
        if (byMember(m)) entry.members.add(memberOf(m).id);
        cells.set(key, entry);
      }
      const groups = new Map<string, [number, number, number, number, number]>();
      for (const member of rows) {
        const made = member.status === 'joined' ? making(member) : null;
        if (!made) continue;
        const key = `${made.base}:${made.discord}:${made.telegram}:${made.rule}`;
        const group = groups.get(key) ?? [made.base, made.discord, made.telegram, made.rule, 0];
        group[4] += 1;
        groups.set(key, group);
      }
      const active = (daysBack: number) =>
        everyone
          .filter((p) => p.count(daysBack) > 0)
          .sort(
            (a, b) =>
              b.count(daysBack) - a.count(daysBack) ||
              b.last - a.last ||
              a.member.id.localeCompare(b.member.id),
          )
          .slice(0, 10)
          .map((p) => asMember(p.member, p.count(daysBack), p.last));
      const silent = (daysBack: number) => {
        const quiet = everyone
          .filter((p) => p.count(daysBack) === 0)
          .sort(
            (a, b) =>
              (b.member.risk?.score ?? -1) - (a.member.risk?.score ?? -1) ||
              b.last - a.last ||
              a.member.id.localeCompare(b.member.id),
          );
        return {
          total: quiet.length,
          members: quiet.slice(0, 10).map((p) => asMember(p.member, p.total, p.last)),
        };
      };
      const { mediumFrom, highFrom } = input.thresholds();
      return {
        platform,
        from: days[0]!,
        to: days[29]!,
        hero: {
          activeMembers7d: everyone.filter((p) => p.count(7) > 0).length,
          silentMembers7d: everyone.filter((p) => p.count(7) === 0).length,
          messages30d: recent.length,
          memberMessages30d: recent.filter(byMember).length,
        },
        daily,
        heatmap: [...cells.values()]
          .map(({ cell, members }) => ({ ...cell, members: members.size }))
          .sort((a, b) => a.dow - b.dow || a.hour - b.hour),
        places: placesOf(platform, recent),
        active: Object.fromEntries(WINDOWS.map(([key, n]) => [key, active(n)])) as Record<
          ActivityWindow,
          PlatformMember[]
        >,
        silent: Object.fromEntries(WINDOWS.map(([key, n]) => [key, silent(n)])) as Record<
          ActivityWindow,
          { total: number; members: PlatformMember[] }
        >,
        signals: {
          settings: signals,
          mediumFrom,
          highFrom,
          groups: [...groups.values()].sort(
            (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3],
          ),
        },
      };
    },
    day: (platform, day) => {
      const picked = within(platform, 31).filter((m) => zonedDay(m.at, zone) === day);
      const counts = new Map<string, { member: MemberRow; n: number; last: number }>();
      for (const m of picked.filter(byMember)) {
        const member = memberOf(m);
        if (member.status !== 'joined') continue;
        const entry = counts.get(member.id) ?? { member, n: 0, last: 0 };
        entry.n += 1;
        entry.last = Math.max(entry.last, m.at);
        counts.set(member.id, entry);
      }
      return {
        day,
        messages: picked.length,
        places: placesOf(platform, picked).filter((p) => p.messages > 0),
        active: [...counts.values()]
          .sort((a, b) => b.n - a.n || b.last - a.last || a.member.id.localeCompare(b.member.id))
          .slice(0, 20)
          .map(({ member, n, last }) => asMember(member, n, last)),
      };
    },
    slot: (platform, dow, hour) => {
      const picked = within(platform, 30).filter((m) => {
        const clock = zonedClock(m.at, zone);
        return clock.dow === dow && clock.hour === hour;
      });
      const counts = new Map<string, { member: MemberRow; n: number; last: number }>();
      for (const m of picked.filter(byMember)) {
        const member = memberOf(m);
        if (member.status !== 'joined') continue;
        const entry = counts.get(member.id) ?? { member, n: 0, last: 0 };
        entry.n += 1;
        entry.last = Math.max(entry.last, m.at);
        counts.set(member.id, entry);
      }
      const listed = [...counts.values()].reduce((total, c) => total + c.n, 0);
      return {
        dow,
        hour,
        messages: picked.length,
        others: picked.length - listed,
        members: [...counts.values()]
          .sort((a, b) => b.n - a.n || b.last - a.last || a.member.id.localeCompare(b.member.id))
          .slice(0, 50)
          .map(({ member, n, last }) => asMember(member, n, last)),
      };
    },
    figures,
    making,
    signals: () => signals,
    saveSignals: (platform, next) => {
      signals = { ...signals, [platform]: next };
      return signals;
    },
    record: (account, at) => {
      log.push({ account, at, place: placeFor(account.platform) });
    },
    moveLast: (account, at) => {
      const theirs = log.filter((m) => m.account === account);
      const latest = theirs.reduce<Logged | null>(
        (last, m) => (last === null || m.at > last.at ? m : last),
        null,
      );
      if (latest) latest.at = at;
    },
    daily: (platform) => {
      const recent = within(platform, 30);
      return days.map((day) => recent.filter((m) => zonedDay(m.at, zone) === day).length);
    },
  };
}

/** The signals the demo's settings say on, for a quick look in the tests. */
export function signalsOn(signals: Record<SignalPlatform, PlatformSignals>): string[] {
  return (['discord', 'telegram'] as const).flatMap((platform) =>
    PLATFORM_SIGNALS.filter((id) => signals[platform][id].on).map((id) => `${platform}:${id}`),
  );
}
