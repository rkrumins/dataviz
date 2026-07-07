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
  it('humanises an email handle when no userNames map resolves it', () => {
    expect(ownerName('ana.lee@acme.com')).toBe('Ana lee')
    expect(ownerInitials('ana.lee@acme.com')).toBe('AL')
  })

  it('prefers the resolved userNames map entry over the raw id', () => {
    const userNames = { usr_abc123: 'Ana Lee' }
    expect(ownerName('usr_abc123', userNames)).toBe('Ana Lee')
    expect(ownerInitials('usr_abc123', userNames)).toBe('AL')
  })

  it('falls back to the email-munge for an actor unresolved by the map', () => {
    const userNames = { usr_other: 'Someone Else' }
    expect(ownerName('ana.lee@acme.com', userNames)).toBe('Ana lee')
    expect(ownerInitials('ana.lee@acme.com', userNames)).toBe('AL')
  })

  it('never surfaces a raw usr_* id — falls back to Unknown when unresolved', () => {
    expect(ownerName('usr_cd8b62ea79b6')).toBe('Unknown')
    expect(ownerName('usr_cd8b62ea79b6', {})).toBe('Unknown')
    expect(ownerInitials('usr_cd8b62ea79b6')).toBe('?')
  })

  it('falls back gracefully when empty', () => {
    expect(ownerName(null)).toBe('Unknown')
    expect(ownerInitials(undefined)).toBe('?')
  })
})
