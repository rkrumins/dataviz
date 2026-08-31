/**
 * `bg-canvas-elevated/95` paints NOTHING. Not a lighter panel — nothing.
 *
 * This app's colour tokens are bare `var()`s (`tailwind.config.js`): the
 * variables hold COMPLETE colours, not channel triples, so Tailwind cannot
 * build `rgb(… / <alpha>)` out of them and silently emits no rule at all. The
 * element ends up transparent; in a gradient it is worse, because an unset
 * `--tw-gradient-stops` invalidates the whole `background-image`.
 *
 * The same silence swallows an OFF-SCALE modifier on a perfectly good colour:
 * `/12`, `/8`, `/22`, `/98` are not in Tailwind 3.4's opacity scale, so
 * `bg-emerald-500/12` and `bg-accent-lineage/12` emit nothing either — the
 * accent family got raw channels in b9e06b2d and 39 of its tints STILL paint
 * nothing for this second reason.
 *
 * A dead class is not automatically a transparent surface BY MISTAKE, which is
 * the trap on the way out: 75208053 reverted nine of these after they were
 * "fixed" to opaque tokens, because those surfaces float over the canvas with a
 * `backdrop-blur` and the transparency was the whole design. What is always
 * wrong is the class: it asks for a colour and gets none. Whether the answer is
 * a colour or no class at all is a look, not a lint.
 *
 * Both failures are invisible in review, in jsdom, and in a screenshot of a
 * surface that also carries `backdrop-blur` — which is how five of them
 * shipped in one day (notification cards, a canvas panel, seven sticky
 * headers, HoverTip's border, PropertyManagerDrawer) and how 1,066
 * `accent-lineage/NN` usages across 208 files sat dead long enough for the app to
 * simply read grey.
 *
 * So this guard does not pattern-match. It derives the token list FROM the
 * config — a bare-`var()` token added tomorrow is covered on the day it lands
 * — collects every alpha-suffixed usage of one, and COMPILES them with the
 * real Tailwind config. A class is a violation only when the compiler proves
 * no rule comes out, which is why `bg-emerald-500/10` and `bg-accent-lineage/15`
 * pass and must keep passing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { stripComments } from '@/test/jsxSourceScan'

const ROOT = resolve(__dirname, '../..')
const SRC = resolve(ROOT, 'src')

const HOW_TO_FIX =
  'An alpha suffix on one of this app\'s CSS-variable tokens emits NO CSS. Four ways '
  + 'out, and the right one depends on what the surface is FOR: the plain token when it '
  + 'is meant to be opaque (`bg-canvas-elevated`); a real palette colour when you '
  + 'actually want alpha (`bg-black/[0.04]`); raw channels + `<alpha-value>` in '
  + 'tailwind.config.js, the way the accent family got them in b9e06b2d; or simply '
  + 'DELETE the class, when the surface is meant to be see-through and a `backdrop-blur` '
  + 'sibling is already doing the work. Do not reach for the first one by reflex — '
  + '75208053 reverted nine surfaces made opaque on exactly that reasoning, because '
  + 'their transparency was the design. For an OFF-SCALE amount, the fix is only ever '
  + 'notation: `/12` -> `/[0.12]`.'

/**
 * Alpha suffixes that are dead ON PURPOSE. Nothing qualifies yet: an unpaintable
 * class has no upside, so anything landing here needs a reason why the element is
 * meant to have no colour rule at all.
 */
const ALLOWED = new Map<string, string>()

/**
 * The dead classes already in the tree, with the number of times each occurs.
 *
 * This is a RATCHET, not an amnesty. The list is pinned exactly: a new dead
 * class fails, a dead class used MORE often fails, and a dead class used less
 * often fails too — because that means someone fixed sites and the number here
 * has to come down with them. It is deliberately a full inventory rather than a
 * total, so the failure message can name what changed.
 *
 * Why it exists at all: 1,669 of these are already in 323 files, and clearing
 * them is a THEME change (raw channels for the canvas/ink families, and a
 * decision about `--nx-border-glass`, which already carries its own 0.4 alpha
 * and so cannot become a channel triple without lightening 343 borders). That
 * is an app-wide visual delta that needs its own review; it is not something to
 * smuggle in under a test. What this guard buys today is that the number can
 * only go down.
 */
