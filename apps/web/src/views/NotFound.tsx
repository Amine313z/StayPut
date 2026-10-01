import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { buttonClass } from '../ui/Button';

export function NotFound() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-lg space-y-4 py-12 text-center">
      <p className="tabular text-5xl font-semibold tracking-tight text-muted">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">{t('notFound.title')}</h1>
      <p className="text-muted">{t('error.not_found')}</p>
      <Link to="/" className={buttonClass('secondary')}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t('common.backHome')}
      </Link>
    </div>
  );
}
