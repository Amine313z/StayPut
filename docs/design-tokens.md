# StayPut design tokens

The tokens live in one place, `apps/web/src/styles.css` (`:root` for light, `[data-theme='dark']`
for dark, mapped to Tailwind by `@theme inline`). Components never write a color, a font or a
duration by hand: they use the Tailwind names below (`bg-surface`, `text-muted`, `ease-brand`…).
Motion has its own page: [`MOTION.md`](../MOTION.md).

Dark is StayPut's own theme and the default, sampled from the official logo
(`docs/brand-logo-1024.png`): one accent, mint on near-black, text in silver. Light keeps the
same hierarchy. The creator chooses in Settings › General (dark, light or the device's).

## Colors

| Token (Tailwind)                  | Dark                | Light               | Used for (the brief's name)                                |
| --------------------------------- | ------------------- | ------------------- | ---------------------------------------------------------- |
| `bg-deep` (`--bg-deep`)           | `#060908`           | `#e8eeec`           | the page's edges, the side menu (bg-deep)                  |
| `bg` (`--bg`)                     | `#0b1512`           | `#f3f6f5`           | the page (bg-core)                                         |
| `surface` (`--surface`)           | `#10201c`           | `#ffffff`           | cards and panels, at 60 % over the page (bg-elevated)      |
| `surface-2` (`--surface-2`)       | `#142823`           | `#eef3f1`           | hover, inputs, quiet blocks                                |
| `glow` (`--glow`)                 | `#194a3b`           | `#cdefe2`           | the soft light behind the money saved (bg-glow)            |
| `fg` (`--text`)                   | `#fbfcfb`           | `#0b1512`           | names, amounts, titles (silver-100)                        |
| `muted` (`--muted`)               | `#c0c7c4`           | `#3f4b47`           | UI text, the body's default (silver-300)                   |
| `subtle` (`--subtle`)             | `#7f8a86`           | `#5c6864`           | labels, placeholders (silver-500)                          |
| `line` (`--border`)               | mint 12 %           | green 14 %          | 1 px borders                                               |
| `line-strong` (`--border-strong`) | mint 40 %           | green 45 %          | a hovered card, the test-mode line                         |
| `accent` (`--accent`)             | `#ccf7e7`           | `#17694f`           | the one accent: primary button, active menu bar (mint-100) |
| `accent-2` (`--accent-2`)         | `#a7d7c4`           | `#2e8a6c`           | outlines, a chart's second mint (mint-300)                 |
| `accent-soft` (`--accent-soft`)   | `#143a30`           | `#e0f2ea`           | tinted badges, avatars                                     |
| `saved` (`--saved`)               | `#ccf7e7`           | `#17694f`           | money saved                                                |
| `danger` (`--danger`)             | `#ff6b6b`           | `#c92a2a`           | urgent only, as a dot or a small badge (urgent)            |
| `hero-from` → `hero-to`           | `#fbfcfb → #ccf7e7` | `#0b1512 → #17694f` | the logo's gradient: the money saved, primary button hover |

**One accent.** There is no amber and no second accent: `warning` and `serious` are kept only as
silver aliases (`muted`) for the screens still to redesign. A risk level has no color: the
ring's mint fill and the level's name say it.

**Red is for what is urgent**: a member leaving within 48 hours, a payment failed and not
recovered, an automation error, a destructive action. Then only as a dot (`UrgentDot`, `danger`
at 70 %) or a small badge, said in words to screen readers too; never a figure, a card, a fill
or a border. The revenue at risk is silver.

Every text and background pair the screens use reaches WCAG AA in both themes:
`apps/web/test/contrast.test.ts` computes it and fails the build otherwise.

## Type

| Role                     | Face                 | Size / weight                                              |
| ------------------------ | -------------------- | ---------------------------------------------------------- |
| Hero figure              | Space Grotesk 600    | 40 px (`.metric-hero`), tabular, −0.02 em, silver          |
| Lead figure: money saved | Space Grotesk 600    | 48 px (`.metric-lead`), the logo's gradient (`.text-hero`) |
| Figure                   | Space Grotesk 600    | 20–24 px (`.metric`), tabular                              |
| Page title               | Inter 600            | 24 px                                                      |
| Card title               | Inter 600            | 14 px                                                      |
| UI text                  | Inter 400/500        | 13–14 px, `muted` (silver-300), line height 1.5            |
| Label                    | Inter 500, uppercase | 12 px, +0.08 em, `subtle` (`.label-caps`)                  |

- Space Grotesk in 600 only (never 800): it is the only weight the site loads.
- Bold only for names and amounts.
- Two text sizes per card at most, its label and its value: what a figure means goes behind an
  « i » (`InfoTip`), never in a sentence under it.
- One primary (mint) button per screen at most; every other action is a ghost.
- Figures always use tabular numerals: they line up and do not jump while they count.

## Shapes, depth, spacing

- Radius 12 px (`rounded-xl`) for cards, panels and empty states; 8 px for buttons, inputs and
  rows inside a card.
- Cards: `bg-surface/60` with a 1 px `line` border, no shadow in dark; on hover the border turns
  `line-strong` and the card rises 2 px.
- 24 px between cards (`gap-6`, `space-y-6`), 20 px inside (`p-5`). Never deeper than page →
  card → row.
- The only decoration: the logo's diagonal mint streak in the page background (dark theme), and
  the soft glow behind the money saved.

## Layout

- Content up to 1 280 px wide, 24 px gutters (16 px on a phone).
- The side menu (240 px, 72 px folded, a mint bar on the open section) from 768 px; below, a bar
  at the bottom of the screen.
- Pages lay out by the room they have (Tailwind container queries), not by the window: inside
  Whop's frame the space beside Whop's own menu is what counts.

## Charts

- One value axis, round steps from 0. The main series is a 2 px mint line over a mint gradient
  fading to transparent; a second series is a dashed silver line. A legend names them (never a
  color alone), a crosshair and a tooltip follow the pointer or the arrow keys, and screen
  readers get a sentence and the table of the figures.
