import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The app's Content Security Policy (public/_headers: `style-src 'self'`) refuses every inline
 * style block. Motion's AnimatePresence in « popLayout » mode injects one to pin the element
 * leaving (its PopChild): the browser blocks it, says so in the console, and the element is not
 * pinned. Only a real browser shows it (happy-dom gives elements no size, and PopChild then does
 * nothing): Inspect caught it on Members. This keeps that mode out of every screen.
 */

const SRC = path.resolve(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [full] : [];
  });
}

describe('the content security policy', () => {
  it('allows no inline style, so no screen uses a motion that injects one', () => {
    const headers = readFileSync(path.resolve(import.meta.dirname, '../public/_headers'), 'utf8');
    expect(headers).toMatch(/style-src 'self';/);
    const injecting = sources(SRC)
      .filter((file) => /mode=\{?["']popLayout["']\}?/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(injecting).toEqual([]);
  });
});
