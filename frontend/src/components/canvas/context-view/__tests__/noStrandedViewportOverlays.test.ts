/**
 * The recurring app-wide freeze in this repo: a portaled `fixed inset-0`
 * surface rendered INSIDE <AnimatePresence> with an `exit`. When that exit is
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
 * This pins it at the source level for the canvas overlays that reach the whole
 * viewport, because no test can reproduce an interrupted exit.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8')

/** The portal's opening tag, with its className, wherever it starts. */
function viewportWrappers(src: string): string[] {
  return src.match(/<[a-zA-Z.]+[^>]*className="[^"]*fixed inset-0[^"]*"[^>]*>/g) ?? []
}

describe('portaled viewport overlays cannot strand a click-blocker', () => {
  it('LineageLens: every full-viewport wrapper is inert, and none animates out', () => {
    const src = read('LineageLens.tsx')
    const wrappers = viewportWrappers(src)
    expect(wrappers.length).toBeGreaterThan(0)
    for (const w of wrappers) {
      expect(w).toContain('pointer-events-none')
      expect(w).not.toContain('exit')
      expect(w.startsWith('<motion.')).toBe(false)
    }
  })

  it('LineageLens: the scrim is the shared Backdrop, never a nested motion child', () => {
    const src = read('LineageLens.tsx')
    expect(src).toMatch(/import \{ Backdrop \} from '@\/components\/ui\/Backdrop'/)
    expect(src).toMatch(/<Backdrop\s+open/)
    // The portal's own return must not open with <AnimatePresence>: presence
    // there wraps an unconditional child, which is the shape that strands.
    expect(src).not.toMatch(/return createPortal\(\s*\n?\s*<AnimatePresence>/)
  })
})
