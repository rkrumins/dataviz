/**
 * What a connection held for review is copied as — the enable job's own rule
 * (`bootstrap_worker._resolved`), so the review shows the result before anyone continues.
 */
import { describe, expect, it } from 'vitest'
import { CONFIDENCE_PICK, type BootstrapReviewVersion } from '@/services/versioningApiService'
import { propertyNames, resolveCopies } from '../reviewResolution'

const v = (seq: number, properties: Record<string, unknown>, confidence: number | null = null): BootstrapReviewVersion =>
  ({ seq, count: 1, ids: [`e${seq}`], confidence, properties })

describe('resolveCopies', () => {
  const versions = [v(1, { at: 'mon', who: 'ana' }), v(2, { at: 'tue', n: 2 }, 0.9), v(3, { x: 1 }, 0.1)]

  it('keeps the first version, or the one chosen', () => {
    expect(resolveCopies(versions, null, { rule: 'keep_first', excludeProperties: [] }).properties)
      .toEqual({ at: 'mon', who: 'ana' })
    const kept = resolveCopies(versions, { rule: 'keep', keep: 2 }, { rule: 'keep_first', excludeProperties: [] })
    expect(kept.properties).toEqual({ at: 'tue', n: 2 })
    expect(kept.confidence).toBe(0.9)
  })

  it('merges every property, the first holder winning unless another is picked', () => {
    const merged = resolveCopies(versions, null, { rule: 'merge', excludeProperties: [] })
    expect(merged.properties).toEqual({ at: 'mon', who: 'ana', n: 2, x: 1 })
    expect(merged.from).toEqual({ at: 1, who: 1, n: 2, x: 3, [CONFIDENCE_PICK]: 2 })
    expect(merged.confidence).toBe(0.9)
    const picked = resolveCopies(versions,
      { rule: 'merge', values: { at: 2, [CONFIDENCE_PICK]: 3 }, excludeProperties: ['who'] },
      { rule: 'keep_first', excludeProperties: ['x'] })
    expect(picked.properties).toEqual({ at: 'tue', n: 2 })
    expect(picked.confidence).toBe(0.1)
  })

  it('leaves versions out of a merge, but never all of them', () => {
    expect(resolveCopies(versions, { rule: 'merge', excludeCopies: [1] }, null).properties)
      .toEqual({ at: 'tue', n: 2, x: 1 })
    expect(resolveCopies(versions, { rule: 'merge', excludeCopies: [1, 2, 3] }, null).properties)
      .toEqual({ at: 'mon', who: 'ana' })
  })

  it('lists every property in the order they first appear', () => {
    expect(propertyNames(versions)).toEqual(['at', 'who', 'n', 'x'])
  })
})
