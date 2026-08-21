/**
 * `lensDensity` — how much of the Lens picture is folded (Part H,
 * 2026-08-21): 'overview' lands a band's bundle hosts as closed cards,
 * 'grouped' (the default, the user's ruling) as frames showing their
 * strongest rows, 'all' draws every card. A PREFERENCE, not view state:
 * some readers want to see it all, some want to start at the high level,
 * and the choice follows the reader from lens to lens. Separate from
 * `lensCondenseSteps` (chain folding), which stays OFF by default under
 * the earlier ruling "show the full end-to-end flow".
 */
import { describe, it, expect } from 'vitest'
import { usePreferencesStore } from '../preferences'

describe('preferences — lensDensity', () => {
  it("defaults to 'grouped' and is settable", () => {
    expect(usePreferencesStore.getState().lensDensity).toBe('grouped')
    usePreferencesStore.getState().setLensDensity('overview')
    expect(usePreferencesStore.getState().lensDensity).toBe('overview')
    usePreferencesStore.getState().setLensDensity('all')
    expect(usePreferencesStore.getState().lensDensity).toBe('all')
    usePreferencesStore.getState().setLensDensity('grouped')
  })

  it('an older persisted state gains the default without touching anything else', () => {
    const migrate = usePreferencesStore.persist.getOptions().migrate!
    const migrated = migrate({ lensCondenseSteps: true, lensFrameChildren: 'all' }, 2) as Record<string, unknown>
    expect(migrated.lensDensity).toBe('grouped')
    expect(migrated.lensCondenseSteps).toBe(true)       // chain folding is its own choice, untouched
    expect(migrated.lensFrameChildren).toBe('all')
    const current = migrate({ lensDensity: 'all' }, 3) as Record<string, unknown>
    expect(current.lensDensity).toBe('all')             // an explicit choice survives
  })
})
