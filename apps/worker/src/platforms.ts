import {
  allPlatformSignals,
  type AccountPlatform,
  type PlatformDashboard,
  type PlatformDayView,
  type PlatformSignals,
  type PlatformSlotView,
  type SignalPlatform,
} from '@stayput/core';
import { withUser, type Db, type TransactionalDb } from './db';

/**
 * Integrations › Discord and › Telegram (brief v4 §9.6), each a dashboard: read as the creator
 * (each SQL function checks they administer the company, 0033), in the company's calendar. Who
 * wrote, where and when; never what.
 */

export function isPlatform(value: string): value is AccountPlatform {
  return value === 'discord' || value === 'telegram';
}

/** A day of the company's calendar, as the chart names it. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** The platform's dashboard; null when the company is not the user's. */
export async function readPlatformDashboard(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  platform: AccountPlatform,
  now: Date,
): Promise<PlatformDashboard | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: PlatformDashboard | null }>(
      'select stayput.platform_dashboard($1, $2, $3::timestamptz) as view',
      [companyId, platform, now.toISOString()],
    ),
  );
  const view = row?.view;
  if (!view) return null;
  // The signals as saved, each completed with StayPut's defaults.
  return {
    ...view,
    signals: { ...view.signals, settings: allPlatformSignals(view.signals.settings) },
  };
}

/** A day of the chart, picked; null when the company is not the user's. */
export async function readPlatformDay(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  platform: AccountPlatform,
  day: string,
  now: Date,
): Promise<PlatformDayView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: PlatformDayView | null }>(
      'select stayput.platform_day($1, $2, $3::timestamptz, $4::date) as view',
      [companyId, platform, now.toISOString(), day],
    ),
  );
  return row?.view ?? null;
}

/** A cell of the heatmap, picked; null when the company is not the user's. */
export async function readPlatformSlot(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  platform: AccountPlatform,
  dow: number,
  hour: number,
  now: Date,
): Promise<PlatformSlotView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: PlatformSlotView | null }>(
      'select stayput.platform_slot($1, $2, $3::timestamptz, $4, $5) as view',
      [companyId, platform, now.toISOString(), dow, hour],
    ),
  );
  return row?.view ?? null;
}

/** A platform's signals as the creator set them; every score is due again. Returns all. */
export async function savePlatformSignals(
  db: Db,
  companyId: string,
  platform: AccountPlatform,
  signals: PlatformSignals,
  now: Date,
): Promise<Record<SignalPlatform, PlatformSignals>> {
  const [row] = await db.query<{ settings: unknown }>(
    'select stayput.set_platform_signals($1, $2, $3::text::jsonb, $4::timestamptz) as settings',
    [companyId, platform, JSON.stringify(signals), now.toISOString()],
  );
  return allPlatformSignals(row?.settings);
}
