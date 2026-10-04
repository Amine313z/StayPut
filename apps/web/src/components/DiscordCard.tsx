import type { DiscordChannelChoice, DiscordServerStatus, DiscordStatus } from '@stayput/core';
import {
  CircleCheck,
  Hash,
  ListChecks,
  LoaderCircle,
  Lock,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { useState } from 'react';
import { deleteJson, putJson, useApi } from '../api';
import { useDemo } from '../demoMode';
import { useI18n } from '../i18n';
import { Badge, Notice } from '../ui/Badge';
import { DiscordIcon } from '../ui/BrandIcons';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';
import { ConfirmButton } from './ConfirmButton';
import { LinkedMembers, Steps } from './SourceParts';
import { ErrorPanel } from './Status';

/**
 * Discord (SPEC Phase 2, 5): add StayPut's bot to a server, choose the channels it reads, see
 * where the reading stands, disconnect.
 */
export function DiscordCard({
  status,
  whopAppId,
  api,
  onChange,
}: {
  status: DiscordStatus;
  whopAppId: string | null;
  api: string;
  onChange: () => void;
}) {
  const { t } = useI18n();
  // The demo connects nothing: the button shows there, said disabled (ExternalButton).
  const demo = useDemo();
  const variant = status.servers.length > 0 ? 'secondary' : 'primary';
  const label = t(status.servers.length > 0 ? 'discord.addAnother' : 'discord.add');
  const install =
    demo || status.install ? (
      <ExternalButton
        href={status.install?.url ?? null}
        whopAppId={whopAppId}
        variant={variant}
        size="sm"
        icon={<DiscordIcon className="size-4" />}
        tour="connect-discord"
      >
        {label}
      </ExternalButton>
    ) : null;
  return (
    <Card
      icon={<DiscordIcon className="size-5 text-discord" />}
      title={t('sources.discord.name')}
      description={t('discord.description')}
      actions={install}
    >
      {!status.available ? (
        <Notice tone="info">{t('discord.unavailable')}</Notice>
      ) : status.servers.length === 0 ? (
        <Steps
          steps={[t('discord.step.add'), t('discord.step.channels'), t('discord.step.members')]}
        />
      ) : (
        <ul className="space-y-3">
          {status.servers.map((server) => (
            <Server key={server.guildId} server={server} api={api} onChange={onChange} />
          ))}
        </ul>
      )}
      {status.available && status.servers.length > 0 ? (
        <LinkedMembers
          linked={status.linkedMembers}
          unlinked={status.unlinkedAuthors}
          how={t('discord.linkHow')}
        />
      ) : null}
    </Card>
  );
}

function Server({
  server,
  api,
  onChange,
}: {
  server: DiscordServerStatus;
  api: string;
  onChange: () => void;
}) {
  const { t, plural, date, relative } = useI18n();
  const [choosing, setChoosing] = useState(false);
  const refused = server.channels.filter((c) => /^403\b/.test(c.error ?? '')).length;
  const reading = server.channels.some((c) => !c.backfillDone && !c.error);
  const lastRead = server.channels
    .map((c) => c.lastReadAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{server.name ?? t('discord.unnamed')}</p>
          <p className="mt-0.5 text-sm text-muted">
            {plural('discord.channelsFollowed', server.channels.length)}
            {' · '}
            {t('sources.since', { date: date(new Date(server.connectedAt)) })}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {server.channels.length === 0 ? (
              <Badge>{t('discord.noChannel')}</Badge>
            ) : reading ? (
              <Badge
                tone="info"
                icon={<LoaderCircle aria-hidden="true" className="size-3 animate-spin" />}
              >
                {t('discord.reading')}
              </Badge>
            ) : (
              <Badge tone="accent" icon={<CircleCheck aria-hidden="true" className="size-3" />}>
                {lastRead
                  ? t('discord.readAgo', { when: relative(new Date(lastRead)) })
                  : t('discord.waiting')}
              </Badge>
            )}
            {refused > 0 ? (
              <Badge tone="warning" icon={<TriangleAlert aria-hidden="true" className="size-3" />}>
                {plural('discord.refused', refused)}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<ListChecks aria-hidden="true" className="size-4" />}
            aria-expanded={choosing}
            onClick={() => setChoosing((open) => !open)}
          >
            {t('discord.chooseChannels')}
          </Button>
          <ConfirmButton
            label={t('sources.disconnect')}
            confirmLabel={t('sources.disconnectConfirm')}
            icon={<Unplug aria-hidden="true" className="size-4" />}
            run={async () => {
              await deleteJson(`${api}/discord/${server.guildId}`);
              onChange();
            }}
          />
        </div>
      </div>
      {choosing ? (
        <ChannelChooser
          api={api}
          guildId={server.guildId}
          onSaved={() => {
            setChoosing(false);
            onChange();
          }}
        />
      ) : null}
    </li>
  );
}

/** The text channels of the server: tick the ones whose messages count. */
function ChannelChooser({
  api,
  guildId,
  onSaved,
}: {
  api: string;
  guildId: string;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const path = `${api}/discord/${guildId}/channels`;
  const { state, retry } = useApi<DiscordChannelChoice[]>(path);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  if (state.status === 'loading') {
    return (
      <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        {t('common.loading')}
      </p>
    );
  }
  if (state.status === 'error' && state.error.code === 'slow') {
    return (
      <div className="mt-4">
        <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="mt-4">
        <Notice tone="warning">
          <p>{t('discord.channelsUnavailable')}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={retry}>
            {t('common.retry')}
          </Button>
        </Notice>
      </div>
    );
  }
  const channels = state.data;
  const selected = picked ?? new Set(channels.filter((c) => c.followed).map((c) => c.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const groups = new Map<string, DiscordChannelChoice[]>();
  for (const channel of channels) {
    const key = channel.category ?? '';
    groups.set(key, [...(groups.get(key) ?? []), channel]);
  }
  return (
    <div className="mt-4 rounded-xl bg-surface-2 p-4">
      {channels.length === 0 ? (
        <p className="text-sm text-muted">{t('discord.noTextChannel')}</p>
      ) : (
        <div className="space-y-4">
          {[...groups].map(([category, list]) => (
            <fieldset key={category}>
              <legend className="text-xs font-semibold tracking-wide text-muted uppercase">
                {category || t('discord.noCategory')}
              </legend>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {list.map((channel) => (
                  <li key={channel.id}>
                    <label
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                        channel.readable ? 'cursor-pointer hover:bg-surface' : 'text-muted'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-accent"
                        checked={selected.has(channel.id)}
                        disabled={!channel.readable}
                        onChange={() => toggle(channel.id)}
                      />
                      <Hash aria-hidden="true" className="size-3.5 text-muted" />
                      <span className="truncate">{channel.name}</span>
                      {channel.readable ? null : (
                        <span className="ms-auto inline-flex items-center gap-1 text-xs">
                          <Lock aria-hidden="true" className="size-3" />
                          {t('discord.hidden')}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ))}
        </div>
      )}
      {channels.some((c) => !c.readable) ? (
        <p className="mt-3 text-xs text-muted">{t('discord.hiddenHint')}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          loading={saving}
          onClick={() => {
            setSaving(true);
            setFailed(false);
            putJson(path, { channelIds: [...selected] }).then(
              () => {
                setSaving(false);
                onSaved();
              },
              () => {
                setSaving(false);
                setFailed(true);
              },
            );
          }}
        >
          {t('common.save')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPicked(new Set(channels.filter((c) => c.readable).map((c) => c.id)))}
        >
          {t('discord.selectAll')}
        </Button>
        {failed ? (
          <span role="alert" className="text-sm text-danger">
            {t('common.failed')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
