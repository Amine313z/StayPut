/**
 * One chart style for every chart of StayPut (brief v3 §6.6, the ChartTheme, as v4 §8 draws the
 * balance): numbers in Satoshi like every number (brief v4 §7), white-500 at 11 px, no grid, no
 * border around a chart, no library color. The main series is a 2 px turquoise line over its
 * turquoise area fading to nothing; a comparison is a 1 px dashed white-500 line. Tailwind
 * classes, so every value is one of the palette's tokens.
 */
export const CHART = {
  axisLabel: 'num text-[11px] leading-none whitespace-nowrap text-subtle',
  legend: 'text-xs text-muted',
  line: 'stroke-turq-300',
  comparison: 'stroke-white-500',
  /** The comparison line's dashes, in px. */
  dash: '4 4',
  crosshair: 'bg-turq-300/40',
  marker: 'bg-turq-300',
  comparisonMarker: 'bg-white-300',
  markerRing: 'ring-2 ring-bg',
  tooltip: 'rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs shadow-lift',
  /** The area's gradient, top to bottom: turquoise-300 at 22 %, fading to nothing. */
  areaStops: [
    { offset: '0%', color: 'var(--turq-300)', opacity: 0.22 },
    { offset: '100%', color: 'var(--turq-300)', opacity: 0 },
  ],
} as const;
