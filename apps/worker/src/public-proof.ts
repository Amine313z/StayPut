import type { ProofLevel, TemplateLocale, TestimonialDisplay } from '@stayput/core';

/**
 * The public page of a proof, /v/:proofId (SPEC Phase 5, point 7): one result, its level of
 * proof and its date, in the community's language, with only what the member agreed to show.
 * Plain HTML from the Worker, no script: a page anyone may open from a card's QR code.
 */

const WORDS: Readonly<
  Record<
    TemplateLocale,
    {
      from: (community: string | null) => string;
      progress: (percent: string, target: string) => string;
      level: Record<ProofLevel, string>;
      by: (name: string | null) => string;
      on: (date: string) => string;
      join: (community: string | null) => string;
      note: string;
      footer: string;
      gone: string;
      goneBody: string;
    }
  >
> = {
  fr: {
    from: (c) => (c ? `Le résultat d’un membre de ${c}` : 'Le résultat d’un membre'),
    progress: (p, t) => `${p} de l’objectif (${t})`,
    level: {
      justified: '✓ Appuyé par une capture d’écran',
      declared: 'Déclaré par le membre',
      connected: '✓ Relevé d’une source connectée',
    },
    by: (n) => (n ? `Par ${n}` : 'Par un membre de la communauté'),
    on: (d) => `Le ${d}`,
    join: (c) => (c ? `Rejoindre ${c}` : 'Rejoindre la communauté'),
    note: '« Appuyé par une capture » : le nombre figure sur une capture d’écran lue dans le navigateur du membre ; StayPut n’en garde que l’empreinte, jamais l’image. « Déclaré » : le membre l’a noté lui-même.',
    footer: 'Publié avec StayPut',
    gone: 'Cette page n’existe pas',
    goneBody: 'Ce résultat n’est pas public, ou son membre l’a retiré.',
  },
  en: {
    from: (c) => (c ? `A result from a member of ${c}` : 'A result from a member'),
    progress: (p, t) => `${p} of the goal (${t})`,
    level: {
      justified: '✓ Backed by a screenshot',
      declared: 'Declared by the member',
      connected: '✓ Read from a connected source',
    },
    by: (n) => (n ? `By ${n}` : 'By a member of the community'),
    on: (d) => `On ${d}`,
    join: (c) => (c ? `Join ${c}` : 'Join the community'),
    note: '“Backed by a screenshot”: the number is on a screenshot read in the member’s browser; StayPut keeps only its fingerprint, never the image. “Declared”: the member recorded it themselves.',
    footer: 'Published with StayPut',
    gone: 'This page does not exist',
    goneBody: 'This result is not public, or its member took it down.',
  },
};

/** The bar widths, one class per percent: the style holds them, the page names one. */
const BAR_STYLE = Array.from({ length: 101 }, (_, i) => `.w${i}{width:${i}%}`).join('');

const STYLE = [
  ':root{color-scheme:light dark;--bg:#f6f7f5;--card:#fff;--fg:#111a17;--muted:#56625d;',
  '--accent:#0f7a5c;--line:#dfe4e1}',
  '@media (prefers-color-scheme:dark){:root{--bg:#0d1412;--card:#152019;--fg:#eef3f0;',
  '--muted:#a3b2ab;--accent:#4fd1a5;--line:#26332d}}',
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;',
  'background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
  'main{width:100%;max-width:520px;background:var(--card);border:1px solid var(--line);',
  'border-radius:20px;padding:28px}',
  '.from{margin:0;color:var(--muted);font-size:14px}',
  'h1{margin:8px 0 16px;font-size:26px;line-height:1.25}',
  '.value{margin:0;font-size:32px;font-weight:700;font-variant-numeric:tabular-nums}',
  '.bar{height:10px;border-radius:999px;background:var(--line);overflow:hidden;margin:16px 0 6px}',
  '.bar>span{display:block;height:100%;background:var(--accent)}',
  '.progress{margin:0;color:var(--muted);font-size:14px}',
  '.level{display:inline-block;margin:18px 0 0;padding:4px 10px;border-radius:999px;',
  'border:1px solid var(--line);font-size:14px;font-weight:600}',
  '.meta{margin:14px 0 0;color:var(--muted);font-size:14px}',
  '.join{display:inline-block;margin-top:20px;padding:10px 16px;border-radius:10px;',
  'background:var(--accent);color:var(--card);font-weight:600;text-decoration:none}',
  '.note{margin:22px 0 0;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);',
  'font-size:13px}',
  'footer{margin-top:16px;color:var(--muted);font-size:12px}',
  // A phone, or StayPut's window showing the page: smaller margins, the result on one line.
  '@media (max-width:480px){body{padding:12px}main{padding:20px}h1{font-size:22px}',
  '.value{font-size:28px}}',
  BAR_STYLE,
].join('');

