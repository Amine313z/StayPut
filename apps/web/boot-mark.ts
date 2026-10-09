import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// This folder, from Vite's bundled config (a file URL) as from the tests (a directory).
const here =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url));

/** StayPut's mark as the loading screen draws it: 128 px (64 on screen, sharp on retina), WebP. */
export const BOOT_MARK = path.join(here, 'public/logo-boot.webp');

/**
 * The loading screen (index.html #boot) draws StayPut's mark with the first paint: the mark is
 * written into the page itself (under 3 KB), never a file asked for alongside the page's code,
 * which could leave the screen without it while that code loads (the CSP allows data: images).
 */
export function inlineBootMark(html: string, mark: Buffer = readFileSync(BOOT_MARK)): string {
  const src = 'src="/logo-boot.webp"';
  if (!html.includes(src)) throw new Error('index.html: the loading screen has no /logo-boot.webp');
  return html.replace(src, `src="data:image/webp;base64,${mark.toString('base64')}"`);
}

export function bootMark(): Plugin {
  return { name: 'stayput-boot-mark', transformIndexHtml: (html) => inlineBootMark(html) };
}