/** The sum of the numbers below, recorded with them. */
const BASELINE_TOTAL = 1669

const BASELINE = new Map<string, number>([
  ['bg-accent-business/8', 4],
  ['bg-accent-lineage/12', 27],
  ['bg-accent-lineage/22', 1],
  ['bg-accent-lineage/8', 3],
  ['bg-canvas-base/20', 5],
  ['bg-canvas-base/30', 13],
  ['bg-canvas-base/40', 22],
  ['bg-canvas-base/50', 7],
  ['bg-canvas-base/60', 4],
  ['bg-canvas-base/70', 4],
  ['bg-canvas-base/80', 1],
  ['bg-canvas-elevated/10', 2],
  ['bg-canvas-elevated/20', 1],
  ['bg-canvas-elevated/30', 14],
  ['bg-canvas-elevated/40', 23],
  ['bg-canvas-elevated/50', 27],
  ['bg-canvas-elevated/60', 18],
  ['bg-canvas-elevated/70', 4],
  ['bg-canvas-elevated/80', 7],
  ['bg-canvas-elevated/85', 3],
  ['bg-canvas-elevated/90', 6],
  ['bg-canvas-elevated/95', 37],
  ['bg-canvas-elevated/98', 19],
  ['bg-canvas-overlay/30', 2],
  ['bg-canvas-overlay/40', 15],
  ['bg-canvas-overlay/50', 3],
  ['bg-canvas-overlay/60', 4],
  ['bg-canvas-overlay/95', 1],
  ['bg-canvas/40', 5],
  ['bg-canvas/50', 1],
  ['bg-canvas/60', 10],
  ['bg-canvas/70', 1],
  ['bg-canvas/80', 4],
  ['bg-canvas/95', 1],
  ['bg-canvas/98', 3],
  ['bg-glass-border/30', 1],
  ['bg-glass-border/50', 2],
  ['bg-glass-border/60', 13],
  ['bg-glass-border/70', 2],
  ['bg-glass/20', 7],
  ['bg-glass/30', 26],
  ['bg-glass/40', 42],
  ['bg-glass/50', 6],
  ['bg-glass/60', 3],
  ['bg-glass/70', 2],
  ['bg-ink-muted/10', 17],
  ['bg-ink-muted/20', 1],
  ['bg-ink-muted/25', 7],
  ['bg-ink-muted/30', 2],
  ['bg-ink-muted/40', 3],
  ['bg-ink-muted/5', 1],
  ['bg-ink-muted/50', 5],
  ['bg-ink-muted/60', 3],
  ['bg-ink/10', 2],
  ['bg-ink/5', 5],
  ['bg-ink/[0.06]', 1],
  ['border-b-glass-border/30', 1],
  ['border-glass-border/20', 5],
  ['border-glass-border/30', 23],
  ['border-glass-border/40', 71],
  ['border-glass-border/50', 90],
  ['border-glass-border/60', 110],
  ['border-glass-border/70', 13],
  ['border-glass-border/80', 31],
  ['border-ink-muted/20', 2],
  ['border-ink-muted/30', 17],
  ['border-ink-muted/35', 4],
  ['border-ink-muted/40', 10],
  ['border-ink-muted/50', 3],
  ['border-ink-muted/70', 1],
  ['border-l-glass-border/60', 1],
  ['decoration-ink-muted/40', 2],
  ['divide-glass-border/30', 5],
  ['divide-glass-border/40', 1],
  ['divide-glass-border/50', 9],
  ['from-accent-lineage/12', 1],
  ['from-accent-lineage/18', 1],
  ['from-accent-lineage/8', 1],
  ['from-canvas-base/55', 1],
  ['from-canvas-elevated/40', 1],
  ['from-canvas-elevated/80', 2],
  ['from-canvas-elevated/90', 2],
  ['from-canvas-elevated/95', 1],
  ['from-canvas-elevated/96', 1],
  ['from-canvas/80', 2],
  ['from-glass/40', 1],
  ['from-glass/50', 1],
  ['placeholder-ink-muted/40', 1],
  ['placeholder-ink-muted/60', 1],
  ['ring-ink-muted/60', 1],
  ['stroke-ink-muted/10', 1],
  ['stroke-ink-muted/15', 1],
  ['stroke-ink-muted/30', 1],
  ['text-ink-muted/0', 3],
  ['text-ink-muted/20', 5],
  ['text-ink-muted/25', 2],
  ['text-ink-muted/30', 25],
  ['text-ink-muted/35', 1],
  ['text-ink-muted/40', 95],
  ['text-ink-muted/45', 6],
  ['text-ink-muted/50', 146],
  ['text-ink-muted/55', 5],
  ['text-ink-muted/60', 178],
  ['text-ink-muted/65', 2],
  ['text-ink-muted/70', 183],
  ['text-ink-muted/80', 85],
  ['text-ink-muted/85', 10],
  ['text-ink-muted/90', 4],
  ['text-ink-muted/95', 1],
  ['text-ink/70', 2],
  ['text-ink/80', 2],
  ['text-ink/85', 5],
  ['text-ink/90', 8],
  ['text-ink/95', 1],
  ['to-accent-explore/3', 1],
  ['to-canvas-base/30', 1],
  ['to-canvas-base/95', 3],
  ['to-canvas-elevated/20', 1],
  ['to-canvas-elevated/30', 1],
  ['to-canvas-elevated/90', 2],
  ['to-canvas-elevated/95', 1],
  ['to-canvas-elevated/96', 1],
  ['to-glass/20', 2],
  ['via-canvas-elevated/30', 3],
  ['via-canvas-elevated/40', 4],
  ['via-canvas-elevated/70', 1],
  ['via-canvas-elevated/80', 1],
  ['via-canvas-elevated/95', 2],
  ['via-canvas/70', 2],
  ['via-glass-border/50', 1],
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') out.push(...sourceFiles(path))
    } else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      // Tests are not shipped surfaces, and this one QUOTES every dead class
      // in its own baseline — scanning them would make the guard find itself.
      out.push(path)
    }
  }
  return out
}

