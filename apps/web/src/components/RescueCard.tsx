import type { MemberRescues, RescueChallenge } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { CircleAlert, CircleCheck, LifeBuoy } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';

const PLATFORMS: Readonly<Record<RescueChallenge['platform'], MessageKey>> = {
  discord: 'rescue.platform.discord',
  telegram: 'rescue.platform.telegram',
  whop: 'rescue.platform.whop',
};

/**
 * The rescue challenges (SPEC Phase 5, point 9): members of the community who stalled, never
 * named, with the way to their last message. The member takes one up; if that member comes
 * back, they earn the Rescuer badge.
 */
export function RescueCard({
  rescues,
  whopAppId,
  onJoin,
}: {
  rescues: MemberRescues;
  whopAppId: string | null;
  /** Takes a challenge up; the space shows what it answers. */
  onJoin: (challengeId: string) => Promise<void>;
}) {
  const { t, plural, relative } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (rescues.challenges.length === 0 && rescues.rescued === 0) return null;

  const join = (id: string) => {
    setBusy(id);
    setFailed(null);
    onJoin(id).then(
      () => setBusy(null),
      () => {
        setFailed(id);
        setBusy(null);
      },
    );
  };

  return (
    <Card
      icon={<LifeBuoy aria-hidden="true" className="size-4" />}
      title={t('rescue.title')}
      description={t('rescue.body')}
    >
      <div className="space-y-4">
        {rescues.rescued > 0 ? (
          <p className="flex items-center gap-1.5 text-sm font-medium text-accent">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
            {plural('rescue.rescued', rescues.rescued)}
          </p>
        ) : null}
        {rescues.challenges.length === 0 ? (
          <p className="text-sm text-muted">{t('rescue.none')}</p>
        ) : (
          <ul className="space-y-2">
            {rescues.challenges.map((challenge) => (
              <li key={challenge.id} className="space-y-2 rounded-xl border border-line p-3">
                <p className="text-sm font-medium">{t('rescue.challenge')}</p>
                <p className="text-sm text-muted">
                  {[
                    t(PLATFORMS[challenge.platform]),
                    challenge.place,
                    relative(new Date(challenge.lastMessageAt)),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {challenge.url ? (
                    <ExternalButton
                      href={challenge.url}
                      whopAppId={whopAppId}
                      variant="secondary"
                      size="sm"
                    >
                      {t('rescue.open')}
                    </ExternalButton>
                  ) : null}
                  {challenge.joined ? null : (
                    <Button
                      size="sm"
                      loading={busy === challenge.id}
                      disabled={busy !== null}
                      icon={<LifeBuoy aria-hidden="true" className="size-4" />}
                      onClick={() => join(challenge.id)}
                    >
                      {t('rescue.join')}
                    </Button>
                  )}
                  {challenge.helpers > 0 ? (
                    <span className="text-xs text-muted">
                      {plural('rescue.helpers', challenge.helpers)}
                    </span>
                  ) : null}
                </div>
                {challenge.joined ? (
                  <p className="text-sm text-accent">{t('rescue.joined')}</p>
                ) : null}
                {failed === challenge.id ? (
                  <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
                    <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
                    {t('common.failed')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{t('rescue.anonymous')}</p>
      </div>
    </Card>
  );
}
