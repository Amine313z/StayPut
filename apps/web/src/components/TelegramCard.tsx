import type { TelegramGroupStatus, TelegramStatus } from '@stayput/core';
import { CircleCheck, Megaphone, TriangleAlert, Unplug } from 'lucide-react';
import { deleteJson } from '../api';
import { useDemo } from '../demoMode';
import { memberSpaceEnabled } from '../features';
import { useI18n } from '../i18n';
import { Badge, Notice } from '../ui/Badge';
import { TelegramIcon } from '../ui/BrandIcons';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';
import { ConfirmButton } from './ConfirmButton';
import { LinkedMembers, Steps } from './SourceParts';

/**
 * Telegram (decision of 2026-10-01): add StayPut's bot to a group with a link made for this
 * community, see the groups it counts, disconnect. A channel counts through its discussion group:
 * its members' comments (nobody else writes in a channel, and its reactions are anonymous).
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
  // The demo connects nothing: the button shows there, said disabled (ExternalButton).
  const demo = useDemo();
  const add =
    demo || status.addToGroup ? (
      <ExternalButton
        href={status.addToGroup?.url ?? null}
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
            steps={[
              t('telegram.step.add'),
              t('telegram.step.confirm'),
              // How members link their account: from their StayPut space, while there is one.
              ...(memberSpaceEnabled() ? [t('telegram.step.members')] : []),
            ]}
          />
        ) : null}
        {status.groups.length > 0 ? (
          <ul className="space-y-3">
            {status.groups.map((group) => (
              <Group key={group.chatId} group={group} api={api} onChange={onChange} />
            ))}
          </ul>
        ) : null}
        {status.available ? (
          <p className="flex items-start gap-2 text-sm text-muted">
            <Megaphone aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{t('telegram.channel')}</span>
          </p>
        ) : null}
      </div>
      {status.available && status.groups.length > 0 ? (
        <LinkedMembers
          linked={status.linkedMembers}
          unlinked={status.unlinkedAuthors}
          how={t(memberSpaceEnabled() ? 'telegram.linkHow.space' : 'telegram.linkHow')}
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
