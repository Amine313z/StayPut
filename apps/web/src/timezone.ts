import type { MessageKey } from '@stayput/i18n';

/**
 * The zones offered first, before the full list (the founder's choice): the United States, the
 * United Kingdom, France.
 */
export const SUGGESTED_TIME_ZONES: readonly { zone: string; label: MessageKey }[] = [
  { zone: 'America/New_York', label: 'actionSettings.timezone.newYork' },
  { zone: 'America/Chicago', label: 'actionSettings.timezone.chicago' },
  { zone: 'America/Denver', label: 'actionSettings.timezone.denver' },
  { zone: 'America/Los_Angeles', label: 'actionSettings.timezone.losAngeles' },
  { zone: 'Europe/London', label: 'actionSettings.timezone.london' },
  { zone: 'Europe/Paris', label: 'actionSettings.timezone.paris' },
];

const REGION =
  /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\//;

/**
 * The zones to choose from, by region (Europe, America…), the others (UTC) apart: the browser's
 * list, with the zone in effect even if the list lacks it.
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
