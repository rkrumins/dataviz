/**
 * The recurring app-wide freeze in this repo: a portaled surface that covers the
 * viewport, rendered INSIDE <AnimatePresence> with an `exit`. When that exit is
 * interrupted — StrictMode's double invoke, a rapid toggle, a parent re-render
 * mid-flight — framer-motion leaves the node in the body: invisible at opacity
 * 0, pointer-events on, covering the viewport. Every click in the app dies and
 * only a reload brings it back. It has shipped three times.
 *
 * The house shape, stated in AutomationModal.tsx and proven by Backdrop.tsx:
 * the scrim is a plain CSS <Backdrop> and a SIBLING; the full-viewport wrapper
 * is `pointer-events-none` and lives OUTSIDE any presence tree; only the panel
 * inside is interactive and animated.
 *
 * This pins it at the source level for EVERY portal in the app, because no test
 * can reproduce an interrupted exit: jsdom has no compositor and framer's exit
 * completes synchronously there.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')

/**
 * Files that keep a viewport-covering node interactive on purpose. Keep this
 * list short, and give the reason — loosening the patterns below instead would
 * blind the guard for every other file.
 */
const ALLOWED = new Map<string, string>([
  [
    'features/reviews/components/ConflictResolver.tsx',
    'Its `fixed inset-0` node is a click-to-cancel catcher that WRAPS the '
      + 'presence tree rather than sitting inside it, so framer cannot strand it; '
      + 'the scrim itself is already a <Backdrop> sibling. Converting it means '
      + 'moving that click onto the Backdrop.',
  ],
])

const HOW_TO_FIX =
  'A portaled node that covers the viewport must never be able to outlive an '
  + 'interrupted exit as a click-blocker. Give it `pointer-events-none`, move it '
  + 'OUTSIDE the <AnimatePresence>, and mark only the panel inside '
  + '`pointer-events-auto` — the scrim becomes a <Backdrop> SIBLING of the wrapper '
  + '(see AutomationModal.tsx and the LineageLens conversion in 1ddeab89).'

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') out.push(...tsxFiles(path))
    } else if (entry.name.endsWith('.tsx')) {
      out.push(path)
    }
  }
  return out
}

/**
 * Every JSX opening tag in a source file. `{…}` expressions are kept whole, so
 * an arrow function's `=>` inside a prop cannot end a tag early and hide the
 * className that follows it.
 */
function openingTags(src: string): string[] {
  const tags: string[] = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<' || !/[A-Za-z]/.test(src[i + 1] ?? '')) continue
    let depth = 0
    let quote: string | null = null
    for (let j = i + 1; j < src.length; j++) {
      const c = src[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c
      } else if (c === '{') {
        depth++
      } else if (c === '}') {
        depth--
      } else if (depth === 0 && (c === '>' || c === '<')) {
        if (c === '>') tags.push(src.slice(i, j + 1))
        i = j - 1
        break
      }
    }
  }
  return tags
}

/** A wrapper that covers the whole viewport. It is chrome, so it must be inert. */
function coversWholeViewport(tag: string): boolean {
  if (!/\bfixed\b/.test(tag)) return false
  return /\binset-0\b/.test(tag) || /\binset-x-0\b/.test(tag) || /\binset-y-0\b/.test(tag)
}

/** The shapes that cover the viewport — or a full-height edge of it. */
function coversViewport(tag: string): boolean {
  if (!/\bfixed\b/.test(tag)) return false
  if (coversWholeViewport(tag)) return true
  // An edge drawer is a full-height click-blocker over the band it occupies,
  // which is how the last one presented: rows under the right edge went dead
  // while the rest of the canvas kept working.
  return /\b(?:right-0|left-0)\b/.test(tag) && /\btop-0\b/.test(tag) && /\b(?:h-full|h-screen)\b/.test(tag)
}

/**
 * Inert means inert in EVERY state. A wrapper that switches to
 * `pointer-events-auto` while open is interactive in exactly the state an
 * interrupted exit strands it in, so a conditional class does not count.
 */
