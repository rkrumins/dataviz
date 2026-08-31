/**
 * `backdrop-filter` CREATES A STACKING CONTEXT. Any `z-index` under a blurred
 * ancestor is therefore only competing with its SIBLINGS: it cannot climb out
 * of that ancestor, whatever number it carries.
 *
 * `ContextViewHeader.tsx` carries `backdrop-blur-xl`, and the canvas columns
 * below it are `relative z-30` and later in the DOM. Three floating surfaces
 * opened inside that header and were painted over by the canvas:
 *
 *   - the Property Manager coachmark (7e413751) — a permanent 15px strip
 *     peeking under the button, unreadable and undismissable;
 *   - a canvas panel;
 *   - the branch switcher menu (01d4a5b2) — it opened every single time,
 *     at `z-50`, and simply could not be seen.
 *
 * The house fix is the portal pattern `DisplayMenu` and `ImportExportMenu`
 * already use in that same header: render to `document.body`, `position:
 * fixed`, anchored to the trigger's live rect.
 *
 * This is a SOURCE-LEVEL sweep, and it has to be. jsdom composes no layers,
 * has no `backdrop-filter`, and reports a `z-index` the element does not
 * actually get to use — a rendering test here would pass on the broken code.
 * The rule is checked ACROSS FILES, because none of the three bugs had the
 * blur and the floating node in the same file: the blur was on the header and
 * the menu was inside a component the header rendered.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lineAt, stripComments, tagStream, walkInside } from '@/test/jsxSourceScan'

const SRC = resolve(__dirname, '..')

const HOW_TO_FIX =
  'A floating surface under a `backdrop-blur` ancestor cannot escape that ancestor: '
  + 'backdrop-filter makes a stacking context, so its z-index only ranks it among its '
  + 'siblings and anything painted later covers it. Portal it to document.body with '
  + '`position: fixed`, anchored to the trigger rect — the pattern DisplayMenu and '
  + 'ImportExportMenu use, and the one BranchSwitcher was converted to in 01d4a5b2. '
  + '(Dropping the blur from the ancestor works too, when it buys nothing.)'

/**
 * Floating surfaces still rendered inside a blurred ancestor, each with the
 * reason it has not been converted. These are NOT absolutions — every one is
 * the same shape as the three bugs above and is expected to be portalled or to
 * lose the blur. The list is pinned exactly so a new one cannot join quietly.
 */
const KNOWN = new Map<string, string>([
  [
    'components/canvas/create/HierarchyBuilderPanel.tsx',
    'Three popovers — parent picker, type chip, edge picker — declared beside the '
      + 'builder aside and rendered inside its `glass-panel`. Same conversion as '
      + 'BuildPanel below, three times over.',
  ],
  [
    'components/canvas/create/buildmode/BuildPanel.tsx',
    'The build-mode aside is a `glass-panel`; BuildOutline and BuildGrid both reach '
      + 'TypePickerPopover (`absolute top-full z-30`) inside it. The aside is also '
      + '`overflow-hidden`, so today those pickers are clipped by their own parent '
      + 'before the stacking context matters — the blur is the second wall, not the '
      + 'first. Both walls come down with the same anchored-portal conversion.',
  ],
  [
    'components/canvas/search/SearchMapPanel.tsx',
    'ScopeModePicker (`absolute top-full z-40 w-80`) opens inside the panel\'s '
      + '`backdrop-blur-2xl` surface. It is 80 units wide against a narrow header, so '
      + 'it is the next one likely to be reported as "the menu opens under something".',
  ],
  [
    'components/canvas/search/builder/GroupRow.tsx',
    'Two of them under the row card\'s `backdrop-blur-sm`: the leaf picker declared '
      + 'in this file, and UnifiedPicker, which CAN portal but only when its caller '
      + 'passes `portal` — GroupRow does not, so it takes the inline branch. That one '
      + 'is a prop away from being fixed, which makes it the cheapest of the four.',
  ],
  [
    'components/canvas/trace/TraceBottomDock.tsx',
    'The dock carries `backdrop-blur-2xl`, and its edge-filter popover sits four '
      + 'components down inside it. The dock already publishes its own height band to '
      + 'the canvas, so this one wants looking at together with that layout, not on its own.',
  ],
])

