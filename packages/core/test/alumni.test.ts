import { describe, expect, it } from 'vitest';
import { alumniReturnRate } from '../src/alumni';

describe('the Alumni’s return rate', () => {
  it('counts who came back among everyone who ever entered', () => {
    expect(alumniReturnRate({ entered: 9, left: 1, returned: 2 })).toBe(2 / 12);
    expect(alumniReturnRate({ entered: 0, left: 0, returned: 3 })).toBe(1);
    expect(alumniReturnRate({ entered: 4, left: 2, returned: 0 })).toBe(0);
  });

  it('has none while nobody entered', () => {
    expect(alumniReturnRate({ entered: 0, left: 0, returned: 0 })).toBeNull();
  });
});
