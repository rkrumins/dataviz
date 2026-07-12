import { describe, it, expect } from 'vitest'
import { layoutTypeIcon, resolveViewIcon } from '../viewUtils'

describe('resolveViewIcon', () => {
  it('prefers a deliberately chosen icon over the type icon', () => {
    expect(resolveViewIcon({ icon: 'GitBranch', viewType: 'graph' })).toBe('GitBranch')
  })

  it("treats the 'Layout' default as no choice and falls back to the type icon", () => {
    expect(resolveViewIcon({ icon: 'Layout', viewType: 'graph' })).toBe('Network')
    expect(resolveViewIcon({ icon: 'Layout', viewType: 'reference' })).toBe('Layers')
  })

  it('falls back to the type icon when no icon is stored', () => {
    expect(resolveViewIcon({ viewType: 'hierarchy' })).toBe('GitBranch')
    expect(resolveViewIcon({ icon: null, viewType: 'timeline' })).toBe('Clock')
    expect(resolveViewIcon({ icon: '', viewType: 'graph' })).toBe('Network')
  })

  it("resolves unknown/absent view types to the 'Layout' fallback", () => {
    expect(resolveViewIcon({})).toBe('Layout')
    expect(resolveViewIcon({ viewType: 'not-a-type' })).toBe('Layout')
    expect(resolveViewIcon({ icon: 'Layout', viewType: null })).toBe('Layout')
  })

  it('matches layoutTypeIcon for every default-icon view', () => {
    for (const t of ['graph', 'hierarchy', 'tree', 'reference', 'layered-lineage', 'list', 'grid', 'timeline']) {
      expect(resolveViewIcon({ icon: 'Layout', viewType: t })).toBe(layoutTypeIcon(t))
    }
  })
})