/** Every `<something>-<token>-<name>` leaf of the config's colour tree. */
function tokenNames(colors: Record<string, unknown>, path: string[] = []): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(colors)) {
    if (value && typeof value === 'object') {
      out.push(...tokenNames(value as Record<string, unknown>, [...path, key]))
    } else {
      const name = key === 'DEFAULT' ? path : [...path, key]
      if (name.length) out.push(name.join('-'))
    }
  }
  return out
}

/** `.bg-canvas-elevated\/95` — the selector Tailwind would emit for a class. */
const selectorFor = (cls: string) => '.' + cls.replace(/[.\\/[\]:%]/g, (c) => '\\' + c)

let compile: (classes: string[]) => Promise<string>
let tokens: string[]
let occurrences: Map<string, string[]>
let dead: string[]

beforeAll(async () => {
  const postcss = (await import('postcss')).default
  const tailwind = (await import('tailwindcss')).default
  const config = (await import(pathToFileURL(resolve(ROOT, 'tailwind.config.js')).href)).default

  compile = async (classes) => {
    const probe = { ...config, content: [{ raw: classes.join(' '), extension: 'html' }] }
    const out = await postcss([tailwind(probe) as never]).process('@tailwind utilities;', { from: undefined })
    return out.css
  }

  tokens = tokenNames(config.theme.extend.colors).sort((a, b) => b.length - a.length)
  // `<utility->` `<token>` `/<amount>`, where the amount is a scale step or an
  // arbitrary `[0.04]`. Anchored on a config token so `w-1/2` and the `/item` in
  // `group-hover/item:` can never be mistaken for a colour.
  const usage = new RegExp(
    String.raw`(?<![-\w])((?:[a-z][a-z0-9]*-)*)(${tokens.join('|')})\/(\[[^\]\s]+\]|\d{1,3})(?![\w-])`,
    'g',
  )

  occurrences = new Map()
  for (const file of sourceFiles(SRC)) {
    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(usage)) {
          const cls = `${m[1]}${m[2]}/${m[3]}`
          if (ALLOWED.has(cls)) continue
          const at = `${relative(SRC, file)}:${i + 1}`
          occurrences.set(cls, [...(occurrences.get(cls) ?? []), at])
        }
      })
  }

  const css = await compile([...occurrences.keys()])
  dead = [...occurrences.keys()]
    .filter((cls) => !css.includes(`${selectorFor(cls)} `) && !css.includes(`${selectorFor(cls)},`))
    .sort()
})

