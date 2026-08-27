# Design system

The visual substrate for every PrintPartner page: surfaces, type, rhythm, status,
targets, motion, and focus. Tokens live in `web/apps/web/src/index.css`. Status
meaning lives in `web/apps/web/src/lib/statusTone.ts`. Primitives live in
`web/apps/web/src/components/ui/`.

The palette is desk ink, paper, and brass. One accent family, no second palette.
Dark is the product default because most of this work happens at a desk in a
workshop, not in daylight.

Contrast numbers below were measured from the token values with the WCAG 2
relative-luminance formula, not estimated.

## Surfaces

Four steps. Pick by role, not by taste.

| Step | Token | Use it for |
| --- | --- | --- |
| sunken | `--surface-sunken`, `bg-surface-sunken` | Wells inside a card, tab strips, table headers |
| base | `--surface-base`, `bg-background` | The page itself |
| raised | `--surface-raised`, `bg-card` | Cards and panels, dialogs, sheets |
| overlay | `--surface-overlay`, `bg-popover` | Popovers, menus, selects, tooltips, toasts |

Dark separates by value: the step from base to raised is 1.24:1, raised to overlay
1.12:1. Light cannot do that (white on off-white is 1.04:1), so light separates with
`--border` plus `--shadow-sm`. Both themes get the same reading order.

`Card` takes `surface="raised" | "flat" | "sunken"`. A `sunken` card inside a raised
card reads as a well. Do not stack raised on raised.

### Text contrast

Ratios by surface (sunken / base / raised / overlay).

Dark:

| Ink | sunken | base | raised | overlay |
| --- | --- | --- | --- | --- |
| foreground | 17.03 | 15.40 | 12.46 | 11.17 |
| muted-foreground | 7.52 | 6.80 | 5.50 | 4.93 |
| primary (brass, also the focus ring) | 6.90 | 6.24 | 5.04 | 4.52 |
| success | 8.71 | 7.88 | 6.37 | 5.71 |
| warning | 9.14 | 8.26 | 6.68 | 5.99 |
| info | 7.81 | 7.06 | 5.71 | 5.12 |
| destructive | 7.27 | 6.57 | 5.32 | 4.77 |
| border-strong | 5.46 | 4.94 | 4.00 | 3.58 |

Light:

| Ink | sunken | base | raised | overlay |
| --- | --- | --- | --- | --- |
| foreground | 12.97 | 14.45 | 15.05 | 15.35 |
| muted-foreground | 5.08 | 5.67 | 5.90 | 6.02 |
| primary | 4.17 | 4.65 | 4.84 | 4.94 |
| success | 4.83 | 5.38 | 5.60 | 5.71 |
| warning | 4.51 | 5.03 | 5.24 | 5.34 |
| info | 4.63 | 5.16 | 5.38 | 5.49 |
| destructive | 5.66 | 6.31 | 6.57 | 6.70 |
| border-strong | 3.46 | 3.85 | 4.01 | 4.09 |

Every ink clears AA (4.5:1) on every surface it is allowed on. `--border-strong`
clears AA non-text (3:1) everywhere, which is why it draws control boundaries.
Status text on a `-soft` chip runs 4.51:1 to 6.58:1.

`--accent` is a hover fill for controls whose text is `--accent-foreground`. Status
color on `--accent` drops to about 3.6:1, so do not put status text there.

### Borders

- `--border` is a hairline between blocks. It is quiet on purpose.
- `--border-strong` is the boundary of a control. `--input` is an alias of it, so
  every input, textarea, select, and switch track is visible without hovering.

## Type

`--font-sans` is Source Sans 3 for everything. `--font-serif` is Source Serif 4 and
has exactly two jobs: the wordmark, and `h1` page titles. `--font-mono` is IBM Plex
Mono for filenames, ids, and eyebrows.

| Utility | Size | Line height | Use |
| --- | --- | --- | --- |
| `text-micro` | 11px | 16px | Eyebrows, units, axis labels. Never a sentence |
| `text-meta` | 13px | 18px | Chips, table meta, timestamps |
| `text-body` | 14px | 22px | Default reading size |
| `text-lead` | 16px | 24px | Card intros, summary lines |
| `text-title` | 18px | 24px | Card and dialog titles |
| `text-section` | 22px | 28px | Section headings |
| `text-page` | 28px | 34px | Page title |

11px is the floor. `text-3xs` used to be 10px and was carrying real status text; it
now resolves to 11px, same as `text-2xs` and `text-micro`. Both old names still work,
but write new code with `text-micro`.

