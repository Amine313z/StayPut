/**
 * One chart style for every chart of StayPut (brief v3 §6.6, the ChartTheme): axis labels
 * white-500 at 11 px, grid lines black-600 at 60 %, no border around a chart, no library color.
 * The main series is a turquoise line over its turquoise area fading to nothing; a comparison is
 * a dashed white line. Tailwind classes, so every value is one of the palette's tokens.
 */
export const CHART = {
  axisLabel: 'tabular text-[11px] leading-none whitespace-nowrap text-subtle',
  legend: 'text-xs text-muted',
  grid: 'stroke-black-600/60',
  line: 'stroke-turq-300',
  comparison: 'stroke-white-300',
  /** The comparison line's dashes, in px. */
  dash: '4 4',
  crosshair: 'bg-turq-300/40',
  marker: 'bg-turq-300',
  comparisonMarker: 'bg-white-300',
  markerRing: 'ring-2 ring-bg',
  tooltip: 'rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs shadow-lift',
  /** The area's gradient, top to bottom: turquoise, then its deeper base fading to nothing. */
  areaStops: [
    { offset: '0%', color: 'var(--turq-300)', opacity: 0.28 },
    { offset: '55%', color: 'var(--turq-500)', opacity: 0.1 },
    { offset: '100%', color: 'var(--turq-500)', opacity: 0 },
  ],
} as const;
