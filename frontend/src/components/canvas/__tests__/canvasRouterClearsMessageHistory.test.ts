/**
 * The toast message log is scoped to the OPEN VIEW, and this is the only
 * thing that makes that true: CanvasRouter's view/branch-change effect clears
 * it alongside the trace state. Without the call the log is an app singleton —
 * messages from view A would be listed as view B's, which is exactly the lie
 * the trace clear next to it exists to prevent.
 *
 * Pinned at the source level: the effect is inside a component whose render
 * pulls in the whole canvas (hydration, providers, React Flow), so a regex on
 * the source buys the guarantee for none of that cost.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(resolve(__dirname, '../CanvasRouter.tsx'), 'utf8')

describe('CanvasRouter scopes the toast message history to the active view', () => {
  it('clears the history in the same effect that clears the trace', () => {
    // The effect body between the trace clear and its [activeViewId, currentBranchId] deps.
    const effect = src.match(
      /useEffect\(\(\) => \{[\s\S]*?clearTrace\(\)[\s\S]*?\}, \[activeViewId, currentBranchId\]\)/,
    )
    expect(effect, 'the view/branch-change effect must still exist').not.toBeNull()
    expect(effect![0]).toMatch(/clearHistory\(\)/)
  })

  it('reaches the history through the toast store', () => {
    expect(src).toMatch(/useToastStore/)
  })
})
