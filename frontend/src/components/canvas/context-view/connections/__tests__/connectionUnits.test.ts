/**
 * The vocabulary, and the pin that keeps the surfaces on it.
 *
 * Two levels, and they are not the same question:
 *
 *   KIND — what sort of relationship is this? Every surface listed below is
 *   fed by a source that excludes containment by construction, so every one
 *   of them shows FLOWS. A structural relationship is never a flow; a
 *   surface that could show one would have to say "relationship" instead,
 *   and none of these can.
 *
 *   UNIT — how are the flows counted? Three answers, all correct and all
 *   different: underlying flows, lines, connected entities. The five
 *   surfaces answer five different questions and must keep doing so —
 *   making them equal would destroy information a reader needs. What they
 *   must NOT do is answer them in the same anonymous word.
 *
 * "Connection" was that anonymous word: direction-free, kind-free and
 * unit-free, and it is retired from this lane's copy.
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

/** Every surface that shows a flow count, and where it imports from. */
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
      'flows',
      'lines',
      'neighbors',
    ])
  })

  it('agrees with the number in front of it', () => {
    expect(unitNoun(1, 'flows')).toBe('underlying flow')
    expect(unitNoun(0, 'flows')).toBe('underlying flows')
    expect(unitNoun(2, 'flows')).toBe('underlying flows')
    expect(unitNoun(1, 'lines')).toBe('line')
    expect(unitNoun(4300, 'lines')).toBe('lines')
    expect(unitNoun(1, 'neighbors')).toBe('connected entity')
    expect(unitNoun(3, 'neighbors')).toBe('connected entities')
  })

  it('formats the number with its unit, thousands separated', () => {
    expect(formatUnitCount(4300, 'flows')).toBe('4,300 underlying flows')
    expect(formatUnitCount(1, 'lines')).toBe('1 line')
  })

  it('every unit can say precisely what it counts', () => {
    for (const unit of Object.keys(CONNECTION_COUNT_UNITS) as ConnectionCountUnit[]) {
      const sentence = unitMeaning(unit)
      expect(sentence.length).toBeGreaterThan(40)
      expect(sentence.endsWith('.')).toBe(true)
    }
  })

  it('every unit counts flows, and says so — none of them says "connection"', () => {
    for (const unit of Object.keys(CONNECTION_COUNT_UNITS) as ConnectionCountUnit[]) {
      expect(unitMeaning(unit).toLowerCase()).toContain('flow')
      expect(unitMeaning(unit).toLowerCase()).not.toContain('connection')
    }
  })
})

describe('every surface names the unit it shows', () => {
  it.each(SURFACES)('%s takes its words from the shared module', (file, specifier) => {
    expect(read(file)).toContain(`from '${specifier}'`)
  })

  it.each(SURFACES)('%s hardcodes no unit word of its own', (file) => {
    const src = read(file).replace(/^import[\s\S]*?from '[^']*'$/gm, '')
    expect(src).not.toMatch(/underlying flow/i)
    expect(src).not.toMatch(/connected entit/i)
  })

  it('the per-row hairlines no longer call lines "connections"', () => {
    const src = read('../../FlatTreeItem.tsx')
    expect(src).not.toMatch(/incoming connection\$\{/)
    expect(src).not.toMatch(/outgoing connection\$\{/)
  })

  it('the two edge-density chips agree on one word for what they count', () => {
    const src = read('../../CanvasStatusChips.tsx')
    expect(src).not.toMatch(/flows drawn/)
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

/**
 * The kind word. Each entry is a surface, the phrasings it must no longer
 * print, and the ones that replaced them. Every count on every one of these
 * surfaces comes from a lineage-only source — `useEdgeProjection` drops
 * `isContainmentEdge` in all three of its sections, `lib/lineage-neighbors`
 * excludes containment by contract, `useExternalDegrees` asks the server for
 * lineage types only — so every one of them may, and must, say flow.
 */
const KIND: Array<[string, RegExp[], string[]]> = [
  [
    '../ConnectionsPanel.tsx',
    [/No connections in view/, /to see connections\./, />Connections</, /underlying-relationship/],
    ['No flows in view', 'to see flows.', '>Flows<', 'underlying-flow'],
  ],
  [
    '../../CanvasStatusChips.tsx',
    [
      /connections not on canvas/,
      /connections outside this view/,
      /Large connection fan/,
      /Adaptive edge density/,
      /downstream connection/,
    ],
    [
      'flows not on canvas',
      'flows outside this view',
      'Large flow fan',
      'Adaptive flow density',
      "unitNoun(selectedExternal!.in + selectedExternal!.out, 'flows')",
    ],
  ],
  [
    '../../LayerColumn.tsx',
    [/Every connection of/, /Connection density/],
    ['Every flow of', 'Flow density'],
  ],
  [
    '../../../../panels/LineageNeighbors.tsx',
    [
      /No matching connections/,
      /No connections in this direction/,
      /one connection, not two/,
      /connections per direction/,
    ],
    [
      'No matching flows',
      'No flows in this direction',
      'one flow, not two',
      'flows per direction',
    ],
  ],
]

describe('a lineage-only surface calls a relationship a flow', () => {
  it.each(KIND)('%s no longer says "connection" where it means a flow', (file, retired) => {
    const src = read(file)
    for (const phrase of retired) expect(src).not.toMatch(phrase)
  })

  it.each(KIND)('%s says flow instead', (file, _retired, replacements) => {
    const src = read(file)
    for (const phrase of replacements) expect(src).toContain(phrase)
  })
})