describe('an alpha suffix on a CSS-variable token emits no rule', () => {
  it('the probe compiles: alpha that IS valid comes out as CSS', async () => {
    // The whole guard rests on "no rule in the output means no rule". Pin the
    // other direction first, or a probe that silently compiled nothing would
    // report the entire app as broken — or, worse, an empty scan as clean.
    const css = await compile(['bg-emerald-500/10', 'bg-black/[0.04]', 'bg-accent-lineage/15', 'ring-accent-lineage/30'])
    expect(css).toContain('rgb(16 185 129 / 0.1)')
    expect(css).toContain('rgb(0 0 0 / 0.04)')
    expect(css).toContain('rgb(var(--nx-accent-lineage-rgb) / 0.15)')
    expect(css).toContain('--tw-ring-color: rgb(var(--nx-accent-lineage-rgb) / 0.3)')
  })

  it('reproduces the defect b9e06b2d fixed: bare var() tokens drop every alpha', async () => {
    // The accent family as it was BEFORE b9e06b2d. If this ever stops going
    // dead, the compiler no longer distinguishes the two shapes and every
    // assertion below is worthless.
    const config = (await import(pathToFileURL(resolve(ROOT, 'tailwind.config.js')).href)).default
    const postcss = (await import('postcss')).default
    const tailwind = (await import('tailwindcss')).default
    const historical = {
      ...config,
      theme: {
        ...config.theme,
        extend: {
          ...config.theme.extend,
          colors: { ...config.theme.extend.colors, accent: { lineage: 'var(--nx-accent-lineage)' } },
        },
      },
      content: [{ raw: 'bg-accent-lineage/15 bg-accent-lineage', extension: 'html' }],
    }
    const css = (await postcss([tailwind(historical) as never]).process('@tailwind utilities;', { from: undefined })).css
    expect(css).toContain('.bg-accent-lineage {')
    expect(css).not.toContain('.bg-accent-lineage\\/15')
  })

  it('the sweep reaches the config tokens and the app source', () => {
    expect(tokens).toContain('canvas-elevated')
    expect(tokens).toContain('glass-border')
    expect(tokens).toContain('ink-muted')
    expect(tokens).toContain('accent-lineage')
    // A token family added to the config later is picked up here for free.
    expect(occurrences.size).toBeGreaterThan(100)
  })

  it('no alpha suffix that compiles to nothing outside the recorded baseline', () => {
    const added = dead.filter((cls) => !BASELINE.has(cls))
    expect(
      added.map((cls) => `${cls} — ${occurrences.get(cls)!.slice(0, 3).join(', ')}`),
      `These classes compile to NO CSS, so the element gets no colour at all. ${HOW_TO_FIX}`,
    ).toEqual([])
  })

  it('no baselined class spreads to more sites than it already had', () => {
    // The numbers are a CEILING, not an equality: several agents work this tree
    // at once, so a count that DROPS is someone fixing sites and must not fail
    // their run. A count that RISES is a new dead usage of a shape we already
    // know paints nothing, which is exactly the regression this exists to stop.
    const grown = dead
      .filter((cls) => occurrences.get(cls)!.length > (BASELINE.get(cls) ?? 0))
      .map((cls) => `${cls}: ${BASELINE.get(cls)} -> ${occurrences.get(cls)!.length}. ${occurrences.get(cls)!.slice(0, 4).join(', ')}`)
    expect(grown, HOW_TO_FIX).toEqual([])
  })

  it('the dead total does not grow', () => {
    // A second ceiling over the whole sweep, so a shape that gets renamed
    // rather than fixed cannot hide under the per-class ceilings.
    const total = dead.reduce((n, cls) => n + occurrences.get(cls)!.length, 0)
    expect(total, `${total} dead alpha usages, up from ${BASELINE_TOTAL}. ${HOW_TO_FIX}`).toBeLessThanOrEqual(BASELINE_TOTAL)
  })
})
