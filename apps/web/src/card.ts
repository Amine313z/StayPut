import type { ProofLevel, TestimonialCard } from '@stayput/core';
import type { MessageKey, Translator } from '@stayput/i18n';
import qrcode from 'qrcode-generator';
import { unitFormatter } from './units';

/**
 * The testimonial card (SPEC Phase 5, point 6), drawn in the member's browser: their result, its
 * level of proof, their name if they ticked it, and a QR code to its public page. 1080 × 1350,
 * the portrait every social network shows whole. Its own colors, whatever the page's theme: it
 * is an image people share.
 */

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

/** The words on the card, already in the member's language. */
export interface CardContent {
  from: string;
  goal: string;
  value: string;
  progress: number;
  progressText: string;
  level: string;
  justified: boolean;
  by: string;
  verify: string;
  /** The public page's address, under the QR code. */
  url: string;
  join: string | null;
}

/** StayPut's palette (src/styles.css): black-900, black-700, white-100, white-300, turq-300, black-600. */
const COLORS = {
  background: '#050607',
  panel: '#11161b',
  text: '#ffffff',
  muted: '#d9dee3',
  accent: '#5eead4',
  track: '#1a2129',
};

const FONT = '"Geist Variable", Geist, system-ui, -apple-system, "Segoe UI", sans-serif';
const PAD = 96;

/** The QR code of an address, as rows of dark modules (medium error correction). */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col)),
  );
}

/** A word wider than `width` (an address has no space), cut where it stops fitting. */
function breakWord(measure: (text: string) => number, word: string, width: number): string[] {
  if (measure(word) <= width) return [word];
  const parts: string[] = [];
  let part = '';
  for (const char of word) {
    if (part && measure(part + char) > width) {
      parts.push(part);
      part = char;
    } else {
      part += char;
    }
  }
  if (part) parts.push(part);
  return parts;
}

/** A text cut into lines no wider than `width`, at most `max` (the last one ends with …). */
export function wrapText(
  measure: (text: string) => number,
  text: string,
  width: number,
  max: number,
): string[] {
  const lines: string[] = [];
  let line = '';
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => breakWord(measure, word, width));
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= width || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1]!;
  while (last.length > 1 && measure(`${last}…`) > width) last = last.slice(0, -1);
  kept[max - 1] = `${last.trimEnd()}…`;
  return kept;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONTS = {
  from: `500 34px ${FONT}`,
  goal: `700 68px ${FONT}`,
  progress: `500 34px ${FONT}`,
  level: `600 34px ${FONT}`,
  by: `500 32px ${FONT}`,
  verify: `700 34px ${FONT}`,
  url: `500 24px ${FONT}`,
  join: `600 26px ${FONT}`,
  brand: `700 26px ${FONT}`,
};

/** The QR code's square: at most this wide, whole pixels per module, a quiet zone of four. */
const QR_MAX = 300;
export const QR_QUIET = 4;

/**
 * The result's line (« 0 sessions → 12 sessions »), never cut: as big as it fits on one line, down
 * to VALUE_MIN; past that, on two lines split after the arrow, each as big as fits and as the room
 * left on the card allows (`twoLinesMax`).
 */
export const VALUE_MAX = 88;
const VALUE_MIN = 56;
const VALUE_FLOOR = 36;
const ARROW = ' → ';

const valueFont = (size: number) => `800 ${size}px ${FONT}`;

/** The size and lines of the result, for `measure(size, text)` and the card's width. */
export function fitValue(
  measure: (size: number, text: string) => number,
  value: string,
  width: number,
  twoLinesMax = VALUE_MAX,
): { size: number; lines: string[] } {
  const fits = (size: number, lines: string[]) =>
    lines.every((line) => measure(size, line) <= width);
  const largest = (lines: string[], from: number) => {
    let size = Math.max(VALUE_FLOOR, Math.floor(from));
    while (size > VALUE_FLOOR && !fits(size, lines)) size -= 2;
    return Math.max(VALUE_FLOOR, size);
  };
  const one = largest([value], VALUE_MAX);
  if (one >= VALUE_MIN && fits(one, [value])) return { size: one, lines: [value] };
  const at = value.indexOf(ARROW);
  const halves =
    at > 0 ? [value.slice(0, at + ARROW.length - 1), value.slice(at + ARROW.length)] : [value];
  const two = largest(halves, Math.min(VALUE_MAX, twoLinesMax));
  if (fits(one, [value]) && one >= two) return { size: one, lines: [value] };
  return {
    size: two,
    lines: fits(two, halves) ? halves : wrapText((text) => measure(two, text), value, width, 2),
  };
}

