/**
 * PrMeta — derivePrTitle's fallback title generation. Pins the "Publish draft by usr_…"
 * regression: an untitled PR's derived title must show the resolved actor name, never
 * the raw usr_* id.
 */
import { describe, it, expect } from 'vitest'
import { derivePrTitle } from '../components/PrMeta'
import type { PullRequest } from '@/services/versioningApiService'

const basePr = (over: Partial<PullRequest>): PullRequest => ({
  prId: 'pr_1',
  graphId: 'g1',
  sourceBranchId: 'br_1',
  targetGraphId: 'g1',
  targetBranch: 'main',
  status: 'open',
  actor: 'usr_abc123',
  createdAt: '2026-06-10T00:00:00Z',
  updatedAt: '2026-06-10T00:00:00Z',
  ...over,
})

describe('derivePrTitle', () => {
  it('uses the author-supplied title when present', () => {
    expect(derivePrTitle(basePr({ title: 'Q3 pricing update' }))).toBe('Q3 pricing update')
  })

  it('derives a draft MR title with the resolved actor name, not the raw id', () => {
    const pr = basePr({ userNames: { usr_abc123: 'Ana Lee' } })
    expect(derivePrTitle(pr)).toBe('Publish draft by Ana Lee')
  })

  it('derives a fork PR title with the resolved actor name', () => {
    const pr = basePr({ targetGraphId: 'g2', userNames: { usr_abc123: 'Ana Lee' } })
    expect(derivePrTitle(pr)).toBe('Incoming changes from Ana Lee')
  })

  it('falls back to Unknown for an unresolved actor — never the raw id', () => {
    const pr = basePr({})
    expect(derivePrTitle(pr)).toBe('Publish draft by Unknown')
  })
})
