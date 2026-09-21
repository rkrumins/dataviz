/**
 * `canvasFoldLayers` — folding distant layers is opt-in (2026-09-21, the
 * user's ruling: folding loses detail, so a view opens with every layer at
 * full width and a reader folds on purpose).
 */
import { describe, expect, it } from 'vitest'

import { usePreferencesStore } from '../preferences'

describe('preferences — canvasFoldLayers', () => {
  it('is off by default', () => {
    expect(usePreferencesStore.getState().canvasFoldLayers).toBe(false)
  })

  it('resets the ON a pre-release build stored as its default', () => {
    const migrate = usePreferencesStore.persist.getOptions().migrate!
    const migrated = migrate({ canvasFoldLayers: true, lensDensity: 'all' }, 7) as Record<string, unknown>
    expect(migrated.canvasFoldLayers).toBe(false)
    expect(migrated.lensDensity).toBe('all')             // nothing else moves
  })

  it('keeps a choice made since', () => {
    const migrate = usePreferencesStore.persist.getOptions().migrate!
    expect((migrate({ canvasFoldLayers: true }, 8) as Record<string, unknown>).canvasFoldLayers).toBe(true)
  })
})
