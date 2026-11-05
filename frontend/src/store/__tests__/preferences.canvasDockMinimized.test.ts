/**
 * `canvasDockMinimized` — the canvas dock (Data loads + Flows) follows the
 * view until the reader chooses: minimized in the Business view, open in the
 * Technical one. A choice, once made, is kept in both.
 */
import { describe, expect, it } from 'vitest'

import { usePreferencesStore } from '../preferences'

describe('preferences — canvasDockMinimized', () => {
  it('is unset by default, so it follows the view', () => {
    expect(usePreferencesStore.getState().canvasDockMinimized).toBeNull()
  })

  it('resets the false every browser stored as the old default', () => {
    const migrate = usePreferencesStore.persist.getOptions().migrate!
    const migrated = migrate({ canvasDockMinimized: false, canvasFoldLayers: true }, 10) as Record<string, unknown>
    expect(migrated.canvasDockMinimized).toBeNull()
    expect(migrated.canvasFoldLayers).toBe(true)          // nothing else moves
  })

  it('keeps a minimized dock, which was a choice', () => {
    const migrate = usePreferencesStore.persist.getOptions().migrate!
    expect((migrate({ canvasDockMinimized: true }, 10) as Record<string, unknown>).canvasDockMinimized).toBe(true)
  })

  it('keeps a choice made since', () => {
    const migrate = usePreferencesStore.persist.getOptions().migrate!
    expect((migrate({ canvasDockMinimized: false }, 11) as Record<string, unknown>).canvasDockMinimized).toBe(false)
  })
})