/** Draws the card on a 1080 × 1350 canvas. */
export function drawCard(ctx: CanvasRenderingContext2D, card: CardContent): void {
  const width = CARD_WIDTH - PAD * 2;
  const measureIn = (font: string) => (text: string) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // The QR code, at the bottom: whole pixels per module on a white square, so that every phone
  // reads it.
  const modules = qrModules(card.url);
  const cell = Math.floor(QR_MAX / (modules.length + QR_QUIET * 2));
  const square = cell * (modules.length + QR_QUIET * 2);
  const qrTop = CARD_HEIGHT - PAD - square;

  // The result, centered in the space above it. A smaller result keeps the same gap above its
  // capitals (about 0.72 of its size); a second line adds its height (1.14 of its size), so two
  // lines are as big as the room left allows.
  const from = wrapText(measureIn(FONTS.from), card.from, width, 2);
  const goal = wrapText(measureIn(FONTS.goal), card.goal, width, 3);
  const room = qrTop - 64 - PAD;
  const base = 34 + from.length * 46 + goal.length * 82 + 414;
  const twoLinesMax = Math.floor((room - base + VALUE_MAX * 0.72) / (1.14 + 0.72));
  const value = fitValue(
    (size, text) => measureIn(valueFont(size))(text),
    card.value,
    width,
    twoLinesMax,
  );
  const valueLine = Math.round(value.size * 1.14);
  const valueShift = Math.round((VALUE_MAX - value.size) * 0.72);
  const block = base - valueShift + (value.lines.length - 1) * valueLine;
  let y = PAD + 34 + Math.max(0, Math.floor((room - block) / 2));

  ctx.fillStyle = COLORS.muted;
  ctx.font = FONTS.from;
  from.forEach((line, i) => ctx.fillText(line, PAD, y + i * 46));
  y += from.length * 46 + 60;

  ctx.fillStyle = COLORS.text;
  ctx.font = FONTS.goal;
  goal.forEach((line, i) => ctx.fillText(line, PAD, y + i * 82));
  y += goal.length * 82 + 70;

  y -= valueShift;
  ctx.fillStyle = COLORS.accent;
  ctx.font = valueFont(value.size);
  value.lines.forEach((line, i) => ctx.fillText(line, PAD, y + i * valueLine));
  y += (value.lines.length - 1) * valueLine;

  y += 50;
  ctx.fillStyle = COLORS.track;
  roundRect(ctx, PAD, y, width, 24, 12);
  ctx.fill();
  const done = Math.max(0, Math.min(100, card.progress));
  if (done > 0) {
    ctx.fillStyle = COLORS.accent;
    roundRect(ctx, PAD, y, Math.max(24, (width * done) / 100), 24, 12);
    ctx.fill();
  }
  y += 74;
  ctx.fillStyle = COLORS.muted;
  ctx.font = FONTS.progress;
  ctx.fillText(card.progressText, PAD, y);

  y += 80;
  const level = wrapText(measureIn(FONTS.level), card.level, width - 48, 1)[0] ?? '';
  const pill = measureIn(FONTS.level)(level) + 48;
  ctx.fillStyle = card.justified ? COLORS.accent : COLORS.panel;
  roundRect(ctx, PAD, y - 46, pill, 64, 32);
  ctx.fill();
  ctx.fillStyle = card.justified ? COLORS.background : COLORS.text;
  ctx.font = FONTS.level;
  ctx.fillText(level, PAD + 24, y);

  y += 72;
  const by = wrapText(measureIn(FONTS.by), card.by, width, 1)[0] ?? '';
  ctx.fillStyle = COLORS.muted;
  ctx.font = FONTS.by;
  ctx.fillText(by, PAD, y);

  ctx.fillStyle = COLORS.text;
  roundRect(ctx, PAD, qrTop, square, square, 16);
  ctx.fill();
  ctx.fillStyle = COLORS.background;
  const origin = { x: PAD + cell * QR_QUIET, y: qrTop + cell * QR_QUIET };
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) ctx.fillRect(origin.x + c * cell, origin.y + r * cell, cell, cell);
    }),
  );

  // Beside it: what it leads to.
  const textLeft = PAD + square + 40;
  const textWidth = CARD_WIDTH - PAD - textLeft;
  const verify = wrapText(measureIn(FONTS.verify), card.verify, textWidth, 2);
  ctx.fillStyle = COLORS.text;
  ctx.font = FONTS.verify;
  verify.forEach((line, i) => ctx.fillText(line, textLeft, qrTop + 56 + i * 42));
  let below = qrTop + 56 + verify.length * 42;
  const url = wrapText(measureIn(FONTS.url), card.url.replace(/^https:\/\//, ''), textWidth, 3);
  ctx.fillStyle = COLORS.muted;
  ctx.font = FONTS.url;
  url.forEach((line, i) => ctx.fillText(line, textLeft, below + i * 32));
  below += url.length * 32 + 24;
  if (card.join) {
    const join = wrapText(measureIn(FONTS.join), card.join, textWidth, 2);
    ctx.fillStyle = COLORS.accent;
    ctx.font = FONTS.join;
    join.forEach((line, i) => ctx.fillText(line, textLeft, below + i * 34));
  }
  ctx.fillStyle = COLORS.muted;
  ctx.font = FONTS.brand;
  ctx.textAlign = 'right';
  ctx.fillText('StayPut', CARD_WIDTH - PAD, CARD_HEIGHT - PAD + 10);
  ctx.textAlign = 'left';
}

const LEVELS: Readonly<Record<ProofLevel, MessageKey>> = {
  justified: 'card.image.level.justified',
  declared: 'card.image.level.declared',
  connected: 'card.image.level.connected',
};

/** The words of a card, in the member's language (the dates: the community's calendar day). */
export function cardContent(card: TestimonialCard, i18n: Translator): CardContent {
  const { t, percent, date } = i18n;
  const withUnit = unitFormatter(i18n);
  const d = card.display;
  const day = date(new Date(`${d.day}T12:00:00`));
  return {
    from: d.community ? t('card.image.from', { community: d.community }) : t('card.image.fromAnon'),
    goal: d.goal,
    value: `${withUnit(d.start, d.unit)} → ${withUnit(d.value, d.unit)}`,
    progress: d.progress,
    progressText: t('card.image.progress', {
      percent: percent(d.progress / 100),
      target: withUnit(d.target, d.unit),
    }),
    level: t(LEVELS[card.level]),
    justified: card.level !== 'declared',
    by: d.name
      ? t('card.image.by', { name: d.name, date: day })
      : t('card.image.byAnon', { date: day }),
    verify: t('card.image.verify'),
    url: card.url,
    join: d.affiliateUrl
      ? d.community
        ? t('card.image.join', { community: d.community })
        : t('card.image.joinAnon')
      : null,
  };
}

/** Geist, the page's font, loaded before the card is drawn with it: 3 seconds at most. */
async function fontsLoaded(text: string): Promise<void> {
  const fonts = 'fonts' in document ? document.fonts : null;
  if (typeof fonts?.load !== 'function') return;
  try {
    await Promise.race([
      Promise.all(
        [500, 600, 700, 800].map((weight) => fonts.load(`${weight} 40px "Geist Variable"`, text)),
      ),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  } catch {
    // Drawn with the fallback font.
  }
}

/**
 * The card as a PNG, in a `data:` address (the page's policy lets images use them): to show
 * and to download. Null where the browser cannot draw.
 */
export async function renderCard(card: CardContent): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    await fontsLoaded([card.from, card.goal, card.value, card.by, card.level].join(' '));
    drawCard(ctx, card);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
