# StayPut design tokens

The tokens live in one place, `apps/web/src/styles.css` (`:root`, mapped to Tailwind by
`@theme inline`). Components never write a color, a font or a duration by hand: they use the
Tailwind names below (`bg-surface`, `text-muted`, `ease-brand`…). Motion has its own page:
[`MOTION.md`](../MOTION.md). The values are the brief's (v4: black · turquoise · white).

**Dark is the brand and the only theme.** There is no light theme and no theme setting.

## The palette

Exactly these twelve colors; Tailwind's own palette is switched off (`--color-*: initial`), so a
color that is not here does not exist. Anything else is one of them, at most with an alpha.

| Token (Tailwind)          | Value                   | Used for                                          |
| ------------------------- | ----------------------- | ------------------------------------------------- |
| `black-900` (`bg`)        | `#050607`               | the page                                          |
| `black-800` (`surface`)   | `#0A0D10`               | main surfaces: the side menu, a table             |
| `black-700` (`surface-2`) | `#11161B`               | elevated: drawers, menus, tooltips, avatars       |
| `black-600` (`surface-3`) | `#1A2129`               | hover surfaces; the 1 px dividers (`line`)        |
| `turq-100`                | `#9FF5EA`               | highlights, the end of the signature gradient     |
| `turq-300` (`accent`)     | `#5EEAD4`               | active states, the chart line, rings, focus rings |
| `turq-500` (`accent-2`)   | `#2BC4B4`               | pressed states, the chart gradient's base         |
| `turq-glow` (`glow`)      | `rgba(94,234,212,0.18)` | the radial light behind the hero block            |
| `white-100` (`fg`)        | `#FFFFFF`               | amounts, names, titles                            |
| `white-300` (`muted`)     | `#D9DEE3`               | UI text, the body's default                       |
| `white-500` (`subtle`)    | `#8A94A0`               | muted text, labels, placeholders                  |
| `urgent` (`danger`)       | `#FF5C5C`               | urgent only, as a small dot or badge at 70 %      |

- **The signature gradient**, white → light turquoise (`#FFFFFF → #9FF5EA`, `.button-primary`),
  is the single accent: the primary button (black text) and the logo's ribbon. Never on an
  amount (brief v4 §5): the amounts are solid white, as Whop writes a balance.
- **Turquoise is light and airy**: at full strength only on thin things (lines, rings, 1 px
  borders, text). Never a large turquoise fill: a tile behind an icon is `surface-2`.
- **The ghost outline** (`line-strong`) is turquoise at 25 %.
- **Red is for what is urgent**: a member leaving within 48 hours, a payment failed and not
  recovered, an automation error, a destructive action. Then only as a dot (`UrgentDot`,
  `urgent` at 70 %) or a small badge, said in words to screen readers too; never a figure, a
  fill or a border. The revenue at risk is white.
- **Risk levels have no color**: the turquoise ring and the level's name say them. `warning`
  and `serious` remain only as white-300 aliases for the screens still to redesign.
- Discord and Telegram wear the palette's turquoises, never their own blue or purple.

`apps/web/test/contrast.test.ts` checks the palette value by value, that every color written in
`styles.css` and in `apps/web/src` is one of these twelve (alpha allowed), and that every text /
background pair the screens use reaches WCAG AA.

## Atmosphere

Nothing else decorates the page:

- one radial light, `turq-glow` fading over 700 px, behind the hero block (`.hero-glow`, a
  gradient rather than a blur filter);
- one very light diagonal streak, turquoise at 6 %, the logo's (`body::before`, fixed);
- StayPut's logo at 3 % in the bottom right corner of the Dashboard, after its last block.

## The logo

The « S » ribbon, white → light turquoise, on a pure black (`black-900`) rounded square:
`docs/brand-logo-1024.png`, exported to `apps/web/public/logo-64|128|256.png`, `favicon-32.png`
and `apple-touch-icon.png`. At 32 px in the top bar, as the favicon, in loading and empty states,
and as the Dashboard's watermark.

## Type

