import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccessCache } from '../src/access';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { LEGAL_DOCUMENTS, legalLocale } from '../src/legal';

/**
 * The legal pages (SPEC Phase 8.1): the privacy policy, the terms of service and the data
 * processing agreement, public, in English and French, plain HTML with no script.
 */

const app = createApp({
  now: () => new Date(),
  openDb: () => null,
  whopClient: () => null,
  userTokenKeys: () => {
    throw new Error('not read here');
  },
  oauth: () => null,
  discord: () => null,
  telegram: () => null,
  accessCache: new AccessCache(),
});

const ENV: Env = { WHOP_ENV: 'sandbox', WHOP_APP_ID: 'app_stayput' };

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`http://localhost${path}`, { headers }, ENV);

describe('the legal pages', () => {
  it('each answers in English by default, with its own style and nothing else', async () => {
    for (const document of LEGAL_DOCUMENTS) {
      const res = await get(`/${document}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(res.headers.get('vary')).toBe('Accept-Language');
      const html = await res.text();
      expect(html).toContain('<html lang="en">');
      expect(html).not.toContain('<script');
      // The policy allows the page's one style, by its hash.
      const style = /<style>(.*)<\/style>/s.exec(html)?.[1] ?? '';
      const hash = createHash('sha256').update(style).digest('base64');
      expect(res.headers.get('content-security-policy')).toBe(
        `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`,
      );
    }
  });

  it('says it is a draft, and shows what the founder has to complete', async () => {
    const html = await (await get('/terms')).text();
    expect(html).toContain('Draft, being reviewed');
    expect(html).toContain('[operator’s legal name: to be completed]');
    expect(html).toContain('[governing law and courts: to be completed]');
  });

  it('opens in the language asked, else the browser’s', async () => {
    const asked = await (await get('/privacy?lang=fr')).text();
    expect(asked).toContain('<html lang="fr">');
    expect(asked).toContain('<h1>Politique de confidentialité</h1>');
    expect(asked).toContain('Dernière mise à jour\u00a0: 5 octobre 2026');
    const browser = await (await get('/dpa', { 'accept-language': 'fr-FR,fr;q=0.9' })).text();
    expect(browser).toContain('<h1>Accord de traitement des données</h1>');
    const overridden = await (await get('/dpa?lang=en', { 'accept-language': 'fr' })).text();
    expect(overridden).toContain('<h1>Data processing agreement</h1>');
    expect(legalLocale('de', 'en-US,fr;q=0.8')).toBe('en');
  });

  it('leads to the two other documents and to the other language', async () => {
    const html = await (await get('/terms?lang=fr')).text();
    const links = [...html.matchAll(/<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g)].map((m) => [
      m[1],
      m[3],
      m[2]?.includes('aria-current') ?? false,
    ]);
    expect(links).toEqual([
      ['/privacy?lang=fr', 'Politique de confidentialité', false],
      ['/terms?lang=fr', 'Conditions d’utilisation', true],
      ['/dpa?lang=fr', 'Accord de traitement des données', false],
      ['/terms?lang=en', 'English', false],
    ]);
  });

  it('states the periods the database keeps to', async () => {
    for (const lang of ['en', 'fr'] as const) {
      const html = await (await get(`/privacy?lang=${lang}`)).text();
      // 0041: activity in detail for 12 months; 0040: deliveries 7 days once done, 30 at most,
      // and a community's data 30 days after it lost access.
      expect(html).toContain(lang === 'en' ? '12 months' : '12 mois');
      expect(html).toContain(lang === 'en' ? '7 days once processed' : '7 jours une fois traités');
      expect(html).toContain(lang === 'en' ? '30 days later' : '30 jours plus tard');
    }
  });
});
