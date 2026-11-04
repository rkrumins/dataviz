/**
 * A draft rewritten behind the canvas — an import, others' saves taken in — bumps `draftEpoch`,
 * and CanvasRouter remounts the canvas on it: the canvas component's key is the epoch, so its
 * expansion, auto-load and assignment latches start over against what the draft holds now. The
 * layer-assignment status lives in a store the remount leaves alone, so the same epoch resets it:
 * left at 'success', the fresh canvas would never place the entities the rewrite brought in.
 *
 * Pinned at the source level, as canvasRouterClearsMessageHistory is: rendering CanvasRouter
 * pulls in the whole canvas for a guarantee a regex states exactly.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(resolve(__dirname, '../CanvasRouter.tsx'), 'utf8')

describe('CanvasRouter remounts the canvas when the draft is rewritten', () => {
  it('keys the canvas component by the draft epoch', () => {
    expect(src).toMatch(/const draftEpoch = useBranchStore\(\(s\) => s\.draftEpoch\)/)
    expect(src).toMatch(/<CanvasComponent key=\{draftEpoch\} \/>/)
  })

  it('resets the layer-assignment status on the same epoch', () => {
    const effect = src.match(/useEffect\(\(\) => \{[^}]*resetAssignmentStatus\(\)[^}]*\}, \[draftEpoch\]\)/)
    expect(effect, 'the draft-epoch effect must reset the assignment status').not.toBeNull()
  })
})
