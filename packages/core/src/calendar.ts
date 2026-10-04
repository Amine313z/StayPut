/**
 * A community's calendar (fix prompt v4.1, block 2): the day a moment falls on in the
 * community's time zone (Settings › Automations › Time zone), as Postgres gives it with
 * `(moment at time zone zone)::date`. Never the reader's locale nor the browser's time zone: a
 * save at 00:30 or at 23:30 there is on that day for everyone. Days are `YYYY-MM-DD` keys.
 */

const dayFormats = new Map<string, Intl.DateTimeFormat | null>();

/** The calendar day of `time` in `timezone`; UTC's for a zone the runtime does not know. */
export function zonedDay(time: number, timezone: string): string {
  let format = dayFormats.get(timezone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      format = null;
    }
    dayFormats.set(timezone, format);
  }
  if (!format) return new Date(time).toISOString().slice(0, 10);
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const { type, value } of format.formatToParts(time)) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The day `days` after `day` (before, when negative), across months and years. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** The 1st of the month of `day`. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

const clockFormats = new Map<string, Intl.DateTimeFormat | null>();
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Where `time` falls in `timezone`'s calendar: its day, its day of the week (1 Monday to 7
 * Sunday, Postgres's `isodow`), its hour (0 to 23) and minute. UTC's for a zone the runtime does
 * not know.
 */
export function zonedClock(
  time: number,
  timezone: string,
): { day: string; dow: number; hour: number; minute: number } {
  let format = clockFormats.get(timezone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      format = null;
    }
    clockFormats.set(timezone, format);
  }
  if (!format) return zonedClock(time, 'UTC');
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const { type, value } of format.formatToParts(time)) parts[type] = value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    dow: WEEKDAYS.indexOf(parts.weekday ?? 'Mon') + 1,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** The moment it is `hour`:`minute` on `day` in `timezone` (the earlier one when it is twice). */
export function zonedMoment(day: string, hour: number, minute: number, timezone: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(year, month - 1, date, hour, minute);
  let moment = wanted;
  // The zone's offset at that moment, read twice: once more after a change of time.
  for (let i = 0; i < 2; i++) {
    const clock = zonedClock(moment, timezone);
    const [y, m, d] = clock.day.split('-').map(Number) as [number, number, number];
    moment += wanted - Date.UTC(y, m - 1, d, clock.hour, clock.minute);
  }
  return moment;
}
