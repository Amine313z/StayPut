import type { AdminCompaniesView, AdminCompanyRow } from '@stayput/core';
import { Flag, UserPlus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { ApiError, deleteJson, postJson, useApi } from '../../api';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useCreatorData } from '../CreatorView';

/**
 * Settings › Admin (decision of 2026-10-10), for the founder alone (ADMIN_USER_ID, the Worker
 * answers no one else): every community with its level, its Whop plan, the end of its trial and
 * its place in the founders' registry; the communities that bought the founders' plan without an
 * invitation first (a link that leaked); the places left; plan B's state; and the invitations.
 */
export function AdminTab() {
  const { root, admin } = useCreatorData();
  if (!admin) return <Navigate to={`${root}/settings`} replace />;
  return <AdminPage />;
}

function AdminPage() {
  const { t, plural, date } = useI18n();
  const { state, retry } = useApi<AdminCompaniesView>('/api/admin/companies');
  const [view, setView] = useState<AdminCompaniesView | null>(null);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  const shown = view ?? state.data;
  const flagged = shown.companies.filter((c) => c.founder?.status === 'flagged').length;
  return (
    <div className="space-y-6">
      <Card title={t('admin.title')}>
        <div className="space-y-1 p-5 text-sm">
          <p>
            {plural('admin.places', shown.founders.left, {
              places: String(shown.founders.places),
            })}
          </p>
          <p className="text-muted">
            {shown.fallback.on && shown.fallback.betaEnd
              ? t('admin.fallback.on', { date: date(new Date(shown.fallback.betaEnd)) })
              : t('admin.fallback.off')}
          </p>
          {flagged > 0 ? (
            <p className="flex items-center gap-2 font-medium" data-admin-flagged={flagged}>
              <Flag aria-hidden="true" className="size-4 text-accent" />
              {plural('admin.flagged', flagged)}
            </p>
          ) : null}
        </div>
      </Card>
      <Invite onDone={setView} />
      <Card>
        <div className="overflow-x-auto p-2">
          {shown.companies.length === 0 ? (
            <p className="p-3 text-sm text-muted">{t('admin.none')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-start text-xs text-muted">
                <tr>
                  {(
                    [
                      'admin.col.community',
                      'admin.col.tier',
                      'admin.col.plan',
                      'admin.col.trial',
                      'admin.col.founder',
                      'admin.col.checked',
                    ] as const
                  ).map((key) => (
                    <th key={key} className="px-3 py-2 text-start font-medium">
                      {t(key)}
                    </th>
                  ))}
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.companies.map((row) => (
                  <Row key={row.companyId} row={row} onChange={setView} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

function Row({
  row,
  onChange,
}: {
  row: AdminCompanyRow;
  onChange: (view: AdminCompaniesView) => void;
}) {
  const { t, date, relative } = useI18n();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      onChange(
        await deleteJson<AdminCompaniesView>(
          `/api/admin/founders/${encodeURIComponent(row.companyId)}`,
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  // A community already here (StayPut installed before the private beta): invited in one click.
  const invite = async () => {
    setBusy(true);
    try {
      onChange(
        await postJson<AdminCompaniesView>('/api/admin/founders', { companyId: row.companyId }),
      );
    } catch {
      // No place left: the count above says so.
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr
      data-admin-row={row.companyId}
      className={`border-t border-line ${row.founder?.status === 'flagged' ? 'bg-surface-2' : ''}`}
    >
      <td className="px-3 py-2">
        <span className="block font-medium">{row.name ?? row.companyId}</span>
        {row.name ? <span className="text-xs text-muted">{row.companyId}</span> : null}
      </td>
      <td className="px-3 py-2">
        {t(`plan.tier.${row.tier}`)}
        {row.source === 'founder_fallback' ? (
          <span className="text-xs text-muted"> · {t('admin.source.founder_fallback')}</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-xs text-muted">{row.planId ?? '—'}</td>
      <td className="px-3 py-2">{row.trialEndsAt ? date(new Date(row.trialEndsAt)) : '—'}</td>
      <td className="px-3 py-2">
        {row.founder ? (
          <Badge tone={row.founder.status === 'flagged' ? 'danger' : 'accent'}>
            {t(`admin.founder.${row.founder.status}`)}
          </Badge>
        ) : (
          '—'
        )}
        {row.founder?.note ? (
          <span className="mt-1 block text-xs text-muted">{row.founder.note}</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-xs text-muted">
        {row.checkedAt ? relative(new Date(row.checkedAt)) : '—'}
        {row.stale ? <span className="block">{t('admin.stale')}</span> : null}
      </td>
      <td className="px-3 py-2 text-end">
        {row.founder ? (
          <Button variant="ghost" size="sm" loading={busy} onClick={() => void remove()}>
            {t('admin.remove')}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void invite()}>
            {t('admin.invite.add')}
          </Button>
        )}
      </td>
    </tr>
  );
}

function Invite({ onDone }: { onDone: (view: AdminCompaniesView) => void }) {
  const { t } = useI18n();
  const idField = useId();
  const noteField = useId();
  const [companyId, setCompanyId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Its id, or the link to its dashboard as the creator copies it (whop.com/dashboard/biz_…).
    const id = /biz_[A-Za-z0-9]+/.exec(companyId)?.[0];
    if (!id) {
      setMessage(t('error.invalid_request'));
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      onDone(
        await postJson<AdminCompaniesView>('/api/admin/founders', {
          companyId: id,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      );
      setCompanyId('');
      setNote('');
      setMessage(t('admin.invite.done'));
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.code === 'conflict'
          ? t(/place/.test(error.message) ? 'admin.invite.full' : 'admin.invite.exists')
          : t('error.invalid_request'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('admin.invite')} icon={<UserPlus aria-hidden="true" className="size-4" />}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-3 p-5">
        <label htmlFor={idField} className="flex flex-col gap-1 text-xs text-muted">
          {t('admin.invite.id')}
          <input
            id={idField}
            required
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            className="h-10 w-96 max-w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
          />
        </label>
        <label htmlFor={noteField} className="flex flex-col gap-1 text-xs text-muted">
          {t('admin.invite.note')}
          <input
            id={noteField}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="h-10 rounded-lg border border-line bg-surface px-3 text-sm text-fg"
          />
        </label>
        <Button type="submit" variant="secondary" loading={busy}>
          {t('admin.invite.add')}
        </Button>
        {message ? (
          <p role="status" className="basis-full text-sm text-muted">
            {message}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
