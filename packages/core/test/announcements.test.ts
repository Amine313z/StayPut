import { describe, expect, it } from 'vitest';
import { announcementText, parseAnnounceTarget } from '../src/announcements';

describe('the announcement of a milestone (SPEC Phase 5, point 4)', () => {
  it('says who, which goal and how far, in the community’s language, never the numbers', () => {
    expect(
      announcementText('fr', { firstName: 'Lina', goal: 'Signer 10 clients', percent: 50 }),
    ).toBe('🎉 Lina a atteint 50 % de son objectif : « Signer 10 clients » !');
    expect(announcementText('fr', { firstName: null, goal: 'Courir 10 km', percent: 100 })).toBe(
      '🏆 Un membre a atteint son objectif : « Courir 10 km » ! Bravo !',
    );
    expect(announcementText('en', { firstName: 'Sam', goal: 'Read 12 books', percent: 75 })).toBe(
      '🎉 Sam reached 75% of their goal: “Read 12 books”!',
    );
    expect(announcementText('en', { firstName: null, goal: 'Read 12 books', percent: 100 })).toBe(
      '🏆 A member reached their goal: “Read 12 books”! Congratulations!',
    );
  });

  it('goes to a place each platform names its way', () => {
    expect(parseAnnounceTarget({ platform: 'discord', id: '920000000000000001' })).toEqual({
      platform: 'discord',
      id: '920000000000000001',
    });
    expect(parseAnnounceTarget({ platform: 'telegram', id: '-1001234567890' })).not.toBeNull();
    expect(parseAnnounceTarget({ platform: 'whop', id: 'chat_Abc123' })).not.toBeNull();
    expect(parseAnnounceTarget({ platform: 'discord', id: 'general' })).toBeNull();
    expect(parseAnnounceTarget({ platform: 'slack', id: 'C123' })).toBeNull();
    expect(parseAnnounceTarget({ platform: 'whop', id: 'a/b' })).toBeNull();
    expect(parseAnnounceTarget(null)).toBeNull();
  });
});
