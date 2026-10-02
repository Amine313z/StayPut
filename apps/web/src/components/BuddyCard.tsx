import type { BuddyPartner, GoalCategory, MemberBuddies } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { CircleAlert, HandHeart, Handshake, UserRoundX } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmButton } from './ConfirmButton';

/**
 * The member's buddies (SPEC Phase 5, point 8): the veteran who helps a newcomer start, or the
 * newcomers a veteran welcomes, with only their name and since when they are members. Either one
 * can ask not to be paired.
 */
export function BuddyCard({
  buddies,
  categories,
  onOptOut,
}: {
  buddies: MemberBuddies;
  categories: Readonly<Record<GoalCategory, MessageKey>>;
  onOptOut: (optOut: boolean) => Promise<MemberBuddies>;
}) {
  const { t } = useI18n();
  // What the last answer gave, until the space comes back with it.
  const [answer, setAnswer] = useState<{ base: MemberBuddies; buddies: MemberBuddies } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = answer && answer.base === buddies ? answer.buddies : buddies;
  const answered = (next: MemberBuddies) => setAnswer({ base: buddies, buddies: next });
  if (shown.partners.length === 0 && !shown.optedOut) return null;
  const welcoming = shown.partners.some((p) => p.role === 'newcomer');

  return (
    <Card
      icon={
        welcoming ? (
          <HandHeart aria-hidden="true" className="size-4" />
        ) : (
          <Handshake aria-hidden="true" className="size-4" />
        )
      }
      title={t(welcoming ? 'buddy.mentorTitle' : 'buddy.title')}
      description={
        shown.optedOut ? undefined : t(welcoming ? 'buddy.mentorBody' : 'buddy.veteranBody')
      }
    >
      {shown.optedOut ? (
        <div className="space-y-3 text-sm">
          <p>{t('buddy.optedOut')}</p>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              setFailed(false);
              onOptOut(false).then(
                (next) => {
                  answered(next);
                  setBusy(false);
                },
                () => {
                  setFailed(true);
                  setBusy(false);
                },
              );
            }}
          >
            {t('buddy.optIn')}
          </Button>
          {failed ? (
            <p role="alert" className="flex items-center gap-1.5 text-danger">
              <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
              {t('common.failed')}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <ul className="space-y-2">
            {shown.partners.map((partner) => (
              <Partner key={partner.pairId} partner={partner} categories={categories} />
            ))}
          </ul>
          <p className="text-sm text-muted">{t('buddy.privacy')}</p>
          <ConfirmButton
            label={t('buddy.optOut')}
            confirmLabel={t('buddy.optOutConfirm')}
            icon={<UserRoundX aria-hidden="true" className="size-4" />}
            run={async () => answered(await onOptOut(true))}
          />
        </div>
      )}
    </Card>
  );
}

function Partner({
  partner,
  categories,
}: {
  partner: BuddyPartner;
  categories: Readonly<Record<GoalCategory, MessageKey>>;
}) {
  const { t, date } = useI18n();
  const name = partner.name ?? t('buddy.someone');
  return (
    <li className="flex items-start gap-3 rounded-xl border border-line p-3">
      <Avatar name={partner.name} />
      <div className="min-w-0 text-sm">
        <p className="font-medium">{name}</p>
        {partner.joinedAt ? (
          <p className="text-muted">
            {t('buddy.since', { date: date(new Date(partner.joinedAt)) })}
          </p>
        ) : null}
        {partner.sameCategory ? (
          <p className="mt-1.5">
            <Badge tone="accent">
              {t('buddy.sameCategory', { category: t(categories[partner.sameCategory]) })}
            </Badge>
          </p>
        ) : null}
      </div>
    </li>
  );
}
