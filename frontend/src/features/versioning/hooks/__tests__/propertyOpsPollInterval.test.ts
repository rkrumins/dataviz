/**
 * A draft's property operations are asked about every 2 s while one is under way — its progress
 * bar and the completion watcher read them — and not at all once none is: a list of finished
 * operations never changes by itself.
 */
import { describe, expect, it } from 'vitest'

import type { PropertyOpJob } from '@/services/versioningApiService'

import { propertyOpsPollInterval } from '../useVersioning'

const op = (status: PropertyOpJob['status']) => ({ status }) as PropertyOpJob
const list = (...statuses: PropertyOpJob['status'][]) =>
  ({ ops: statuses.map(op), draftChanges: 0, maxDraftChanges: 100_000 })

describe('propertyOpsPollInterval', () => {
  it('polls while an operation is queued or running', () => {
    expect(propertyOpsPollInterval(list('completed', 'pending'))).toBe(2000)
    expect(propertyOpsPollInterval(list('running'))).toBe(2000)
  })

  it('stops once every operation has finished, and before the list has loaded', () => {
    expect(propertyOpsPollInterval(list('completed', 'failed', 'cancelled'))).toBe(false)
    expect(propertyOpsPollInterval(list())).toBe(false)
    expect(propertyOpsPollInterval(undefined)).toBe(false)
  })
})
