import { describe, expect, it } from 'vitest';
import { addDays, monthStart, zonedDay } from '../src/calendar';

describe('a community’s calendar (fix prompt v4.1, block 2)', () => {
  it('puts a moment at 00:30 or at 23:30 there on that day, east or west of UTC', () => {
    // Paris (UTC+2 in October): 00:30 on 1 October is still 30 September in UTC.
    expect(zonedDay(Date.parse('2026-09-30T22:30:00Z'), 'Europe/Paris')).toBe('2026-10-01');
    expect(zonedDay(Date.parse('2026-09-30T21:30:00Z'), 'Europe/Paris')).toBe('2026-09-30');
    // New York (UTC−4): 23:30 on 30 September is already 1 October in UTC.
    expect(zonedDay(Date.parse('2026-10-01T03:30:00Z'), 'America/New_York')).toBe('2026-09-30');
    expect(zonedDay(Date.parse('2026-10-01T04:30:00Z'), 'America/New_York')).toBe('2026-10-01');
    // Tokyo (UTC+9) and an Indian half hour (UTC+5:30).
    expect(zonedDay(Date.parse('2026-09-30T15:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-01');
    expect(zonedDay(Date.parse('2026-09-30T18:15:00Z'), 'Asia/Kolkata')).toBe('2026-09-30');
    expect(zonedDay(Date.parse('2026-09-30T18:45:00Z'), 'Asia/Kolkata')).toBe('2026-10-01');
  });

  it('follows the clock changes, and falls back to UTC for a zone nobody knows', () => {
    // Paris goes back to UTC+1 on 25 October 2026 at 03:00.
    expect(zonedDay(Date.parse('2026-10-25T22:30:00Z'), 'Europe/Paris')).toBe('2026-10-25');
    expect(zonedDay(Date.parse('2026-10-25T23:30:00Z'), 'Europe/Paris')).toBe('2026-10-26');
    // And forward to UTC+2 on 29 March 2026 at 02:00.
    expect(zonedDay(Date.parse('2026-03-28T23:30:00Z'), 'Europe/Paris')).toBe('2026-03-29');
    expect(zonedDay(Date.parse('2026-03-28T22:30:00Z'), 'Europe/Paris')).toBe('2026-03-28');
    expect(zonedDay(Date.parse('2026-09-30T23:30:00Z'), 'Mars/Olympus')).toBe('2026-09-30');
    expect(zonedDay(Date.parse('2026-09-30T23:30:00Z'), 'UTC')).toBe('2026-09-30');
  });

  it('steps from day to day across months, leap days and years', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-03', -89)).toBe('2026-07-06');
    expect(monthStart('2026-10-03')).toBe('2026-10-01');
  });
});
