import { describe, it, expect } from 'vitest'
import { draftStatus, ownerName, ownerInitials, BRANCH_VOCAB } from '../branchVocab'

describe('draftStatus', () => {
  it('flags updates-available when the base trails the published head', () => {
    const s = draftStatus(3, 5)
    expect(s.behind).toBe(true)
    expect(s.tone).toBe('attention')
    expect(s.label).toBe(BRANCH_VOCAB.updatesAvailable)
  })

  it('reports up to date when caught up', () => {
    const s = draftStatus(5, 5)
    expect(s.behind).toBe(false)
    expect(s.tone).toBe('ok')
    expect(s.label).toBe(BRANCH_VOCAB.upToDate)
  })

  it('treats a null/undefined base as 0', () => {
    expect(draftStatus(null, 2).behind).toBe(true)
    expect(draftStatus(undefined, 0).behind).toBe(false)
  })
})

describe('ownerName / ownerInitials', () => {
  it('humanises an email handle', () => {
    expect(ownerName('ana.lee@acme.com')).toBe('Ana lee')
    expect(ownerInitials('ana.lee@acme.com')).toBe('AL')
  })

  it('handles a bare handle', () => {
    expect(ownerName('sam')).toBe('Sam')
    expect(ownerInitials('sam')).toBe('SA')
  })

  it('falls back gracefully when empty', () => {
    expect(ownerName(null)).toBe('Unknown')
    expect(ownerInitials(undefined)).toBe('?')
  })
})
