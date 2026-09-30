import { Link } from 'react-router';
import { useI18n } from '../i18n';

export function NotFound() {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('notFound.title')}</h1>
      <p className="text-muted">{t('error.not_found')}</p>
      <Link
        to="/"
        className="inline-block font-medium text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {t('common.backHome')}
      </Link>
    </div>
  );
}
