import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { expectTestsRan, countTest } from '../canary'

describe('canary', () => {
  beforeEach(() => { countTest() })
  it('runs', () => { expect(1).toBe(1) })
  afterAll(() => { expectTestsRan(1) })
})
