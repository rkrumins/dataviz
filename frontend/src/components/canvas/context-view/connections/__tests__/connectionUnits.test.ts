/**
 * The unit vocabulary, and the pin that keeps the surfaces on it.
 *
 * The five surfaces that count connections answer five different questions
 * and must keep doing so — making them equal would destroy information a
 * reader needs. What they must NOT do is answer them in the same anonymous
 * word. So: three units, defined in one module, and every surface names the
 * one it shows.
 *
 * The naming is pinned at the source level (the `noBackdropFilterInScrollers`
 * idiom) because four of these numbers live inside a 5k-line canvas that
 * cannot be mounted in jsdom — and because the rule being pinned is "the
 * words come from the shared module", which is a property of the source.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_COUNT_UNITS,
  formatUnitCount,
  unitMeaning,
  unitNoun,
  type ConnectionCountUnit,
} from '../connectionUnits'

/** Source with comments removed — prose may say anything; code may not. */
const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** Every surface that shows a connection count, and where it imports from. */
const SURFACES: Array<[string, string]> = [
  ['../ConnectionsPanel.tsx', './connectionUnits'],
  ['../../FlatTreeItem.tsx', './connections/connectionUnits'],
  ['../../CanvasStatusChips.tsx', './connections/connectionUnits'],
  ['../../LayerColumn.tsx', './connections/connectionUnits'],
  ['../../../../panels/LineageNeighbors.tsx', '@/components/canvas/context-view/connections/connectionUnits'],
]

describe('the unit vocabulary', () => {
  it('has exactly three units', () => {
    expect(Object.keys(CONNECTION_COUNT_UNITS).sort()).toEqual([
      'lines',
      'neighbors',
      'relationships',
    ])
  })

  it('agrees with the number in front of it', () => {
    expect(unitNoun(1, 'relationships')).toBe('underlying relationship')
    expect(unitNoun(0, 'relationships')).toBe('underlying relationships')
    expect(unitNoun(2, 'relationships')).toBe('underlying relationships')
    expect(unitNoun(1, 'lines')).toBe('line')
    expect(unitNoun(4300, 'lines')).toBe('lines')
    expect(unitNoun(1, 'neighbors')).toBe('connected entity')
    expect(unitNoun(3, 'neighbors')).toBe('connected entities')
  })

  it('formats the number with its unit, thousands separated', () => {
    expect(formatUnitCount(4300, 'relationships')).toBe('4,300 underlying relationships')
    expect(formatUnitCount(1, 'lines')).toBe('1 line')
  })

  it('every unit can say precisely what it counts', () => {
    for (const unit of Object.keys(CONNECTION_COUNT_UNITS) as ConnectionCountUnit[]) {
      const sentence = unitMeaning(unit)
      expect(sentence.length).toBeGreaterThan(40)
      expect(sentence.endsWith('.')).toBe(true)
    }
  })
})

describe('every surface names the unit it shows', () => {
  it.each(SURFACES)('%s takes its words from the shared module', (file, specifier) => {
    expect(read(file)).toContain(`from '${specifier}'`)
  })

  it.each(SURFACES)('%s hardcodes no unit word of its own', (file) => {
    const src = read(file).replace(/^import[\s\S]*?from '[^']*'$/gm, '')
    expect(src).not.toMatch(/underlying relationship/i)
    expect(src).not.toMatch(/connected entit/i)
  })

  it('the per-row hairlines no longer call lines "connections"', () => {
    const src = read('../../FlatTreeItem.tsx')
    expect(src).not.toMatch(/incoming connection\$\{/)
    expect(src).not.toMatch(/outgoing connection\$\{/)
  })

  it('the two edge-density chips agree on one word for what they count', () => {
    const src = read('../../CanvasStatusChips.tsx')
    expect(src).not.toMatch(/flows/)
    expect(src).not.toMatch(/entity has \{focusTotal/)
  })

  it('the column periphery counts lines, and says so', () => {
    const src = read('../../LayerColumn.tsx')
    expect(src).not.toMatch(/connection\{periphery/)
  })

  it('the drawer lineage header counts connected entities, and says so', () => {
    const src = read('../../../../panels/LineageNeighbors.tsx')
    expect(src).not.toMatch(/\{directTotal\} connection/)
  })
})
