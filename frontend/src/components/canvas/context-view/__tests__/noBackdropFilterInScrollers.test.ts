/**
 * "White strips" on canvas rows and legend rows were backdrop-filter
 * ghosts: Chromium leaves a mis-placed blurred tile — a hard-edged,
 * translucent band — when a backdrop-filter surface sits inside a scroll
 * container (sticky column headers, floating pills), animates its size
 * (the edge legend opening), or is toggled by React state that can miss a
 * mouseleave (the row's hover action overlay). The fundamental fix is to
 * not have the mechanism: surfaces that live inside the columns' scrollers
 * or animate get opacity instead of blur, and hover overlays are owned by
 * CSS (`group-hover`), which the browser can never leave stuck.
 *
 * This pins the rule at the source level so it cannot creep back in.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lineAt, stripComments, tagStream, walkInside } from '@/test/jsxSourceScan'

const here = resolve(__dirname, '..')
/** Source with comments removed — prose may name the classes; code may not. */
const read = (rel: string) =>
  readFileSync(resolve(here, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const BLUR = /backdrop-blur|backdrop-filter|glass-panel/g

describe('bottom chrome and scroller surfaces carry no backdrop-filter', () => {
  it('LayerColumn: sticky header and floating pills use opacity, not blur', () => {
    expect(read('LayerColumn.tsx').match(BLUR) ?? []).toEqual([])
  })

  it('LoadMoreItem: no blur', () => {
    expect(read('LoadMoreItem.tsx').match(BLUR) ?? []).toEqual([])
  })

  it('EdgeLegend: an opaque elevated panel, not a glass panel', () => {
    expect(read('../EdgeLegend.tsx').match(BLUR) ?? []).toEqual([])
  })

  it('ConnectionsPanel: an opaque elevated panel, not a glass panel', () => {
    expect(read('connections/ConnectionsPanel.tsx').match(BLUR) ?? []).toEqual([])
  })

  it('FlatTreeItem: only the card body keeps its subtle blur; the hover overlay has none', () => {
    const src = read('FlatTreeItem.tsx')
    const hits = src.match(BLUR) ?? []
    // The card body's `backdrop-blur-sm` softens cross-column edges behind
    // the node; it is its own static box (no sticky, no animation, no
    // toggling), which is not the ghosting shape. Exactly one, on that line.
    expect(hits).toEqual(['backdrop-blur'])
    expect(src).toMatch(/bg-canvas-elevated\/10 backdrop-blur-sm/)
  })

  it('FlatTreeItem: the hover action overlay is CSS-owned, never React-state-owned', () => {
    const src = read('FlatTreeItem.tsx')
    expect(src).not.toMatch(/opacity:\s*isHovered\s*\?\s*1\s*:\s*0/)
    expect(src).toMatch(/group-hover\/item:opacity-100/)
  })
})

/**
 * The same rule, swept across the whole app rather than file by file.
 *
 * `backdrop-filter` inside a scroll container re-samples everything beneath it
 * on EVERY scroll frame, for the whole length of the list. 965d3643 took it off
 * seven sticky headers — Activity, the view timeline, the Explorer list, three
 * drawers and the branding footer — and found that not one of them was even
 * getting the effect it paid for: every one had an alpha suffix on a
 * CSS-variable token, so the surface had no background and the blur was the
 * only thing making it legible.
 *
 * A `sticky` element is inside a scroller by definition, which is why it is
 * checked on its own without needing to find the scroller.
 *
 * NOT the same rule as chrome that floats OVER a scroller. 75208053 reverted
 * exactly that conflation: the canvas header, its menus and the property drawer
 * are transparent ON PURPOSE and the blur is what makes them frosted glass.
 * They are not inside the thing they blur, so they cost nothing per frame.
 */
const APP = resolve(__dirname, '../../../..')

const HOW_TO_FIX =
  'A backdrop-filter inside a scroller re-rasterises on every scroll frame. A sticky '
  + 'header only has to hide the rows sliding under it, which an OPAQUE token does for '
  + 'free — `bg-canvas-elevated`, not `bg-canvas-elevated/95 backdrop-blur-sm` (which '
  + 'paints nothing at all, see 965d3643). For a panel that must stay see-through, use '
  + 'opacity, or move it out of the scroller.'

/** Deliberate, with the reason. Keep it short; loosening the rule blinds every other file. */
const ALLOWED = new Map<string, string>([
  [
    'components/canvas/context-view/FlatTreeItem.tsx',
    "The card body's `backdrop-blur-sm` softens cross-column edges behind the node. "
      + 'Pinned by the FlatTreeItem case above, which also holds it to exactly one '
      + 'occurrence and to a static box — no sticky, no size animation, no state toggle.',
  ],
])

/**
 * Still doing it, with the reason each has not been converted. NOT absolutions:
 * every one is the shape 965d3643 removed from seven other headers.
 *
 * None is fixed here on purpose. The fix is not "delete the blur" — these
 * surfaces use an alpha suffix on a CSS-variable token, so deleting the blur
 * leaves them fully transparent and the rows show straight through. It is
 * "choose an opaque background", which is a look, and 75208053 is what happens
 * when that choice is made from a test file instead of from the screen.
 *
 * Pinned by COUNT, not by file: keyed on the file alone, a second sticky header
 * added to any file already here would never be seen, and a file half converted
 * would stay "known" for ever.
 */
const KNOWN = new Map<string, { count: number; why: string }>([
  [
    'components/admin/AdminFeatures/ConfirmTurnOff.tsx',
    { count: 1, why: 'A sticky action bar at the bottom of the dialog body scroller.' },
  ],
  [
    'components/admin/AdminFeatures/FeatureList.tsx',
    { count: 1, why: 'The sticky group label inside the feature list.' },
  ],
  [
    'components/admin/RegistryJobHistory.tsx',
    { count: 2, why: 'Two `glass-panel` cards — the empty state and the table wrapper — rendered '
      + 'inside the page scroller, so both blur it as it moves.' },
  ],
  [
    'components/canvas/trace/TraceDockDrilldownList.tsx',
    { count: 1, why: 'The drilldown list\'s sticky header, over the longest scroller in the canvas.' },
  ],
  [
    'components/dashboard/TemplateGrid.tsx',
    { count: 1, why: 'The category chips sit in a horizontally scrolling strip and each carries its own blur.' },
  ],
  [
    'components/explorer/ExplorerRecentStrip.tsx',
    { count: 1, why: 'Every card in the recents strip is a `glass-panel` inside that strip\'s own scroller.' },
  ],
  [
    'components/panels/LineageNeighbors.tsx',
    { count: 1, why: 'A sticky header inside the neighbours list.' },
  ],
])

function appFiles(dir: string): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') out.push(...appFiles(path))
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push({ rel: relative(APP, path), src: stripComments(readFileSync(path, 'utf8')) })
    }
  }
  return out
}