export function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A number with its unit, as people write them (the member space writes them the same way). */
function withUnit(value: number, unit: string, locale: TemplateLocale): string {
  const n = new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    maximumFractionDigits: 2,
  }).format(value);
  if (unit === '%') return locale === 'fr' ? `${n}\u00a0%` : `${n}%`;
  if (locale === 'en' && ['$', '€', '£'].includes(unit)) return `${unit}${n}`;
  return `${n}\u00a0${unit}`;
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The page's headers: HTML, and a policy that allows its own style and nothing else. */
export async function headers(): Promise<Record<string, string>> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy':
      `default-src 'none'; style-src 'sha256-${await sha256Base64(STYLE)}'; ` +
      "base-uri 'none'; form-action 'none'",
  };
}

export function page(
  locale: TemplateLocale,
  title: string,
  body: string,
  description: string,
): string {
  return [
    '<!doctype html>',
    `<html lang="${locale}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(description)}">`,
    `<meta property="og:title" content="${escape(title)}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    '<meta name="robots" content="noindex">',
    `<style>${STYLE}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

/** The page of a published proof. */
export async function proofPage(proof: {
  level: ProofLevel;
  display: TestimonialDisplay;
}): Promise<Response> {
  const d = proof.display;
  const locale = d.locale;
  const w = WORDS[locale];
  // The result's day where the community lives, as the card shows it.
  const date = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${d.day}T12:00:00Z`));
  const percent = locale === 'fr' ? `${d.progress}\u00a0%` : `${d.progress}%`;
  const value = `${withUnit(d.start, d.unit, locale)} → ${withUnit(d.value, d.unit, locale)}`;
  const progress = Math.max(0, Math.min(100, d.progress));
  // The bar's width is the page's only number in its style: written as a class, so that the
  // policy allows no inline style.
  const bar = `<div class="bar" role="img" aria-label="${escape(percent)}"><span class="w${progress}"></span></div>`;
  const body = [
    '<main>',
    `<p class="from">${escape(w.from(d.community))}</p>`,
    `<h1>${escape(d.goal)}</h1>`,
    `<p class="value">${escape(value)}</p>`,
    bar,
    `<p class="progress">${escape(w.progress(percent, withUnit(d.target, d.unit, locale)))}</p>`,
    `<p class="level">${escape(w.level[proof.level])}</p>`,
    `<p class="meta">${escape(`${w.by(d.name)} · ${w.on(date)}`)}</p>`,
    // In a new tab: Whop's pages refuse to open inside another page, as in StayPut's preview.
    d.affiliateUrl
      ? `<a class="join" href="${escape(d.affiliateUrl)}" target="_blank" rel="noopener nofollow">${escape(w.join(d.community))}</a>`
      : '',
    `<p class="note">${escape(w.note)}</p>`,
    `<footer>${escape(w.footer)}</footer>`,
    '</main>',
  ].join('\n');
  const title = `${d.goal} · ${percent}`;
  return new Response(page(locale, title, body, `${w.from(d.community)} · ${value}`), {
    headers: await headers(),
  });
}

/** The page of a proof that is not public (never published, taken down, unknown). */
export async function goneProofPage(locale: TemplateLocale): Promise<Response> {
  const w = WORDS[locale];
  const body = `<main><h1>${escape(w.gone)}</h1><p class="from">${escape(w.goneBody)}</p><footer>${escape(w.footer)}</footer></main>`;
  return new Response(page(locale, w.gone, body, w.goneBody), {
    status: 404,
    headers: await headers(),
  });
}
