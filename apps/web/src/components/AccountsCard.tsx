import type { AccountsView, LinkedAccount, MemberRow, UnlinkedAccount } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { EyeOff, Link2, Unlink, UsersRound } from 'lucide-react';
import { useId, useState } from 'react';
import { postJson, useApi } from '../api';
import { useI18n } from '../i18n';
import { Badge } from '../ui/Badge';
import { DiscordIcon, TelegramIcon } from '../ui/BrandIcons';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmButton } from './ConfirmButton';
import { FIELD } from './SettingsParts';
import { ErrorPanel, Loading } from './Status';

const VIA: Readonly<Record<NonNullable<LinkedAccount['via']>, MessageKey>> = {
  whop: 'accounts.via.whop',
  member: 'accounts.via.member',
  name: 'accounts.via.name',
  creator: 'accounts.via.creator',
};

type Change = 'link' | 'unlink' | 'dismiss' | 'restore';

/**
 * The Discord and Telegram accounts seen writing, and the members they are (decision of
 * 2026-10-01): StayPut ties an account by name when one member surely matches; the creator ties
 * the others in one click, from the suggestions or the whole list, sets aside who is no member,
 * and unties a mistake. Their messages wait 30 days for that.
 */
export function AccountsCard({
  api,
  members,
  onChange,
}: {
  api: string;
  /** The community's members, to choose from. */
  members: readonly MemberRow[];
  /** After a change: the counts of the sources, and the members' activity, move. */
  onChange: () => void;
}) {
  const { t } = useI18n();
  const { state, retry } = useApi<AccountsView>(`${api}/accounts`);
  const [changed, setChanged] = useState<AccountsView | null>(null);
  const view = changed ?? (state.status === 'ready' ? state.data : null);

  const change = async (what: Change, body: Record<string, string>) => {
    setChanged(await postJson<AccountsView>(`${api}/accounts/${what}`, body));
    onChange();
  };

  return (
    <Card
      icon={<UsersRound aria-hidden="true" className="size-4" />}
      title={t('accounts.title')}
      description={t('accounts.description')}
    >
      {view ? (
        <Accounts view={view} members={members} change={change} />
      ) : state.status === 'error' ? (
        <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
      ) : (
        <Loading />
      )}
    </Card>
  );
}

function Accounts({
  view,
  members,
  change,
}: {
  view: AccountsView;
  members: readonly MemberRow[];
  change: (what: Change, body: Record<string, string>) => Promise<void>;
}) {
  const { t } = useI18n();
  if (view.unlinked.length === 0 && view.linked.length === 0) {
    return <p className="text-sm text-muted">{t('accounts.empty')}</p>;
  }
  const choices = members
    .filter((m) => m.status === 'joined')
    .map((m) => ({ id: m.id, name: m.name ?? t('members.unnamed') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-6">
      <section aria-labelledby="accounts-to-link">
        <h3 id="accounts-to-link" className="text-sm font-semibold">
          {t('accounts.toLink', { count: view.unlinked.length })}
        </h3>
        {view.unlinked.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t('accounts.allLinked')}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {view.unlinked.map((account) => (
              <Unlinked
                key={`${account.platform}:${account.accountId}`}
                account={account}
                choices={choices}
                change={change}
              />
            ))}
          </ul>
        )}
      </section>
      {view.linked.length > 0 ? (
        <section aria-labelledby="accounts-linked">
          <h3 id="accounts-linked" className="text-sm font-semibold">
            {t('accounts.linked', { count: view.linked.length })}
          </h3>
          <ul className="mt-3 divide-y divide-line">
            {view.linked.map((account) => (
              <Linked
                key={`${account.platform}:${account.accountId}`}
                account={account}
                change={change}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Who an account is, as the creator sees them on Discord or Telegram. */
function Who({ account }: { account: UnlinkedAccount | LinkedAccount }) {
  const { t } = useI18n();
  const Icon = account.platform === 'discord' ? DiscordIcon : TelegramIcon;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon
        role="img"
        aria-label={t(
          account.platform === 'discord' ? 'sources.discord.name' : 'sources.telegram.name',
        )}
        className={`size-4 shrink-0 ${account.platform === 'discord' ? 'text-discord' : 'text-telegram'}`}
      />
      <span className="truncate font-medium">{account.name ?? t('accounts.unnamed')}</span>
      {account.username ? (
        <span className="truncate text-sm text-muted">@{account.username}</span>
      ) : null}
    </span>
  );
}

function Unlinked({
  account,
  choices,
  change,
}: {
  account: UnlinkedAccount;
  choices: readonly { id: string; name: string }[];
  change: (what: Change, body: Record<string, string>) => Promise<void>;
}) {
  const { t, plural, relative } = useI18n();
  const id = useId();
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const key = { platform: account.platform, accountId: account.accountId };
  const run = async (busyKey: string, what: Change, extra: Record<string, string> = {}) => {
    setBusy(busyKey);
    setFailed(false);
    try {
      await change(what, { ...key, ...extra });
    } catch {
      setFailed(true);
      setBusy(null);
    }
  };
  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Who account={account} />
          <p className="mt-0.5 text-sm text-muted">
            {plural('accounts.messages', account.messages)} ·{' '}
            {t('accounts.lastSeen', { when: relative(new Date(account.lastAt)) })}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<EyeOff aria-hidden="true" className="size-4" />}
          loading={busy === 'dismiss'}
          disabled={busy !== null}
          onClick={() => void run('dismiss', 'dismiss')}
        >
          {t('accounts.dismiss')}
        </Button>
      </div>
      {account.suggestions.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">{t('accounts.suggested')}</span>
          {account.suggestions.map((s) => (
            <Button
              key={s.memberId}
              variant="secondary"
              size="sm"
              icon={<Link2 aria-hidden="true" className="size-4" />}
              loading={busy === s.memberId}
              disabled={busy !== null}
              onClick={() => void run(s.memberId, 'link', { memberId: s.memberId })}
            >
              {t('accounts.linkTo', { name: s.name ?? t('members.unnamed') })}
              {s.strong ? <Badge tone="accent">{t('accounts.sameName')}</Badge> : null}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-member`} className="text-sm text-muted">
          {t('accounts.other')}
        </label>
        <select
          id={`${id}-member`}
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
          className={`${FIELD} w-full sm:w-64`}
        >
          <option value="">{t('accounts.choose')}</option>
          {choices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          icon={<Link2 aria-hidden="true" className="size-4" />}
          disabled={chosen === '' || busy !== null}
          loading={busy === 'chosen'}
          onClick={() => void run('chosen', 'link', { memberId: chosen })}
        >
          {t('accounts.link')}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {t('accounts.failed')}
        </p>
      ) : null}
    </li>
  );
}

function Linked({
  account,
  change,
}: {
  account: LinkedAccount;
  change: (what: Change, body: Record<string, string>) => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Who account={account} />
        <span aria-hidden="true" className="text-muted">
          →
        </span>
        <span className="truncate text-sm">{account.member.name ?? t('members.unnamed')}</span>
        {account.via ? <Badge>{t(VIA[account.via])}</Badge> : null}
      </div>
      <ConfirmButton
        label={t('accounts.unlink')}
        confirmLabel={t('accounts.unlinkConfirm')}
        icon={<Unlink aria-hidden="true" className="size-4" />}
        run={() => change('unlink', { platform: account.platform, accountId: account.accountId })}
      />
    </li>
  );
}
