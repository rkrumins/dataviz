/**
 * What the reader remembers between visits: pages read, the path being
 * followed in each reader, and recent searches — in this browser only.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useReadingStore } from './readingStore'

const store = () => useReadingStore.getState()

beforeEach(() => {
  localStorage.clear()
  useReadingStore.setState({ read: {}, last: {}, activePath: {}, recentSearches: [] })
})

describe('reading progress', () => {
  it('keeps the first time a page was read', () => {
    store().markRead('docs', 'setup')
    const first = store().read['docs:setup']
    store().markRead('docs', 'setup')
    expect(store().read['docs:setup']).toBe(first)
  })

  it('follows a path in each reader independently', () => {
    store().followPath('docs', 'operator')
    store().followPath('guide', 'viewer')
    store().leavePath('docs')
    expect(store().activePath).toEqual({ guide: 'viewer' })
  })

  it('forgets only the pages it is asked to', () => {
    store().markRead('docs', 'setup')
    store().markRead('docs', 'contributing')
    store().markRead('guide', 'setup-like')
    store().forget('docs', ['setup'])
    expect(Object.keys(store().read).sort()).toEqual(['docs:contributing', 'guide:setup-like'])
  })

  it('remembers the page last opened in each reader', () => {
    store().visit('docs', 'rbac')
    store().visit('guide', 'quick-start')
    store().visit('docs', 'sso')
    expect(store().last.docs?.slug).toBe('sso')
    expect(store().last.guide?.slug).toBe('quick-start')
  })

  it('survives a reload', () => {
    store().markRead('guide', 'welcome')
    store().followPath('guide', 'builder')
    const saved = JSON.parse(localStorage.getItem('nexus-docs-reading') ?? '{}')
    expect(saved.state.read).toHaveProperty('guide:welcome')
    expect(saved.state.activePath).toEqual({ guide: 'builder' })
  })
})

describe('recent searches', () => {
  it('lists the newest first, once each, five at most', () => {
    for (const q of ['sso', 'rbac', 'kubectl', 'SSO ', 'helm', 'backup', 'trace']) store().rememberSearch(q)
    expect(store().recentSearches).toEqual(['trace', 'backup', 'helm', 'SSO', 'kubectl'])
  })

  it('ignores an empty search and forgets one on request', () => {
    store().rememberSearch('   ')
    store().rememberSearch('lineage')
    store().forgetSearch('lineage')
    expect(store().recentSearches).toEqual([])
  })
})