function isInert(tag: string): boolean {
  return tag.includes('pointer-events-none') && !tag.includes('pointer-events-auto')
}

const sources = tsxFiles(SRC).map((file) => ({ rel: relative(SRC, file), src: readFileSync(file, 'utf8') }))
const portals = sources.filter(({ src }) => src.includes('createPortal'))
/**
 * Everything that animates presence, portaled or not. A drawer does not need a
 * portal to strand — `AdminPermissions` renders a `fixed right-0 top-0 h-full`
 * aside straight into the page, and framer can leave that behind just the same.
 */
const animating = sources.filter(({ src }) => src.includes('<AnimatePresence') && /\bexit=/.test(src))

describe('portaled overlays cannot strand a click-blocker', () => {
  // A guard that scans nothing passes forever. Pin that the walk still finds
  // the app's portals, and the ones this rule exists for.
  it('the sweep actually reaches the app portals', () => {
    expect(portals.length).toBeGreaterThan(20)
    const scanned = portals.map((p) => p.rel)
    for (const known of [
      'components/canvas/context-view/LineageLens.tsx',
      'components/help/HelpPanel.tsx',
      'components/insights/DataSourceProfileDrawer.tsx',
      'features/reviews/components/PrDetailDrawer.tsx',
      'features/tour/TourOverlay.tsx',
      'features/versioning/components/ViewVersioningPanel.tsx',
    ]) {
      expect(scanned).toContain(known)
    }
  })

  it('every viewport-covering node in an animating surface is inert', () => {
    const offenders: string[] = []
    for (const { rel, src } of animating) {
      if (ALLOWED.has(rel)) continue
      for (const tag of openingTags(src)) {
        if (!coversViewport(tag) || isInert(tag)) continue
        // A whole-viewport node is chrome: it must be inert, always, because
        // anything it covers is everything. An edge drawer is content and may
        // take clicks — what it may not do is carry the `exit` that strands it
        // as an interactive band down the side of the page.
        if (!coversWholeViewport(tag) && !/\bexit=/.test(tag)) continue
        offenders.push(`${rel} — ${tag.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    expect(offenders, HOW_TO_FIX).toEqual([])
  })

  it('the converted overlays take their scrim from the shared <Backdrop>', () => {
    // The other half of the house shape: a scrim rendered as a CHILD of the
    // wrapper never receives the click meant to close it, and it is only as
    // durable as the node it is nested in. These six were converted off that
    // shape — keep them on the shared, CSS-transitioned <Backdrop> sibling.
    for (const rel of [
      'components/canvas/context-view/LineageLens.tsx',
      'components/help/HelpPanel.tsx',
      'components/insights/DataSourceProfileDrawer.tsx',
      'features/reviews/components/PrDetailDrawer.tsx',
      'features/tour/TourOverlay.tsx',
      'features/versioning/components/ViewVersioningPanel.tsx',
    ]) {
      const src = portals.find((p) => p.rel === rel)?.src ?? ''
      expect(src, `${rel}: ${HOW_TO_FIX}`).toMatch(/import \{ Backdrop \} from '@\/components\/ui\/Backdrop'/)
      expect(src, `${rel}: ${HOW_TO_FIX}`).toMatch(/<Backdrop[\s>]/)
    }
  })

  it('no portal hands its outermost node straight to <AnimatePresence>', () => {
    // Presence wrapped around an UNCONDITIONAL child is the other half of the
    // bug: the exit never runs on unmount, so the animation is a lie, and the
    // node it holds is the one that strands when it does run.
    for (const { rel, src } of portals) {
      expect(src, `${rel}: ${HOW_TO_FIX}`).not.toMatch(/return createPortal\(\s*<AnimatePresence[\s>]/)
      // …and the same thing written through a hoisted constant, which is the
      // idiom HelpPanel uses.
      expect(src, `${rel}: ${HOW_TO_FIX}`).not.toMatch(/=\s*\(\s*<AnimatePresence[\s>]/)
    }
  })
})
