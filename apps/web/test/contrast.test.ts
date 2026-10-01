import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WCAG AA (4.5:1 for text) for every foreground / background pair the screens use, in both
 * themes, recomputed from the tokens of src/styles.css (SPEC 5.7, accessibility).
 */

const css = readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf('}', start));
  const found: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)) {
    if (name && value) found[name] = value;
  }
  return found;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

// [text, background] as the components combine them.
const PAIRS = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-2'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-2'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'surface-2'],
  ['on-accent', 'accent'],
  ['accent', 'accent-soft'],
  ['text', 'accent-soft'],
  ['danger', 'surface'],
  ['danger', 'danger-soft'],
  ['text', 'danger-soft'],
  ['warning', 'surface'],
  ['warning', 'warning-soft'],
  ['info', 'surface'],
  ['info', 'info-soft'],
] as const;

describe.each([
  ['light', ':root'],
  ['dark', "[data-theme='dark']"],
])('%s theme', (_name, selector) => {
  const palette = tokens(selector);

  it('defines every token', () => {
    for (const token of new Set(PAIRS.flat())) expect(palette[token], token).toMatch(/^#/);
  });

  it.each(PAIRS)('%s on %s reaches 4.5:1', (fg, bg) => {
    expect(contrast(palette[fg]!, palette[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