/** Anything that puts a backdrop-filter on the element. `glass-panel` is this app's CSS class for one. */
const isBlurred = (tag: string) => /backdrop-blur|backdrop-filter|glass-panel/.test(tag)

/**
 * A positioned surface that has to win against something. Deliberately broad —
 * `absolute` plus a z-index — minus the three shapes that provably do NOT need
 * to escape their ancestor, because each of them only ever ranks against its own
 * siblings, which a stacking context still lets it do:
 *
 *   - `inset-0`: a wash that covers its own parent and nothing else;
 *   - `pointer-events-none`: paint, not a surface;
 *   - `role="separator"`: a drag handle pinned to its parent's edge.
 *
 * Narrowing it further to "looks like a menu" was tried and let a real one
 * through: `GroupRow`'s leaf picker is `absolute z-40 mt-1.5 left-0` — a dropdown
 * that hangs off its trigger without ever saying `top-full`.
 */
const isFloating = (tag: string) =>
  /(?<![\w-])absolute(?![\w-])/.test(tag)
  && /(?<![\w-])z-(?:\d+|\[)/.test(tag)
  && !/(?<![\w-])inset-0(?![\w-])/.test(tag)
  && !/pointer-events-none/.test(tag)
  && !/role=\{?['"]separator['"]/.test(tag)

/** Character ranges covered by a `createPortal(…)` call — a node in one is already out. */
function portalRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const m of src.matchAll(/createPortal\(/g)) {
    let depth = 0
    for (let j = m.index! + m[0].length - 1; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') {
        depth--
        if (depth === 0) {
          ranges.push([m.index!, j])
          break
        }
      }
    }
  }
  return ranges
}

interface Violation {
  host: string
  line: number
  /** The chain of components from the blurred ancestor down to the floating node. */
  via: string[]
  tag: string
}

/**
 * Every floating surface that ends up under a blurred ancestor, however many
 * components down. The containment is transitive — a stacking context traps the
 * whole subtree — and so is this: `BuildPanel` (glass-panel) renders `BuildGrid`
 * renders `BuildGridRow` renders `ParentPickerPopover`, and it is the popover
 * that cannot be seen.
 *
 * `files` is rel-path -> source, so the same analysis runs over the real tree and
 * over the historical fixtures the teeth tests feed it.
 */
function analyze(files: Map<string, string>): Violation[] {
  const stripped = new Map([...files].map(([rel, src]) => [rel, stripComments(src)]))

  // Top-level component declarations, each owning the source up to the next one.
  // Column 0 only: an indented `const Icon = config.icon` is not a component, and
  // treating it as one hands the next floating tag to the wrong owner.
  interface Comp { file: string; name: string; start: number; end: number }
  const compsOf = new Map<string, Comp[]>()
  for (const [rel, src] of stripped) {
    const decls = [...src.matchAll(/(?:^|\n)(?:export\s+)?(?:function|const)\s+([A-Z]\w*)\s*[(<=]/g)]
      .map((m) => ({ name: m[1], at: m.index! }))
    compsOf.set(
      rel,
      decls.map((d, i) => ({ file: rel, name: d.name, start: d.at, end: decls[i + 1]?.at ?? src.length })),
    )
  }

  const importsOf = new Map<string, Map<string, string>>()
  for (const [rel, src] of stripped) {
    const named = new Map<string, string>()
    for (const m of src.matchAll(/import\s+(?:\{([^}]*)\}|([A-Z]\w*))\s+from\s+'([^']+)'/g)) {
      if (m[2]) named.set(m[2], m[3])
      for (const one of (m[1] ?? '').split(',')) {
        const name = one.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) named.set(name, m[3])
      }
    }
    importsOf.set(rel, named)
  }

  const fileOf = (from: string, spec: string): string | undefined => {
    const base = spec.startsWith('@/')
      ? spec.slice(2)
      : spec.startsWith('.')
        ? relative(SRC, resolve(SRC, dirname(from), spec))
        : null
    if (base === null) return undefined
    return [`${base}.tsx`, `${base}/index.tsx`].find((c) => stripped.has(c))
  }

  /** `<Name>` used in `from` -> the component it renders, as `file#Name`. */
  const resolveTagIn = (from: string, name: string): string | undefined => {
    const spec = importsOf.get(from)!.get(name)
    const file = spec ? fileOf(from, spec) : from
    if (!file) return undefined
    return compsOf.get(file)?.some((c) => c.name === name) ? `${file}#${name}` : undefined
  }

  // Per component: the floating node it renders itself, and the components it renders.
  const ownFloat = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  for (const [rel, src] of stripped) {
    const portals = portalRanges(src)
    const outside = (pos: number) => !portals.some(([a, b]) => pos > a && pos < b)
    const stream = tagStream(src)
    for (const comp of compsOf.get(rel)!) {
      const key = `${rel}#${comp.name}`
      const mine = stream.filter((t) => !t.closing && t.pos >= comp.start && t.pos < comp.end && outside(t.pos))
      const float = mine.find((t) => isFloating(t.text))
      if (float) ownFloat.set(key, float.text)
      const kids = new Set<string>()
      for (const t of mine) {
        if (!/^[A-Z]/.test(t.name)) continue
        const child = resolveTagIn(rel, t.name)
        if (child && child !== key) kids.add(child)
      }
      childrenOf.set(key, [...kids])
    }
  }

  /** The shortest chain from a component down to a floating node, or null. */
  const chainCache = new Map<string, string[] | null>()
  const chainFrom = (key: string, seen = new Set<string>()): string[] | null => {
    if (chainCache.has(key)) return chainCache.get(key)!
    if (seen.has(key)) return null
    seen.add(key)
    let answer: string[] | null = ownFloat.has(key) ? [key] : null
    if (!answer) {
      for (const kid of childrenOf.get(key) ?? []) {
        const rest = chainFrom(kid, seen)
        if (rest && (!answer || rest.length + 1 < answer.length)) answer = [key, ...rest]
      }
    }
    seen.delete(key)
    if (seen.size === 0) chainCache.set(key, answer)
    return answer
  }

  const violations: Violation[] = []
  for (const [rel, src] of stripped) {
    const portals = portalRanges(src)
    walkInside(src, isBlurred, (t) => {
      if (portals.some(([a, b]) => t.pos > a && t.pos < b)) return
      const line = lineAt(src, t.pos)
      if (isFloating(t.text)) {
        violations.push({ host: rel, line, via: [], tag: t.text.replace(/\s+/g, ' ').slice(0, 110) })
        return
      }
      if (!/^[A-Z]/.test(t.name)) return
      const key = resolveTagIn(rel, t.name)
      const chain = key ? chainFrom(key) : null
      if (chain) {
        violations.push({
          host: rel,
          line,
          via: chain,
          tag: ownFloat.get(chain[chain.length - 1])!.replace(/\s+/g, ' ').slice(0, 110),
        })
      }
    })
  }
  return violations
}

function appFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(path)
      } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
        out.set(relative(SRC, path), readFileSync(path, 'utf8'))
      }
    }
  }
  walk(dir)
  return out
}

const app = appFiles(SRC)
const found = analyze(app)

describe('a floating surface under a backdrop-blur ancestor must portal out', () => {
  it('reproduces 01d4a5b2: the branch menu rendered inline in the blurred header', () => {
    // The two files verbatim in shape: the blur on the header, the `absolute …
    // z-50` menu one component away. This is the case a same-file scan misses.
    const fixture = new Map([
      [
        'components/canvas/context-view/ContextViewHeader.tsx',
        `import { BranchSwitcher } from '@/features/versioning/components/BranchSwitcher'
         export function ContextViewHeader() {
           return (
             <div className="flex-shrink-0 bg-canvas-elevated backdrop-blur-xl border-b px-6 py-3 relative">
               <BranchSwitcher workspaceId={id} dataSourceId={ds} />
             </div>
           )
         }`,
      ],
      [
        'features/versioning/components/BranchSwitcher.tsx',
        `export function BranchSwitcher() {
           return (
             <div className="relative">
               <button onClick={() => setOpen(v => !v)}>Version</button>
               {open && (
                 <div className="absolute left-0 top-full mt-1.5 w-[21rem] z-50 rounded-xl bg-canvas-elevated shadow-glass-lg">
                   menu
                 </div>
               )}
             </div>
           )
         }`,
      ],
    ])
    const hits = analyze(fixture)
    expect(hits.map((v) => `${v.host} -> ${v.via.join(' -> ')}`)).toEqual([
      'components/canvas/context-view/ContextViewHeader.tsx -> features/versioning/components/BranchSwitcher.tsx#BranchSwitcher',
    ])
  })

  it('the fix clears it: the same menu, portalled and fixed, is not reported', () => {
    // The other direction. A guard that still fired after 01d4a5b2 would be
    // noise, and noise is how a guard gets deleted.
    const fixture = new Map([
      [
        'components/canvas/context-view/ContextViewHeader.tsx',
        `import { BranchSwitcher } from '@/features/versioning/components/BranchSwitcher'
         export function ContextViewHeader() {
           return (
             <div className="flex-shrink-0 bg-canvas-elevated backdrop-blur-xl px-6 py-3 relative">
               <BranchSwitcher workspaceId={id} dataSourceId={ds} />
             </div>
           )
         }`,
      ],
      [
        'features/versioning/components/BranchSwitcher.tsx',
        `import { createPortal } from 'react-dom'
         export function BranchSwitcher() {
           return (
             <div className="relative">
               <button ref={setTriggerEl}>Version</button>
               {open && anchor && createPortal(
                 <div role="dialog" style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 1000 }}
                      className="rounded-xl bg-canvas-elevated shadow-glass-lg">menu</div>,
                 document.body,
               )}
             </div>
           )
         }`,
      ],
    ])
    expect(analyze(fixture)).toEqual([])
  })

  it('a wash that only covers its own parent is not a violation', () => {
    // `absolute inset-0 z-30` never needs to escape, so the stacking context
    // costs it nothing. Flagging it would bury the real ones.
    const fixture = new Map([
      [
        'x.tsx',
        `export function X() {
           return (
             <div className="relative backdrop-blur-sm">
               <div className="absolute inset-0 z-30 flex items-center justify-center bg-canvas/60">spinner</div>
             </div>
           )
         }`,
      ],
    ])
    expect(analyze(fixture)).toEqual([])
  })

  it('the sweep actually walks the app', () => {
    expect(app.size).toBeGreaterThan(400)
    expect([...app.keys()]).toContain('components/canvas/context-view/ContextViewHeader.tsx')
    expect([...app.keys()]).toContain('features/versioning/components/BranchSwitcher.tsx')
  })

  it('no floating surface renders under a blurred ancestor outside the known list', () => {
    const offenders = found
      .filter((v) => !KNOWN.has(v.host))
      .map((v) => `${v.host}:${v.line}${v.via.length ? ` via ${v.via.join(' -> ')}` : ''} — ${v.tag}`)
    expect(offenders, HOW_TO_FIX).toEqual([])
  })

  it('the known list is exactly the files that still do it', () => {
    // Pinned both ways: a file that gets fixed has to leave the list, or the
    // list stops describing the app and starts hiding the next one.
    expect([...new Set(found.map((v) => v.host))].sort()).toEqual([...KNOWN.keys()].sort())
  })
})
