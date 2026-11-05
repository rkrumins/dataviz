/**
 * Minimal, the one-line density: 26px rows and 30px roots, the tightest of
 * the four. The row's floor and the virtualizer's estimate are one number.
 */
import { describe, expect, it } from 'vitest'

import { densityRowHeights, densityRowTokens } from '../density'

describe('Minimal density', () => {
  it('is one line: 26px rows, 30px roots', () => {
    expect(densityRowTokens('minimal', false)).toEqual({
      rootHeight: 30,
      childHeight: 26,
      paddingClass: 'py-0.5',
      textClass: 'text-[12px]',
      iconSize: 'w-3.5 h-3.5',
      iconContainerSize: 'w-4 h-4',
    })
    expect(densityRowTokens('minimal', true).rootHeight).toBe(30)
    expect(densityRowHeights('minimal')).toMatchObject({ root: 30, child: 26 })
  })

  it('is the tightest of the four', () => {
    const minimal = densityRowHeights('minimal')
    for (const other of ['compact', 'comfortable', 'spacious'] as const) {
      expect(minimal.child).toBeLessThan(densityRowHeights(other).child)
      expect(minimal.root).toBeLessThan(densityRowHeights(other).root)
    }
  })
})
