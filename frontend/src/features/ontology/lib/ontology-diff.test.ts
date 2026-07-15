import { describe, expect, it } from 'vitest'
import { diffRecords } from './ontology-diff'

describe('diffRecords', () => {
  const server = {
    Server: { name: 'Server', visual: { color: '#111111' } },
    Rack: { name: 'Rack' },
  }

  it('classifies added, modified, and removed with changed fields', () => {
    const working = {
      Server: { name: 'Server', visual: { color: '#222222' } },
      Pod: { name: 'Pod' },
    }
    const diff = diffRecords(server, working)
    expect(diff.added.map(d => d.id)).toEqual(['Pod'])
    expect(diff.removed.map(d => d.id)).toEqual(['Rack'])
    expect(diff.modified.map(d => d.id)).toEqual(['Server'])
    expect(diff.modified[0].changedFields).toEqual(['visual'])
  })

  it('reports nothing for identical maps regardless of key order', () => {
    const working = { Rack: { name: 'Rack' }, Server: { name: 'Server', visual: { color: '#111111' } } }
    const diff = diffRecords(server, working)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.modified).toEqual([])
  })
})
