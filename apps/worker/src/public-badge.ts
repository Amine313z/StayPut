import { badgePercent, type BadgeLocale } from '@stayput/core';
import type { PublicBadge } from './badge';
import { escape, headers, page } from './public-proof';

/**
 * The verification page of the « Verified retention » badge, /verify/:companyId (SPEC Phase
 * 6.11): the figure, what it counts and when, in the community's language. Plain HTML from the
 * Worker, no script, the public proof page's look.
 */

const WORDS: Readonly<
  Record<
    BadgeLocale,
    {
      from: string;
      community: string;
      what: string;
      meta: (members: string, date: string | null) => string;
      note: string;
      footer: string;
      gone: string;
      goneBody: string;
    }
  >
> = {
  en: {
    from: 'Retention verified by StayPut',
    community: 'A Whop community',
    what: 'of the members who joined in the last 12 months stayed 90 days or more.',
    meta: (m, d) => (d ? `${m} members counted · updated on ${d}` : `${m} members counted`),
    note: 'StayPut reads the community’s memberships from Whop: who joined, who left and when. The creator cannot change this figure: StayPut counts it again every week.',
    footer: 'Verified by StayPut',
    gone: 'This badge is not available',
    goneBody: 'This community does not show its retention, or no longer uses StayPut.',
  },
  fr: {
    from: 'Rétention vérifiée par StayPut',
    community: 'Une communauté Whop',
    what: 'des membres arrivés ces 12 derniers mois sont restés 90 jours ou plus.',
    meta: (m, d) => (d ? `${m} membres comptés · mis à jour le ${d}` : `${m} membres comptés`),
    note: 'StayPut lit les abonnements de la communauté chez Whop : qui est arrivé, qui est parti et quand. Le créateur ne peut pas modifier ce chiffre : StayPut le recalcule chaque semaine.',
    footer: 'Vérifié par StayPut',
    gone: 'Ce badge n’est pas disponible',
    goneBody: 'Cette communauté ne montre pas sa rétention, ou n’utilise plus StayPut.',
  },
};

export async function verifyPage(badge: PublicBadge): Promise<Response> {
  const w = WORDS[badge.locale];
  const percent = badgePercent(badge.locale, badge.retention);
  const width = Math.max(0, Math.min(100, Math.round(badge.retention * 100)));
  const date = badge.computedAt
    ? new Intl.DateTimeFormat(badge.locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
        new Date(badge.computedAt),
      )
    : null;
  const members = new Intl.NumberFormat(badge.locale).format(badge.members);
  const name = badge.name ?? w.community;
  const body = [
    '<main>',
    `<p class="from">${escape(w.from)}</p>`,
    `<h1>${escape(name)}</h1>`,
    `<p class="value">${escape(percent)}</p>`,
    `<div class="bar" role="img" aria-label="${escape(percent)}"><span class="w${width}"></span></div>`,
    `<p class="progress">${escape(w.what)}</p>`,
    `<p class="meta">${escape(w.meta(members, date))}</p>`,
    `<p class="note">${escape(w.note)}</p>`,
    `<footer>${escape(w.footer)}</footer>`,
    '</main>',
  ].join('\n');
  return new Response(page(badge.locale, `${name} · ${percent}`, body, `${w.from} · ${percent}`), {
    headers: { ...(await headers()), 'Cache-Control': 'public, max-age=3600' },
  });
}

export async function goneVerifyPage(locale: BadgeLocale): Promise<Response> {
  const w = WORDS[locale];
  const body = `<main><h1>${escape(w.gone)}</h1><p class="from">${escape(w.goneBody)}</p><footer>${escape(w.footer)}</footer></main>`;
  return new Response(page(locale, w.gone, body, w.goneBody), {
    status: 404,
    headers: await headers(),
  });
}
