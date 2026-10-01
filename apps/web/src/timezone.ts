import { timeZoneName, type TimezoneAnswer } from '@stayput/core';
import { postJson } from './api';

/** The browser's time zone (an IANA name such as Europe/Paris), or null when it tells none. */
export function browserTimeZone(): string | null {
  try {
    return timeZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * Tells the Worker the creator's time zone, for a company that has none yet: the quiet hours and
 * the golden hour are the creator's local hours. The Worker keeps the first one it hears; the
 * creator changes it in the action settings. Nothing to show for it, so a failure stays silent
 * (the next visit tells it again).
 */
export function shareTimeZone(api: string): void {
  const timezone = browserTimeZone();
  if (!timezone) return;
  postJson<TimezoneAnswer>(`${api}/timezone`, { timezone }).catch(() => undefined);
}

const REGION =
  /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\//;

/**
 * The zones to choose from, by region (Europe, America…), the others (UTC) apart: the browser's
 * list, with the zone in effect and the browser's own even if the list lacks them.
 */
export function timeZoneGroups(
  ...wanted: (string | null)[]
): { region: string | null; zones: string[] }[] {
  let known: string[] = [];
  try {
    known = Intl.supportedValuesOf('timeZone');
  } catch {
    // An older browser: the zones in effect only.
  }
  const zones = [...new Set([...known, 'UTC', ...wanted.filter((z): z is string => !!z)])].sort();
  const groups = new Map<string | null, string[]>();
  for (const zone of zones) {
    const region = REGION.exec(zone)?.[1] ?? null;
    groups.set(region, [...(groups.get(region) ?? []), zone]);
  }
  return [...groups]
    .map(([region, list]) => ({ region, zones: list }))
    .sort((a, b) => (a.region ?? '~').localeCompare(b.region ?? '~'));
}

/** A zone as people read it: `America/New_York` → `America/New York`. */
export function zoneLabel(zone: string): string {
  return zone.replace(/_/g, ' ');
}
