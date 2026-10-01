import { Activity, CreditCard, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { StayPutMark } from '../ui/BrandIcons';

/** Outside Whop: what StayPut is and where to open it. */
export function Home() {
  const { t } = useI18n();
  const point = (icon: ReactNode, text: string) => (
    <li className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
        {icon}
      </span>
      <span className="pt-1.5 text-sm">{text}</span>
    </li>
  );
  return (
    <div className="mx-auto max-w-3xl space-y-8 py-6 sm:py-12">
      <div className="space-y-4 text-center">
        <StayPutMark className="mx-auto size-12" />
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('home.title')}</h1>
        <p className="text-lg text-muted">{t('app.tagline')}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-3">
        {point(<Users aria-hidden="true" className="size-4" />, t('home.point.members'))}
        {point(<CreditCard aria-hidden="true" className="size-4" />, t('home.point.payments'))}
        {point(<Activity aria-hidden="true" className="size-4" />, t('home.point.activity'))}
      </ul>
      <p className="text-center text-muted">{t('home.body')}</p>
    </div>
  );
}