Numbers must not jitter while a count updates. `code`, `kbd`, `pre`, `time`,
`font-mono`, and number inputs get tabular figures from the base layer. Anywhere else
that shows a changing quantity, add the `tabular` class. `Badge` already has it.

## Rhythm

Stop hand-picking `space-y-*` per page. Three tokens, three utilities.

| Token | Phone | 1024px and up | Utility |
| --- | --- | --- | --- |
| `--space-row` | 8px | 10px | `.stack-row` for rows inside a block |
| `--space-section` | 16px | 20px | `.stack-section` for blocks inside a section |
| `--space-page` | 20px | 28px | `.stack-page` for sections on a page |

All three are `flex-direction: column` with a gap and `min-width: 0`, so long
filenames truncate instead of pushing the layout wide.

`.eyebrow` is the mono uppercase label above a title. `.section-heading` is the
18px semibold section label.

## Status

`lib/statusTone.ts` owns status meaning. Seven workflow states, one tone, one shape,
and one default label each.

| State | Tone | Icon | Default words |
| --- | --- | --- | --- |
| `not_started` | neutral | dashed circle | Not started |
| `ready` | info | circled arrow | Ready |
| `in_progress` | info | spinner ring | In progress |
| `needs_attention` | warning | triangle | Needs attention |
| `complete` | success | circled check | Complete |
| `stale` | warning | refresh arrows | Needs refresh |
| `error` | error | circled alert | Error |

Render it with `StatusBadge`, which always draws the icon and the words:

```tsx
<StatusBadge status="needs_attention" label="Needs your decision" live />
```

The icon shape differs per state, so the meaning survives without color (WCAG G14).
`live` opts into the live region the state asks for: polite `status` for progress and
success, `alert` only for `error`. Do not wrap a badge in your own live region.

Need a custom row instead of a chip? Read the parts from
`workflowStatusPresentation(kind)` and keep the words. Use
`statusTone({ tone, emphasis })` for color: `text` for inline copy, `soft` for chips
and banners, `outline` for a quiet chip, `solid` for progress fills.

## Target size

Every interactive primitive clears the WCAG 2.2 minimum of 24 by 24 CSS px.

| Control | Size |
| --- | --- |
| `Button` default | 36px tall, 36px minimum wide |
| `Button size="sm"` | 32px |
| `Button size="lg"` | 40px |
| `Button size="icon"` | 36 by 36 |
| `Button size="shop"` / `size="shopIcon"` | 44 by 44 |
| `Switch` | 20px track, 24px pointer target |
| `Switch size="shop"` | 28px track, 44px pointer target |
| Tab trigger, segment | 32px |

Use `shop` for the primary action on Checkoff and Production, the two surfaces an
operator touches with one hand beside a running printer. Apple's accessibility
guidance puts the touch default at 44 points, and that is the number worth hitting
where it matters rather than everywhere.

## Motion

| Token | Value | Use |
| --- | --- | --- |
| `--motion-fast` | 110ms | Hover, press, color change |
| `--motion-base` | 170ms | The default for every `transition-*` utility |
| `--motion-slow` | 260ms | Panels and sheets entering |
| `--motion-ease` | `cubic-bezier(0.2, 0, 0, 1)` | All of them |

`prefers-reduced-motion: reduce` collapses the tokens and every animation. Use
`motion-safe:` for anything that loops, like the `in_progress` spinner.

## Focus

One treatment, set once in the base layer: a 2px brass outline, offset 2px. The offset
puts the ring on the surface behind the control, so it stays visible on a brass button,
inside a card, and inside a dialog. The ring measures 4.52:1 or better against every
surface in dark and 4.17:1 or better in light.

Do not write `focus-visible:outline-none` in a primitive. If you kill the outline you
own the replacement, and it has to clear 3:1 against whatever is behind it.

## Do and do not

- Do use `bg-card`, `bg-popover`, and `bg-surface-sunken`. Do not invent a fifth surface.
- Do color status through `statusTone` or `StatusBadge`. Do not write
  `text-green-600`; `lib/statusTokens.test.ts` fails the build for raw palette classes.
- Do pair every status color with words. A colored dot on its own is not a status.
- Do use `.stack-page`, `.stack-section`, `.stack-row`. Do not hand-tune `space-y-*`.
- Do use `text-micro` for labels only. Do not set a sentence below 14px.
- Do add `tabular` to any changing number.
- Do use `Card surface="sunken"` for a well. Do not nest a raised card in a raised card.
- Do give the primary shop-floor action `size="shop"`. Do not shrink a control below
  24 by 24 to fit a layout. Change the layout.
- Do keep serif for the wordmark and page titles. Everything else is Source Sans 3.
