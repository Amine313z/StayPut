import type { ReactNode } from 'react';

/** The look of a field of the settings forms. */
export const FIELD =
  'rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg shadow-card ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
  'aria-[invalid=true]:border-danger';

/** One setting: its name on the left (above on a phone), the controls on the right. */
export function Row({
  label,
  htmlFor,
  labelId,
  children,
}: {
  label: string;
  htmlFor?: string;
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 py-5 first:pt-0 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-8">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-semibold">
          {label}
        </label>
      ) : (
        <p id={labelId} className="text-sm font-semibold">
          {label}
        </p>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function NumberField({
  id,
  label,
  value,
  invalid,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  invalid: boolean;
  min: number;
  max: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        className={`${FIELD} tabular w-24`}
      />
    </div>
  );
}