Two families, both served by StayPut itself (the CSP allows no other origin):

- **Satoshi** (Indian Type Foundry, Fontshare, ITF Free Font License) for every number of the
  app (amounts, counts, scores, the charts' axes: one font, `.num` or a `.metric*` class) and
  for the titles.
  Its license allows using it in our own app but forbids passing the files on, and the repository
  is public: the file is downloaded from Fontshare at each deployment and never committed
  (`scripts/deploy/satoshi.ts`, its fingerprint pinned). Without it (locally), Geist takes its
  place.
- **Geist** (Vercel, SIL OFL) for the UI, from `@fontsource-variable/geist`.

| Role             | Face          | Size / weight                                                     |
| ---------------- | ------------- | ----------------------------------------------------------------- |
| Hero amount      | Satoshi 700   | 48 px (`.metric-lead`), −0.04 em, tabular, solid white            |
| Secondary amount | Satoshi 600   | 28 px (`.metric-hero`), −0.02 em, tabular, white                  |
| A list's amount  | Satoshi 500   | 14 px (`.metric`), tabular, white                                 |
| Any other number | Satoshi       | the size of its line (`.num`: Satoshi and tabular numerals)       |
| Page title       | Satoshi 700   | 22 px (`.title-page`), white                                      |
| Section title    | Satoshi 700   | 15 px (`.title-section`), white                                   |
| UI text          | Geist 400/500 | 13–14 px, `muted` (white-300), line height 1.5                    |
| Label            | Geist 500     | 12 px, sentence case, no letter-spacing, `subtle` (`.label-text`) |

- **Amounts as Whop writes them** (brief v4 §7): the symbol and the cents, always: « $247.00 »,
  « $1,284.50 »; in French « 247,00 $ » (the symbol alone, never « $US »). Counts (members,
  messages) without decimals. A chart's axis alone may shorten an amount (« $1.2K »). The
  translator's `currency` does it (`packages/i18n`).
- Figures always use tabular numerals: they line up and do not jump while they count. Never a
  monospace.
- Two text sizes per element at most. No sentence under a figure and no « i » icon: what a
  figure means is a tooltip on its label's own words (`LabelTip`, dotted underline), two lines at
  most, in plain words (« limits », never « guardrails »).

## Shapes, spacing, buttons

- 32 px between sections (`space-y-8`), 20 px inside (`p-5`), 12 px radius (`rounded-xl`);
  8 px for buttons, inputs and rows. Never deeper than page → section → row.
- The Dashboard's hero block has no inner boxes: 1 px dividers only.
- **One primary button per screen**: the signature gradient, black text (`button-primary`).
  Every other action is a ghost: 1 px turquoise 25 % outline, white text (`button-ghost`), or
  bare words. A destructive action is a ghost with the red dot, never a red fill.
- Avatars: white initials on `black-700` with a 1 px turquoise 15 % ring.

## Layout

- Content up to 1 280 px wide, 24 px gutters (16 px on a phone).
- From 768 px, the side menu: 220 px, 64 px folded (icons, with a tooltip each); the open
  section has a 2 px turquoise bar and a turquoise icon. Below 768 px, a bar at the bottom of
  the screen.
- The top bar: the « S » logo, the community's name and logo from Whop (never its `biz_` id,
  which lives in Settings › Developer), the member search (⌘K / Ctrl K), the Guide.
- Test mode on: a slim bar outlined in 1 px turquoise, muted text, and its ghost « Turn off ».
- Pages lay out by the room they have (Tailwind container queries), not by the window: inside
  Whop's frame the space beside Whop's own menu is what counts.

## Charts

- One value axis, round steps from 0. The main series is a 2 px turquoise line over a turquoise
  gradient fading to transparent (`turq-300` 28 % → `turq-500` 10 % → 0); a second series is a
  dashed white-300 line. A legend names them (never a color alone), a crosshair and a tooltip
  with both values follow the pointer or the arrow keys, and screen readers get a sentence and
  the table of the figures. Grid lines `black-600` at 60 %, axis labels 11 px white-500.
