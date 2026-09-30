import { useI18n } from '../i18n';

/** Outside Whop: what StayPut is and where to open it. */
export function Home() {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('home.title')}</h1>
      <p className="text-muted">{t('app.tagline')}</p>
      <p className="text-muted">{t('home.body')}</p>
    </div>
  );
}
