# StayPut motion system

Motion in StayPut explains what changed: a number that moved, a member who needs attention, a
page that opened. It never decorates for its own sake and never slows anyone down. Every screen
uses the same few gestures, from `apps/web/src/motion.ts` (Motion, `motion/react`) and the
`--ease-brand` / `--dur-*` tokens of `apps/web/src/styles.css`. The rules are the brief's
(v4, §14).

## Tokens

| Token      | Value                            | Used for                                           |
| ---------- | -------------------------------- | -------------------------------------------------- |
| Easing     | `cubic-bezier(0.22, 1, 0.36, 1)` | everything (`EASE`, `--ease-brand`)                |
| `micro`    | 120 ms                           | press, focus, an item leaving a list               |
| `hover`    | 200 ms                           | a hover                                            |
| `standard` | 300 ms                           | a section, a row, a toggle                         |
| `page`     | 450 ms                           | a page coming in                                   |
| `count`    | 900 ms                           | a number counting up from 0 the first time         |
| `change`   | 600 ms                           | a number moving from its old value to a new one    |
| `ring`     | 700 ms                           | a risk ring filling to its score                   |
| `draw`     | 1.2 s                            | a chart drawing its lines, a new row's pulse       |
| `fill`     | 400 ms                           | a chart's area fading in once its line is drawn    |
| `morph`    | 500 ms                           | a chart's curve turning into another period's      |
| `pulse`    | 1.2 s                            | today's dot on a chart: a pulse, then a pause      |
| `tooltip`  | 120 ms                           | a tooltip fading in                                |
| `SPRING`   | stiffness 380, damping 32        | drawers and toggles only                           |
| Stagger    | 60 ms                            | sections (and rows) of a page coming in one by one |
| Success    | 1.2 s                            | a button's check mark after it succeeded           |
| Toast      | 4 s                              | a toast before it leaves                           |

No bounce on data: a figure lands where it is, once.

## Gestures

- **Page**: fades in while rising 8 px (`pageVariants`). The side menu and the top bar never
  move.
- **Sections**: come in one after the other, 60 ms apart (`<Stagger>` + `<StaggerItem>`).
- **Numbers**: count up from 0 the first time in 900 ms, then move from the old value to each
  new one in 600 ms (`useCountUp`), cents included, tabular so the width never jumps. Each time
  a figure gets better, once it has landed, a soft turquoise light pulses behind it: the figure
  again, light turquoise and blurred (`.number-glow`, drawn by CSS from `data-glow`, so the
  page's text holds the figure once), whose opacity alone moves. When it gets worse the figure
  dims for 200 ms instead, never red. Which way is better belongs to the figure (revenue at risk
  going down is good). Nothing pulses on load: the count is the arrival.
- **The balance** (the Dashboard's hero, brief v4 §8): its light follows the cursor by at most
  20 px (a computer only, never with less motion asked), moved by style so nothing redraws.
- **Risk rings**: the turquoise stroke draws from 0 to the score in 700 ms, each row's ring a
  little after the one above it.
- **Charts**: the lines draw in from the left in 1.2 s (one clip reveals them), then the area
  fades in (400 ms) and today's dot appears, pulsing every 2.4 s (scale 1 → 1.8, opacity 0.6 →
  0). A new period (7, 30, 90 days) is not drawn again: the curve turns into the new one in
  500 ms (every period is read at the same 90 places of a monotone curve, so the paths match
  point for point), today's dot gliding with it. The hairline, the dots on the lines, the
  tooltip and the day under the pointer follow it (or the arrow keys) with 80 ms of smoothing.
- **Tooltips** (a label's, a chart's): fade in in 120 ms, two lines at most.
- **Choices side by side** (a period, as small pills): the chosen one's pill slides to it
  (300 ms). The side menu's 2 px turquoise bar slides to the open section the same way.
- **Progress** (« Getting started »): the bar grows from the left (`scaleX`).
- **Lists** (« Needs attention »): a member who joins the list slides in with a short turquoise
  pulse (1.2 s, opacity only); one who leaves it folds away (opacity, scale 0.98, 120 ms) and the
  rows below close up. On hover a row lifts 2 px while a surface fades in behind it.
- **Buttons**: press scales to 0.98; while working, a spinner takes the label's place without
  changing the button's size (the label stays for screen readers); on success a check mark
  shows for 1.2 s.
- **Drawers**: slide in from the right on the spring (stiffness 380, damping 32); the page
  behind dims.
- **The guide** (brief v4 §10): its panel is a drawer; its cards come in 60 ms apart. Each
  card's picture loops a few seconds (4 to 4.5 s), then pauses 1 s, transform and opacity only,
  and plays only while it is on screen: out of sight it waits on its first frame (it starts
  again without a jump), and with less motion asked it shows its telling frame, still.
- **The tour and « Show me »**: the page dims to 70 % black around the lit place, which wears a
  2 px turquoise halo; from one place to the next the halo and the card glide in 400 ms; the
  first place fades in where it is. A scroll or a new window size moves them at once. A
  shortcut's light (no dimming, nothing stopped) comes on, holds and fades in 2 s.
- **The welcome**: the window springs in; its steps cross-fade with a 12 px slide; its four
  progress segments grow from the left (`scaleX`); the audit's figures count up from 0.
- **Toasts**: slide in at the bottom right, stack, leave after 4 s.
- **Loading**: every block shows its own shape on black-700 with a black-600 light passing over
  it; never an empty box, never a page-wide spinner. Never longer than 5 seconds: then the
  block says « This is taking longer than usual. » with « Retry », and still shows the answer
  when it comes (`useApi`, brief v4 §9.6).

## Less motion

The app is wrapped in `<MotionConfig reducedMotion="user">`: when the device asks for less
motion, Motion keeps opacity changes and drops movement (no rise, no slide, no scale). Numbers
show their value at once, without their light; charts and rings show already drawn; the
skeleton's light stops (`prefers-reduced-motion` in `styles.css`); the press and the hover lift
are switched off with Tailwind's `motion-reduce:`.

## Performance

- Animate only `transform` and `opacity`. Never width, height, top or left on a list or a chart:
  use `scaleX`/`scaleY` from the baseline instead. Three exceptions, all outside any layout: the
  width of the single clip rectangle that draws a chart in (one SVG attribute), a ring's
  `pathLength`, and the size of the tour's halo while it glides (one fixed element, 400 ms).
- A figure's light is a blurred copy whose opacity moves, never an animated `filter` or
  `text-shadow`: the blur is drawn once.
- Charts are drawn by StayPut itself in SVG (`ui/charts/`), a few kilobytes: no chart library
  (Recharts weighed 109 KB compressed for one area chart, and animates every point in
  JavaScript with its own easing). A period change animates one attribute per line (its path),
  never a point at a time.
- 60 fps on a mid-range laptop inside Whop's frame is the bar.

## Adding a screen

1. Wrap the page in `<Page>` (it applies `pageVariants`).
2. Put its sections in a `<Stagger>` group; use `<MetricHero>` / `<SecondaryMetric>`,
   `<BalanceChart>`, `<MemberListRow>`, `<Skeleton>`.
3. Never write a duration or an easing by hand: take them from `motion.ts`.

## Tests

The tests read what the screens say, not how they move: `apps/web/test/setup.ts` sets
`MotionGlobalConfig.skipAnimations`, so every animation lands on its end at once. The live site
is checked in a real browser by the « look » job of Inspect (`scripts/ops/look.mjs`): fonts
loaded, chart drawn, the guide's pictures, the tour's five places lit, screenshots of the
Dashboard, the guide, the tour and the welcome.
