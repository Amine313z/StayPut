# StayPut design tokens

The tokens live in one place, `apps/web/src/styles.css` (`:root` for light, `[data-theme='dark']`
for dark, mapped to Tailwind by `@theme inline`). Components never write a color, a font or a
duration by hand: they use the Tailwind names below (`bg-surface`, `text-muted`, `ease-brand`…).
Motion has its own page: [`MOTION.md`](../MOTION.md).

Dark is StayPut's own theme, sampled from the official logo (`docs/brand-logo-1024.png`): a deep
green-black with mint and silver. Light keeps the same hierarchy. Dark is the default; the
creator can choose light or the device's setting in the top bar.

## Colors

| Token (Tailwind)                  | Dark      | Light     | Used for                                  |
| --------------------------------- | --------- | --------- | ----------------------------------------- |
| `bg-deep` (`--bg-deep`)           | `#060908` | `#e8eeec` | behind everything, the side menu          |
| `bg` (`--bg`)                     | `#0b1512` | `#f3f6f5` | the page                                  |
| `surface` (`--surface`)           | `#10201c` | `#ffffff` | cards, dialogs                            |
| `surface-2` (`--surface-2`)       | `#142823` | `#eef3f1` | hover, inputs, quiet blocks               |
| `glow` (`--glow`)                 | `#194a3b` | `#cdefe2` | the light behind key figures (decoration) |
| `fg` (`--text`)                   | `#fbfcfb` | `#0b1512` | text                                      |
| `muted` (`--muted`)               | `#c0c7c4` | `#3f4b47` | secondary text                            |
| `subtle` (`--subtle`)             | `#7f8a86` | `#5c6864` | labels, placeholders (on bg and surface)  |
| `line` (`--border`)               | mint 16 % | ink 12 %  | 1 px borders                              |
| `line-strong` (`--border-strong`) | mint 40 % | green 45% | hovered card, the card of the day         |
| `accent` (`--accent`)             | `#ccf7e7` | `#17694f` | primary actions, active menu item, links  |
| `accent-2` (`--accent-2`)         | `#a7d7c4` | `#2e8a6c` | chart lines                               |
| `accent-soft` (`--accent-soft`)   | `#143a30` | `#e0f2ea` | tinted badges, avatars                    |
| `saved` (`--saved`)               | `#ccf7e7` | `#17694f` | money saved                               |
| `danger` (`--danger`)             | `#ff6b6b` | `#c92a2a` | money at risk, failures                   |
| `warning` (`--warning`)           | `#ffc56b` | `#8a5300` | test mode, medium risk text               |
| `info` (`--info`)                 | `#9ecfdb` | `#1c6577` | neutral news                              |

Each tinted background has its text token (`danger-soft` with `danger`, …). Every text and
background pair the screens use reaches WCAG AA in both themes: `apps/web/test/contrast.test.ts`
computes it and fails the build otherwise.

### Risk levels (marks only, never text)

| Level   | Token            | Dark      | Light     |
| ------- | ---------------- | --------- | --------- |
| Leaving | `risk-departure` | `#c2364e` | `#a51d36` |
| High    | `risk-high`      | `#ff6b6b` | `#e5484d` |
| Medium  | `risk-medium`    | `#ffc56b` | `#e8a23b` |
| Low     | `risk-low`       | `#5dbb98` | `#3e9b79` |

Side by side they stay distinct for color-blind eyes too (validated: adjacent ΔE ≥ 15 in normal
vision, ≥ 8 simulated). A level is never said by its color alone: its name, icon or count goes
with it.

## Type

| Role             | Face                 | Size / weight                                                |
| ---------------- | -------------------- | ------------------------------------------------------------ |
| Hero figure      | Space Grotesk 700    | 36–52 px by width, 46 px at 1 280 (`.metric-hero`), −0.02 em |
| Lead hero figure | Space Grotesk 700    | 40–56 px, 54 px at 1 280 (`.metric-lead`): the money saved   |
| Figure           | Space Grotesk 600    | 30 px (`.metric`), tabular                                   |
| Page title       | Inter 600            | 24–30 px                                                     |
| Card title       | Inter 600            | 16–20 px                                                     |
| Body             | Inter 400/500        | 14 px, line height 1.5                                       |
| Label            | Inter 500, uppercase | 12 px, +0.08 em, `subtle` (`.label-caps`)                    |

Figures always use tabular numerals: they line up in columns and do not jump while they count.

## Shapes and depth

- Radius: 16 px for cards (`rounded-2xl`), 12 px for inner blocks, 8 px for buttons and inputs.
- Borders: 1 px `line`; `line-strong` on hover and on the card that says what to do today.
- Shadows: `shadow-card` at rest, `shadow-lift` for what floats (hovered card, toast, menu).
- Glass (a blurred backdrop) only on what floats over the page: dialogs, the top bar, toasts.
- The brand's light: a soft glow at the top of the page and two thin diagonal streaks (dark
  theme), a glow behind the money saved, one streak on the card of the day. Decoration only.

## Layout

- Content up to 1 280 px wide, 24 px gutters (16 px on a phone).
- The side menu (240 px, 72 px folded) from 768 px; below, a bar at the bottom of the screen.
- Pages lay out by the room they have (Tailwind container queries), not by the window: inside
  Whop's frame the space beside Whop's own menu is what counts.
