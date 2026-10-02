import { describe, expect, it } from 'vitest';
import { VALUE_MAX, fitValue } from '../src/card';

/** Inter's bold letters average about 0.6 of the font's size. */
const measure = (size: number, text: string) => text.length * size * 0.6;
const WIDTH = 888;

describe('the result line of a testimonial card', () => {
  it('stays on one line, at full size when it fits', () => {
    expect(fitValue(measure, '0 € → 1 650 €', WIDTH)).toEqual({
      size: VALUE_MAX,
      lines: ['0 € → 1 650 €'],
    });
  });

  it('shrinks rather than cut a unit written as a word', () => {
    // At full size, « 0 séances → 6 séances » is 1109 wide: it used to end in « 6… ».
    const { size, lines } = fitValue(measure, '0 séances → 6 séances', WIDTH);
    expect(lines).toEqual(['0 séances → 6 séances']);
    expect(size).toBe(70);
    expect(measure(size, lines[0]!)).toBeLessThanOrEqual(WIDTH);
  });

  it('goes on two lines after the arrow when one line would be too small', () => {
    const value = '0 heures de pratique → 120 heures de pratique';
    expect(fitValue(measure, value, WIDTH)).toEqual({
      size: 66,
      lines: ['0 heures de pratique →', '120 heures de pratique'],
    });
    // The longest unit (20 characters) with big numbers still fits whole.
    const longest = `1 000 000 ${'a'.repeat(20)} → 2 000 000 ${'a'.repeat(20)}`;
    const fitted = fitValue(measure, longest, WIDTH);
    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines.join(' ')).toBe(longest);
    expect(fitted.lines.every((line) => measure(fitted.size, line) <= WIDTH)).toBe(true);
  });

  it('keeps two lines within the room left on the card', () => {
    const value = '0 heures de pratique → 120 heures de pratique';
    expect(fitValue(measure, value, WIDTH, 41)).toEqual({
      size: 41,
      lines: ['0 heures de pratique →', '120 heures de pratique'],
    });
    // Never below the floor; one line when it fits as big as two would be.
    expect(fitValue(measure, value, WIDTH, 10).size).toBe(36);
    expect(fitValue(measure, '0 kg → 12 kg', WIDTH, 10)).toEqual({
      size: VALUE_MAX,
      lines: ['0 kg → 12 kg'],
    });
  });
});
