import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * StayPut's palette is the brief's (v3 §4), exactly, and nothing else: src/styles.css defines
 * these eleven colors and the glow, every other color it writes is one of them (at most with an
 * alpha), and so is every color written in the components. Every text / background pair the
 * screens use reaches WCAG AA (4.5:1), recomputed from the tokens (SPEC 5.7, accessibility).
 */

const root = path.resolve(import.meta.dirname, '..');
const css = readFileSync(path.join(root, 'src/styles.css'), 'utf8');

const PALETTE = {
  'black-900': '#050607',
  'black-800': '#0a0d10',
  'black-700': '#11161b',
  'black-600': '#1a2129',
  'turq-100': '#9ff5ea',
  'turq-300': '#5eead4',
  'turq-500': '#2bc4b4',
  'white-100': '#ffffff',
  'white-300': '#d9dee3',
  'white-500': '#8a94a0',
  urgent: '#ff5c5c',
} as const;

const TRIPLETS = new Set(
  Object.values(PALETTE).map((hex) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' '),
  ),
);

/** The custom properties of `:root`, each `var()` followed to its color. */
function rootTokens(): Record<string, string> {
  const start = css.indexOf(':root {');
  const block = css.slice(start, css.indexOf('\n}', start));
  const raw: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    if (name && value) raw[name] = value.trim();
  }
  const resolve = (value: string, depth = 0): string => {
    const ref = /^var\(--([\w-]+)\)$/.exec(value);
    const next = ref?.[1] ? raw[ref[1]] : undefined;
    return next && depth < 5 ? resolve(next, depth + 1) : value;
  };
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, resolve(value)]));
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

/** Every color literal of a text: `#rrggbb`, `#rgb` and `rgb()` / `rgba()`. */
function colorsIn(text: string): string[] {
  return [...text.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi)].map(([found]) =>
    found.toLowerCase(),
  );
}

/** Whether a color literal is one of the palette's, at most with an alpha. */
function inPalette(color: string): boolean {
  if (color.startsWith('#')) return (Object.values(PALETTE) as string[]).includes(color);
  const channels = color
    .replace(/rgba?\(|\)/g, '')
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  return TRIPLETS.has(channels);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('the palette', () => {
  const tokens = rootTokens();

  it('is exactly the brief’s: black, light turquoise, white, and red for what is urgent', () => {
    for (const [name, hex] of Object.entries(PALETTE)) expect(tokens[name], name).toBe(hex);
    expect(tokens['turq-glow']).toBe('rgb(94 234 212 / 0.18)');
  });

  it('is the only one in the stylesheet: every color written is one of its, at most with an alpha', () => {
    expect(colorsIn(css).filter((color) => !inPalette(color))).toEqual([]);
  });

  it('is the only one in the components', () => {
    const strays = sources(path.join(root, 'src')).flatMap((file) =>
      colorsIn(readFileSync(file, 'utf8'))
        .filter((color) => !inPalette(color))
        .map((color) => `${path.relative(root, file)}: ${color}`),
    );
    expect(strays).toEqual([]);
  });

  it('gives every role one of its colors', () => {
    const roles = ['bg', 'surface', 'surface-2', 'surface-3', 'text', 'muted', 'subtle', 'border'];
    for (const role of [...roles, 'accent', 'accent-2', 'accent-soft', 'on-accent', 'danger']) {
      expect(Object.values(PALETTE), role).toContain(tokens[role]);
    }
  });
});

// [text, background] as the components combine them.
const PAIRS = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-2'],
  ['text', 'surface-3'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-2'],
  ['muted', 'surface-3'],
  ['subtle', 'bg'],
  ['subtle', 'surface'],
  ['subtle', 'surface-2'],
  ['subtle', 'surface-3'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'surface-2'],
  ['text', 'accent-soft'],
  ['accent', 'accent-soft'],
  // The primary button: black on the signature gradient, at both ends and pressed.
  ['on-accent', 'hero-from'],
  ['on-accent', 'hero-to'],
  ['on-accent', 'accent'],
  ['on-accent', 'accent-2'],
  ['danger', 'surface'],
  ['danger', 'surface-2'],
  ['warning', 'surface'],
  ['serious', 'surface'],
  ['info', 'surface'],
] as const;

describe('contrast', () => {
  const tokens = rootTokens();

  it.each(PAIRS)('%s on %s reaches 4.5:1', (fg, bg) => {
    expect(tokens[fg]).toMatch(/^#/);
    expect(tokens[bg]).toMatch(/^#/);
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