const HAS_BLUR = /backdrop-blur|backdrop-filter|glass-panel/
const STICKY = /(?<![\w-])sticky(?![\w-])/
/** A real scroller. `overflow-hidden` clips; it does not scroll. */
const SCROLLS = /(?<![\w-])overflow(?:-[xy])?-(?:auto|scroll)(?![\w-])/

function blurInScrollers(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = []
  for (const { rel, src } of files) {
    if (ALLOWED.has(rel)) continue
    for (const t of tagStream(src)) {
      if (t.closing) continue
      if (STICKY.test(t.text) && HAS_BLUR.test(t.text)) {
        out.push(`${rel}:${lineAt(src, t.pos)} — sticky + blur — ${squash(t.text)}`)
      }
    }
    walkInside(src, (tag) => SCROLLS.test(tag), (t, ancestor) => {
      if (!HAS_BLUR.test(t.text) || STICKY.test(t.text)) return
      out.push(`${rel}:${lineAt(src, t.pos)} — blur inside a scroller opened at line ${lineAt(src, ancestor.pos)} — ${squash(t.text)}`)
    })
  }
  return out.sort()
}

const squash = (tag: string) => tag.replace(/\s+/g, ' ').slice(0, 100)

const app = appFiles(APP)

describe('app-wide: no backdrop-filter inside a scroll container', () => {
  it('reproduces 965d3643: a sticky list header that blurs the list under it', () => {
    // ActivityFeedList's header, verbatim as it stood before the fix.
    const fixture = [{
      rel: 'components/views/ActivityFeedList.tsx',
      src: `export function ActivityFeedList() {
              return (
                <div className="overflow-y-auto">
                  <h3 className="sticky top-0 z-10 bg-canvas-elevated/95 backdrop-blur-sm py-2 text-[10px] font-bold">
                    Today
                  </h3>
                </div>
              )
            }`,
    }]
    expect(blurInScrollers(fixture)).toEqual([
      'components/views/ActivityFeedList.tsx:4 — sticky + blur — <h3 className="sticky top-0 z-10 bg-canvas-elevated/95 backdrop-blur-sm py-2 text-[10px] font-bold">',
    ])
  })

  it('the fix clears it, and chrome that floats OVER a scroller is left alone', () => {
    const fixture = [
      {
        rel: 'fixed.tsx',
        src: `export function Fixed() {
                return (
                  <div className="overflow-y-auto">
                    <h3 className="sticky top-0 z-10 bg-canvas-elevated py-2">Today</h3>
                  </div>
                )
              }`,
      },
      {
        // 75208053's shape: the blurred surface is a SIBLING of the scroller,
        // floating over it. Nothing re-rasterises as the list moves.
        rel: 'over.tsx',
        src: `export function Over() {
                return (
                  <div className="relative">
                    <div className="bg-canvas-elevated/95 backdrop-blur-xl">chrome</div>
                    <div className="overflow-y-auto">rows</div>
                  </div>
                )
              }`,
      },
    ]
    expect(blurInScrollers(fixture)).toEqual([])
  })

  it('the sweep actually walks the app', () => {
    expect(app.length).toBeGreaterThan(400)
    expect(app.map((f) => f.rel)).toContain('components/views/ActivityFeedList.tsx')
  })

  it('nothing new blurs a scroller it is sitting inside', () => {
    const found = blurInScrollers(app)
    expect(found.filter((v) => !KNOWN.has(v.split(':')[0])), HOW_TO_FIX).toEqual([])
  })

  it('the known list is exactly the files that still do it, and how many each has', () => {
    // Pinned both ways, and by count: a file that gets fixed has to leave the
    // list, and a file that gets WORSE has to fail — otherwise the list stops
    // describing the app and starts hiding the next one inside it.
    const counts: Record<string, number> = {}
    for (const v of blurInScrollers(app)) {
      const file = v.split(':')[0]
      counts[file] = (counts[file] ?? 0) + 1
    }
    expect(counts, HOW_TO_FIX).toEqual(
      Object.fromEntries([...KNOWN].map(([file, k]) => [file, k.count])),
    )
  })
})
