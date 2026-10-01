import { Link2, UserRoundX } from 'lucide-react';
import { useI18n } from '../i18n';

/** The steps of connecting a source, numbered. */
export function Steps({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, index) => (
        <li key={step} className="flex items-start gap-3 text-sm">
          <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
            {index + 1}
          </span>
          <span className="pt-0.5">{step}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * How many members StayPut recognizes on the platform, how many recent authors it does not
 * (their activity waits 7 days for a member to link the account), and how members link it.
 */
export function LinkedMembers({
  linked,
  unlinked,
  how,
}: {
  linked: number;
  unlinked: number;
  how: string;
}) {
  const { plural } = useI18n();
  return (
    <div className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <Link2 aria-hidden="true" className="size-4 text-accent" />
          {plural('sources.linkedMembers', linked)}
        </span>
        {unlinked > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <UserRoundX aria-hidden="true" className="size-4" />
            {plural('sources.unlinkedAuthors', unlinked)}
          </span>
        ) : null}
      </p>
      <p className="text-muted">{how}</p>
    </div>
  );
}
