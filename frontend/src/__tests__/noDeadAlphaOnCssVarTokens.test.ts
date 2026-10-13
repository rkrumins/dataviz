/**
 * `bg-canvas-elevated/95` used to paint NOTHING. Not a lighter panel — nothing.
 *
 * This app's theme colours live in CSS variables that hold COMPLETE colours
 * (`#8898a9`, `rgba(255,255,255,.4)`), not channel triples. Declared as bare
 * `var()`s, Tailwind cannot build `rgb(… / <alpha>)` out of them and silently
 * emits no rule at all for a modified class: the element ends up transparent,
 * and in a gradient it is worse, because an unset `--tw-gradient-stops`
 * invalidates the whole `background-image`. About 1,700 classes across the app
 * shipped that way — sticky headers, borders that fell back to the default
 * grey (bright in the dark theme), and 1,066 `accent-lineage/NN` usages that
 * left the app reading grey until the accents got raw channels (b9e06b2d).
 * `tailwind.config.js` now declares those tokens as colour FUNCTIONS that
 * answer every modifier; a token added tomorrow as a bare `var()` would bring
 * the silence straight back.
 *
 * The same silence swallows an OFF-SCALE modifier on a perfectly good colour:
 * Tailwind's opacity scale goes in fives, so `bg-emerald-500/8` emitted nothing
 * either until the steps this app is written with were named in the config.
 * `/7` tomorrow would be dead again.
 *
 * Both failures are invisible in review, in jsdom, and in a screenshot of a
 * surface that also carries `backdrop-blur` — which is how five of them
 * shipped in one day (notification cards, a canvas panel, seven sticky
 * headers, HoverTip's border, PropertyManagerDrawer).
 *
 * So this guard does not pattern-match. It derives the token list FROM the
 * config — a token added tomorrow is covered on the day it lands — collects
 * every alpha-suffixed usage of one (and of the stock palette), and COMPILES
 * them with the real Tailwind config. A class is a violation only when the
 * compiler proves no rule comes out.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { stripComments } from '@/test/jsxSourceScan'

const ROOT = resolve(__dirname, '../..')
const SRC = resolve(ROOT, 'src')

const HOW_TO_FIX =
  'An alpha suffix that emits NO CSS gives the element no colour at all. Two causes, '
  + 'with different fixes. A colour token declared as a bare `var()` in tailwind.config.js '
  + 'drops every modifier: declare it with `withAlpha(...)` (or as raw channels + '
  + '`<alpha-value>`, the way the accent family is), never as a plain string. An OFF-SCALE '
  + 'amount (`/7`) emits nothing on ANY colour: write it as an arbitrary value (`/[0.07]`), '
  + 'or use a step on the scale.'

/**
 * Alpha suffixes that are dead ON PURPOSE. Nothing qualifies yet: an unpaintable
 * class has no upside, so anything landing here needs a reason why the element is
 * meant to have no colour rule at all.
 */
const ALLOWED = new Map<string, string>()

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

/** Whether `css` has a rule for `cls` — `::placeholder` ones included. */
const emits = (css: string, cls: string) =>
  [' ', ',', '::'].some((end) => css.includes(`${selectorFor(cls)}${end}`))

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
  // STOCK PALETTE COLOURS ARE SCANNED TOO, and they were the blind spot. The
  // config tokens are where the bare-`var()` trap lives, but they are not the
  // only way to author a class that compiles to nothing: an OFF-SCALE modifier
  // emits no rule on ANY colour, stock ones included. Tailwind's opacity scale
  // has no `8`, so `bg-emerald-500/8` and `bg-sky-500/8` are silently empty —
  // and 38 of those shipped, including both pills of `ViewScopeBadge`, which
  // draws the data source and provider on Explorer cards, list rows, the hero,
  // the recent strip and the preview drawer. Five surfaces, no fill, for as
  // long as it has been in the tree. Nothing here caught it, because the
  // alternation below only ever contained config tokens.
  //
  // Valid palette alphas (`/10`, `/[0.08]`) still compile, so widening the scan
  // reports nothing extra — it only stops an off-scale one from hiding.
  const PALETTE = String.raw`(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|\d{3})`
  // `<utility->` `<token>` `/<amount>`, where the amount is a scale step or an
  // arbitrary `[0.04]`. Anchored on a known colour so `w-1/2` and the `/item` in
  // `group-hover/item:` can never be mistaken for a colour.
  const usage = new RegExp(
    String.raw`(?<![-\w])((?:[a-z][a-z0-9]*-)*)(${tokens.join('|')}|${PALETTE})\/(\[[^\]\s]+\]|\d{1,3})(?![\w-])`,
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
    .filter((cls) => !emits(css, cls))
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

  it('the theme tokens answer a modifier with a colour that renders', async () => {
    const css = await compile([
      'bg-canvas-elevated/95', 'bg-canvas-elevated', 'border-glass-border/50', 'border-glass-border',
      'bg-ink-muted/10', 'text-ink-muted/60', 'text-ink-muted/0', 'placeholder-ink-muted/40',
      'bg-emerald-500/8',
    ])
    const rule = (cls: string) => {
      const at = css.indexOf(`${selectorFor(cls)} {`) >= 0
        ? css.indexOf(`${selectorFor(cls)} {`) : css.indexOf(`${selectorFor(cls)}::placeholder {`)
      return css.slice(at, css.indexOf('}', at)).replace(/\s+/g, ' ')
    }
    // A surface takes a real alpha; without a modifier the token is untouched.
    expect(rule('bg-canvas-elevated/95')).toContain('color-mix(in srgb, var(--nx-bg-elevated) calc(0.95 * 100%), transparent)')
    expect(rule('bg-canvas-elevated')).toContain('background-color: var(--nx-bg-elevated)')
    expect(rule('bg-ink-muted/10')).toContain('color-mix(in srgb, var(--nx-text-muted) calc(0.1 * 100%), transparent)')
    // A modified glass border is a divider in the theme's own ink, never the
    // white glass that vanished on light surfaces.
    expect(rule('border-glass-border/50')).toContain('rgb(var(--nx-divider-rgb) / calc(0.5 * 0.16))')
    expect(rule('border-glass-border')).toContain('border-color: var(--nx-border-glass)')
    // Text never fades below its token, except /0, which means hidden.
    expect(rule('text-ink-muted/60')).toContain('color: var(--nx-text-muted)')
    expect(rule('placeholder-ink-muted/40')).toContain('color: var(--nx-text-muted)')
    expect(rule('text-ink-muted/0')).toContain('color: transparent')
    // The in-between steps the app is written with are on the scale.
    expect(rule('bg-emerald-500/8')).toContain('rgb(16 185 129 / 0.08)')
  })

  it('the sweep reaches the config tokens and the app source', () => {
    expect(tokens).toContain('canvas-elevated')
    expect(tokens).toContain('glass-border')
    expect(tokens).toContain('ink-muted')
    expect(tokens).toContain('accent-lineage')
    // A token family added to the config later is picked up here for free.
    expect(occurrences.size).toBeGreaterThan(100)
  })

  it('no alpha suffix in the app compiles to nothing', () => {
    expect(
      dead.map((cls) => `${cls} — ${occurrences.get(cls)!.slice(0, 3).join(', ')}`),
      `These classes compile to NO CSS, so the element gets no colour at all. ${HOW_TO_FIX}`,
    ).toEqual([])
  })
})
