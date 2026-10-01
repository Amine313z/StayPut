import type { TelegramGroupStatus, TelegramStatus } from '@stayput/core';
import { CircleCheck, TriangleAlert, Unplug } from 'lucide-react';
import { deleteJson } from '../api';
import { useI18n } from '../i18n';
import { Badge, Notice } from '../ui/Badge';
import { TelegramIcon } from '../ui/BrandIcons';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';
import { ConfirmButton } from './ConfirmButton';
import { LinkedMembers, Steps } from './SourceParts';

/**
 * Telegram (decision of 2026-10-01): add StayPut's bot to a group with a link made for this
 * community, see the groups it counts, disconnect.
 */
export function TelegramCard({
  status,
  whopAppId,
  api,
  onChange,
}: {
  status: TelegramStatus;
  whopAppId: string | null;
  api: string;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const add = status.addToGroup ? (
    <ExternalButton
      href={status.addToGroup.url}
      whopAppId={whopAppId}
      variant={status.groups.length > 0 ? 'secondary' : 'primary'}
      size="sm"
      icon={<TelegramIcon className="size-4" />}
    >
      {t(status.groups.length > 0 ? 'telegram.addAnother' : 'telegram.add')}
    </ExternalButton>
  ) : null;
  return (
    <Card
      icon={<TelegramIcon className="size-5 text-telegram" />}
      title={t('sources.telegram.name')}
      description={t('telegram.description')}
      actions={add}
    >
      <div className="space-y-4">
        {!status.available ? <Notice tone="info">{t('telegram.unavailable')}</Notice> : null}
        {status.available && status.addToGroup && !status.readsAllMessages ? (
          <Notice tone="warning" icon={<TriangleAlert aria-hidden="true" className="size-4" />}>
            {t('telegram.privacyMode')}
          </Notice>
        ) : null}
        {status.available && status.groups.length === 0 ? (
          <Steps
            steps={[t('telegram.step.add'), t('telegram.step.confirm'), t('telegram.step.members')]}
          />
        ) : null}
        {status.groups.length > 0 ? (
          <ul className="space-y-3">
            {status.groups.map((group) => (
              <Group key={group.chatId} group={group} api={api} onChange={onChange} />
            ))}
          </ul>
        ) : null}
      </div>
      {status.available && status.groups.length > 0 ? (
        <LinkedMembers
          linked={status.linkedMembers}
          unlinked={status.unlinkedAuthors}
          how={t('telegram.linkHow')}
        />
      ) : null}
    </Card>
  );
}

function Group({
  group,
  api,
  onChange,
}: {
  group: TelegramGroupStatus;
  api: string;
  onChange: () => void;
}) {
  const { t, date, relative } = useI18n();
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line p-4">
      <div className="min-w-0">
        <p className="truncate font-medium">{group.title ?? t('telegram.unnamed')}</p>
        <p className="mt-0.5 text-sm text-muted">
          {t('sources.since', { date: date(new Date(group.connectedAt)) })}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {group.active ? (
            <Badge tone="accent" icon={<CircleCheck aria-hidden="true" className="size-3" />}>
              {group.lastMessageAt
                ? t('telegram.lastMessage', { when: relative(new Date(group.lastMessageAt)) })
                : t('telegram.listening')}
            </Badge>
          ) : (
            <Badge tone="warning" icon={<TriangleAlert aria-hidden="true" className="size-3" />}>
              {t('telegram.removed')}
            </Badge>
          )}
        </div>
      </div>
      <ConfirmButton
        label={t('sources.disconnect')}
        confirmLabel={t('sources.disconnectConfirm')}
        icon={<Unplug aria-hidden="true" className="size-4" />}
        run={async () => {
          await deleteJson(`${api}/telegram/${group.chatId}`);
          onChange();
        }}
      />
    </li>
  );
}
