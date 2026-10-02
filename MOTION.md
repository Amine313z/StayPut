# StayPut motion system

Motion in StayPut explains what changed: a number that moved, a member who needs attention, a
page that opened. It never decorates for its own sake, and it never slows anyone down. Every
screen uses the same few gestures, from `apps/web/src/motion.ts` (Motion, `motion/react`) and the
`--ease-brand` / `--dur-*` tokens of `apps/web/src/styles.css`.

## Tokens

| Token      | Value                            | Used for                                 |
| ---------- | -------------------------------- | ---------------------------------------- |
| Easing     | `cubic-bezier(0.22, 1, 0.36, 1)` | everything (`EASE`, `--ease-brand`)      |
| `micro`    | 150 ms                           | press, hover, focus, tooltip, exit       |
| `standard` | 250 ms                           | card, list item, value, toggle           |
| `page`     | 400 ms                           | a page coming in                         |
| `count`    | 600 ms                           | a number counting to its value           |
| `tooltip`  | 120 ms                           | a chart tooltip fading in                |
| Stagger    | 40 ms                            | cards of a group coming in one by one    |
| Success    | 1.2 s                            | a button's check mark after it succeeded |
| Toast      | 4 s                              | a toast before it leaves                 |

No springs with overshoot, no bounce on data: a figure lands where it is, once.

## Gestures

- **Page**: fades in while rising 8 px (`pageVariants`). The side menu and the top bar never
  move.
- **Cards**: come in one after the other (`groupVariants` + `itemVariants`, 40 ms apart). On hover
  a card rises 2 px and its border brightens to mint (`--border-strong`).
- **Numbers**: count up from the previous value in 600 ms (`useCountUp`). When the value gets
  better it flashes mint, when it gets worse a soft red; which way is better belongs to the
  figure (revenue at risk going down is good).
- **Risk rings and gauges**: the stroke draws from 0 to the value.
- **Charts**: lines draw in, bars grow from their baseline, tooltips fade in in 120 ms.
- **Lists**: a new item slides in from the top with a short mint highlight; a removed item
  folds away.
- **Buttons**: press scales to 0.98; while working, a spinner takes the label's place without
  changing the button's size; on success a check mark shows for 1.2 s.
- **Toasts**: slide in at the bottom right, stack, leave after 4 s.
- **Loading**: every data block shows its own shape (skeleton) with a light passing over it;
  never an empty box, never a page-wide spinner.

## Less motion

The app is wrapped in `<MotionConfig reducedMotion="user">`: when the device asks for less
motion, Motion keeps opacity changes and drops movement (no rise, no slide, no scale). Numbers
show their value at once; the skeleton's light stops (`prefers-reduced-motion` in
`styles.css`).

## Performance

- Animate only `transform` and `opacity` (and, for a number's flash, its color). Never width,
  height, top or left on a list or a chart: use `scaleX`/`scaleY` from the baseline instead.
- Heavy charts load when their card comes into view.
- 60 fps on a mid-range laptop inside Whop's frame is the bar.

## Adding a screen

1. Wrap the page in `<Page>` (it applies `pageVariants`).
2. Put its cards in a `<Stagger>` group; use `<MetricCard>`, `<ChartCard>`, `<Skeleton>`.
3. Never write a duration or an easing by hand: take them from `motion.ts`.

## Tests

The tests read what the screens say, not how they move: `apps/web/test/setup.ts` sets
`MotionGlobalConfig.skipAnimations`, so every animation lands on its end at once.
