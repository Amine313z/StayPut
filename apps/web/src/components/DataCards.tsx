import type { DataExport, TeamView } from '@stayput/core';
import { Download, Trash2, Users } from 'lucide-react';
import { useId, useState } from 'react';
import { getJson, postJson, useApi } from '../api';
import { useDemo } from '../demoMode';
import { useI18n } from '../i18n';
import { Avatar } from '../ui/Avatar';
import { Button, buttonClass, leadingMark } from '../ui/Button';
import { Card } from '../ui/Card';
import { Dialog } from '../ui/Dialog';
import { IconTip } from '../ui/IconTip';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { failureText } from './MemberActions';

/**
 * Settings › General, the team (SPEC Phase 6.12): everyone on the community's Whop team may open
 * StayPut; who did, and when last. People are added and removed on Whop, never here.
 */
export function TeamCard({ api }: { api: string }) {
  const { t, relative } = useI18n();
  const { state } = useApi<TeamView>(`${api}/team`);
  return (
    <Card
      icon={<Users aria-hidden="true" className="size-4" />}
      title={t('team.title')}
      description={t('team.description')}
    >
      {state.status === 'error' ? (
        <p className="text-sm">{t('common.failed')}</p>
      ) : state.status !== 'ready' ? (
        <Skeleton className="h-12 w-full rounded-xl" />
      ) : (
        <ul className="divide-y divide-line" aria-label={t('team.title')}>
          {state.data.members.map((member) => (
            <li key={member.userId} className="flex items-center gap-3 py-2.5">
              <Avatar name={member.name} size={32} />
              {/* On a phone the last visit goes under the name, so the name keeps its width. */}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">
                    {member.name ?? t('team.unknown')}
                  </p>
                  {member.username ? (
                    <p className="truncate text-[0.8125rem] text-subtle">@{member.username}</p>
                  ) : null}
                </div>
                <p className="text-[0.8125rem] text-muted sm:shrink-0">
                  {member.openedAt
                    ? t('team.opened', { when: relative(new Date(member.openedAt)) })
                    : t('team.never')}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Settings › General, the community's data (SPEC Phase 6.12): everything StayPut keeps, as a JSON
 * file; or deleted, once the community's name is typed again. Deleting is refused in the demo.
 */
export function DataCard({
  api,
  companyId,
  companyName,
}: {
  api: string;
  companyId: string;
  companyName: string | null;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const demo = useDemo();
  const tipId = useId();
  const [exporting, setExporting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const download = async () => {
    setExporting(true);
    try {
      const data = await getJson<DataExport>(`${api}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `stayput-${companyId}-${data.exportedAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      toast({ tone: 'error', title: failureText(error, t) });
    } finally {
      setExporting(false);
    }
  };
  if (deleted) {
    return (
      <Card
        icon={<Trash2 aria-hidden="true" className="size-4" />}
        title={t('data.title')}
        description={t('data.deleted')}
      >
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          {t('data.reload')}
        </Button>
      </Card>
    );
  }
  return (
    <Card
      icon={<Download aria-hidden="true" className="size-4" />}
      title={t('data.title')}
      description={t('data.description')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download aria-hidden="true" className="size-4" />}
          loading={exporting}
          onClick={() => void download()}
        >
          {t('data.export')}
        </Button>
        {demo ? (
          <IconTip label={t('demo.disabled')} id={tipId}>
            <button
              type="button"
              aria-disabled="true"
              aria-describedby={tipId}
              data-demo-disabled=""
              className={buttonClass('danger', 'sm')}
              onClick={(event) => event.currentTarget.focus()}
            >
              {leadingMark('danger', <Trash2 aria-hidden="true" className="size-4" />)}
              {t('data.delete')}
            </button>
          </IconTip>
        ) : (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 aria-hidden="true" className="size-4" />}
            onClick={() => setAsking(true)}
          >
            {t('data.delete')}
          </Button>
        )}
      </div>
      {asking ? (
        <DeleteDialog
          api={api}
          companyId={companyId}
          companyName={companyName}
          onClose={() => setAsking(false)}
          onDeleted={() => {
            setAsking(false);
            setDeleted(true);
          }}
        />
      ) : null}
    </Card>
  );
}

/** « Delete all data? »: what goes, then the community's name typed again to delete. */
function DeleteDialog({
  api,
  companyId,
  companyName,
  onClose,
  onDeleted,
}: {
  api: string;
  companyId: string;
  companyName: string | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const inputId = useId();
  const expected = companyName ?? companyId;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = typed.trim() === expected;
  const remove = async () => {
    setBusy(true);
    try {
      await postJson<{ deleted: boolean }>(`${api}/data/delete`, { confirm: companyId });
      onDeleted();
    } catch (error) {
      toast({ tone: 'error', title: failureText(error, t) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('data.confirm.title')} description={t('data.confirm.body')} onClose={onClose}>
      <form
        className="space-y-4 px-4 py-4 sm:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) void remove();
        }}
      >
        <label htmlFor={inputId} className="block text-sm text-fg">
          {t('data.confirm.type', { name: expected })}
        </label>
        <input
          id={inputId}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent"
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="danger"
            size="sm"
            icon={<Trash2 aria-hidden="true" className="size-4" />}
            disabled={!ready}
            loading={busy}
          >
            {t('data.confirm.delete')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
