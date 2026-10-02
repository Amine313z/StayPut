import type { Translator } from '@stayput/i18n';
import { useI18n } from './i18n';

/**
 * A number with its unit, as people write them: « 3 000 € », « $3,000 », « 40 % ». The member
 * space, its testimonial cards and their public pages (apps/worker/src/public-proof.ts) write
 * them the same way.
 */
export function unitFormatter({
  number,
  locale,
}: Pick<Translator, 'number' | 'locale'>): (value: number, unit: string) => string {
  return (value, unit) => {
    const n = number(value);
    if (unit === '%') return locale === 'fr' ? `${n}\u00a0%` : `${n}%`;
    if (locale === 'en' && ['$', '€', '£'].includes(unit)) return `${unit}${n}`;
    return `${n}\u00a0${unit}`;
  };
}

export function useWithUnit(): (value: number, unit: string) => string {
  return unitFormatter(useI18n());
}
